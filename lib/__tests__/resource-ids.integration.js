import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import express from 'express'
import request from 'supertest'
import {prisma} from '../../db/prisma.js'
import {createRoutes} from '../routes.js'
import {requireDisposableDatabase} from '../util/test-helpers/disposable-database.js'

const integration = process.env.DROPT_INTEGRATION_TESTS === '1' ? test.serial : test.skip

test.before(() => {
  if (process.env.DROPT_INTEGRATION_TESTS === '1') requireDisposableDatabase()
})
test.after.always(async () => {
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

function routeApp(user) {
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => {
    if (user) req.auth = {type: 'USER_SESSION'}
    req.user = user
    req.userRole = user?.role
    next()
  })
  app.use(createRoutes())
  app.use((error, req, res, next) => {
    res.status(error.status ?? 500).send({message: error.message})
  })
  return app
}

function uuidV5() {
  const uuid = randomUUID()
  return `${uuid.slice(0, 14)}5${uuid.slice(15)}`
}

integration('les fiches des points importés v5 et existants v4 fonctionnent par ID et par nom', async t => {
  const admin = await prisma.user.create({data: {role: 'ADMIN'}})
  const app = routeApp(admin)
  await Promise.all([randomUUID(), uuidV5()].map(async id => {
    const point = await prisma.pointPrelevement.create({data: {
      id, name: `UUID regression ${id}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'
    }})
    await Promise.all([point.id, point.name].map(async reference => {
      const response = await request(app).get(`/points-prelevement/${encodeURIComponent(reference)}`)
      t.is(response.status, 200, JSON.stringify(response.body))
      t.is(response.body.id, id)
    }))
    const batch = await request(app).post('/points-prelevement/batch').send({ids: [id]})
    t.is(batch.status, 200, JSON.stringify(batch.body))
    t.deepEqual(batch.body.map(point => point.id), [id])
  }))
  await Promise.all([uuidV5(), randomUUID(), 'point-inexistant'].map(async reference => {
    t.is((await request(app).get(`/points-prelevement/${reference}`)).status, 404)
  }))
  t.is((await request(app).post('/points-prelevement/batch').send({ids: ['invalid']})).status, 400)
})

integration('un UUID v5 ne contourne ni les permissions de fiche ni le filtrage batch', async t => {
  const user = await prisma.user.create({data: {id: uuidV5(), role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
  const point = await prisma.pointPrelevement.create({data: {
    id: uuidV5(), name: `UUID permissions ${randomUUID()}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'
  }})
  const path = `/points-prelevement/${point.id}`
  t.is((await request(routeApp()).get(path)).status, 401)
  t.is((await request(routeApp(user)).get(path)).status, 403)
  const batch = await request(routeApp(user)).post('/points-prelevement/batch').send({ids: [point.id]})
  t.is(batch.status, 200)
  t.deepEqual(batch.body, [])

  const usage = await prisma.sandreWaterUse.findFirst({where: {kind: 'USAGE'}})
  await prisma.declarantPointPrelevement.create({data: {
    id: uuidV5(), pointPrelevementId: point.id, declarantUserId: user.id,
    usageId: usage.id, status: 'EN_ACTIVITE'
  }})
  const ownPoint = await request(routeApp(user)).get(path)
  t.is(ownPoint.status, 200, JSON.stringify(ownPoint.body))
  t.is(ownPoint.body.id, point.id)
  await Promise.all([
    `/aggregated-series/options?pointIds=${point.id}`,
    `/aggregated-series?pointIds=${point.id}&metricTypeCode=volume&startDate=2026-01-01&endDate=2026-01-02`,
    `/aggregated-series/options?preleveurId=${user.id}`
  ].map(async endpoint => {
    const series = await request(routeApp(user)).get(endpoint)
    t.is(series.status, 200, JSON.stringify(series.body))
  }))
})
