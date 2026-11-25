import {randomUUID} from 'node:crypto'
import process from 'node:process'
import test from 'ava'
import express from 'express'
import request from 'supertest'
import {prisma} from '../../../db/prisma.js'
import {createRoutes} from '../../routes.js'
import {ZONE_AGENT_MANAGEMENT_PERMISSIONS} from '../../constants/zone-permissions.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'

const integration = process.env.METER_INTEGRATION_TESTS === '1' ? test.serial : test.skip
const read = 'zone.dashboard.read'
const zoneIds = []
const users = []

test.before(() => {
  if (process.env.METER_INTEGRATION_TESTS === '1') requireDisposableDatabase()
})
test.after.always(async () => {
  try {
    if (users.length) await prisma.user.deleteMany({where: {id: {in: users}}})
    if (zoneIds.length) await prisma.zone.deleteMany({where: {id: {in: zoneIds}}})
  } finally {
    await prisma.$disconnect()
    await globalThis.pgPool?.end()
  }
})

async function zone() {
  const id = randomUUID()
  zoneIds.push(id)
  await prisma.$executeRaw`INSERT INTO "Zone"(id, code, type, name, coordinates, "updatedAt")
    VALUES (${id}::uuid, ${id}, 'DEPARTEMENT', 'Zone de test', ST_GeomFromText('MULTIPOLYGON EMPTY', 4326), now())`
  return id
}

async function user(role = 'INSTRUCTOR') {
  const record = await prisma.user.create({data: {role,
    ...(role === 'INSTRUCTOR' && {instructor: {create: {}}}),
    ...(role === 'DECLARANT' && {declarant: {create: {declarantRole: 'PRELEVEUR', preleveurType: 'IRRIGANT'}}})
  }, include: {declarant: true}})
  users.push(record.id)
  return record
}

function assign(agent, zoneId, permissions) {
  return prisma.instructorZone.create({data: {instructorUserId: agent.id, zoneId, startDate: new Date('2000-01-01'),
    permissions: {create: permissions.map(permission => ({permission}))}}})
}

function api(actor, impersonation = null) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.auth = {type: 'USER_SESSION', impersonation}
    req.user = actor
    req.userRole = actor.role
    next()
  })
  app.use(createRoutes())
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({message: error.message}))
  return request(app)
}

integration('la zone par défaut est facultative, unique et modifiable par PE ou les gestionnaires de la zone', async t => {
  const [a, b] = await Promise.all([zone(), zone()])
  const [admin, manager, agent] = await Promise.all([user('ADMIN'), user(), user()])
  const [first] = await Promise.all([assign(agent, a, [read]), assign(agent, b, [read]),
    assign(manager, a, [...ZONE_AGENT_MANAGEMENT_PERMISSIONS, 'zone.agent.detail.read']), assign(manager, b, ['zone.agent.update'])])
  const app = api(admin)
  const local = api(manager)
  const path = zoneId => `/zones/${zoneId}/instructeurs/${agent.id}/dashboard-default`
  const put = (client, zoneId, isDashboardDefault = true) => client.put(path(zoneId)).send({isDashboardDefault})
  const defaults = () => prisma.instructorZone.findMany({where: {instructorUserId: agent.id, isDashboardDefault: true}, select: {zoneId: true}})

  t.deepEqual(await defaults(), [])
  t.is((await put(local, b)).status, 403)
  t.is((await put(api(admin, {actorUserId: admin.id}), a)).status, 403)
  t.is((await app.put(path(a)).send({isDashboardDefault: 'true'})).status, 400)
  t.is((await put(local, a)).status, 200)
  const current = await local.get(path(a).replace('/dashboard-default', ''))
  t.is(current.status, 200)
  t.true(current.body.isDashboardDefault)
  t.true(current.body.habilitations.find(habilitation => habilitation.zoneId === a).isDashboardDefault)
  const global = await app.get(`/admin/agents/${agent.id}`)
  t.is(global.status, 200)
  t.true(global.body.habilitations.find(habilitation => habilitation.zoneId === a).isDashboardDefault)

  t.is((await put(app, b)).status, 200)
  t.is((await put(local, a, false)).status, 200)
  t.deepEqual(await defaults(), [{zoneId: b}])
  t.is((await put(app, b, false)).status, 200)
  t.deepEqual(await defaults(), [])
  const concurrent = await Promise.all([put(local, a), put(app, b)])
  t.deepEqual(concurrent.map(response => response.status), [200, 200])
  t.is((await defaults()).length, 1)

  await prisma.instructorZone.update({where: {id: first.id}, data: {endDate: new Date('2001-01-01')}})
  t.is((await put(local, a)).status, 409)
  await prisma.instructorZone.update({where: {id: first.id}, data: {endDate: null, startDate: new Date('2999-01-01')}})
  t.is((await put(local, a)).status, 409)
  t.is((await put(app, b)).status, 200)
  const changeAccess = await app.patch(path(b).replace('/dashboard-default', '')).send({
    instructorUserId: agent.id, startDate: '2000-01-01', permissions: ['zone.detail.read']
  })
  t.is(changeAccess.status, 200, JSON.stringify(changeAccess.body))
  t.deepEqual(await defaults(), [])
  t.is((await put(app, b)).status, 409)
})

integration('sans mandat territorial, le tableau de bord est vide et chaque déclarant conserve uniquement ses propres points d’activité', async t => {
  const [agent, declarant, stranger, otherZone] = await Promise.all([user(), user('DECLARANT'), user('DECLARANT'), zone()])
  const usage = await prisma.sandreWaterUse.findFirstOrThrow({where: {kind: 'USAGE'}})
  const point = await prisma.pointPrelevement.create({data: {name: 'Point sans territoire', flowType: 'PRELEVEMENT',
    waterBodyType: 'SUPERFICIELLE', declarants: {create: {declarantUserId: declarant.id, usageId: usage.id}}}})
  t.teardown(() => prisma.pointPrelevement.delete({where: {id: point.id}}))
  await Promise.all([agent, declarant, stranger].map(async actor => {
    const empty = await api(actor).get('/dashboard/territory').query({sections: 'context,metrics'})
    t.is(empty.status, 200, JSON.stringify(empty.body))
    t.deepEqual(empty.body.zones, [])
    t.is(empty.body.selectedZoneId, null)
    t.is(empty.body.metrics.totalPoints, 0)
    const denied = await api(actor).get('/dashboard/territory').query({zoneId: otherZone, sections: 'context'})
    t.is(denied.status, 403)
  }))
  const own = await api(declarant).get('/dashboard/map?scope=activity')
  t.is(own.status, 200)
  t.deepEqual(own.body.points.map(item => item.id), [point.id])
  const unrelated = await api(stranger).get('/dashboard/map?scope=activity')
  t.is(unrelated.status, 200)
  t.deepEqual(unrelated.body.points, [])
  t.is((await api(agent).get('/dashboard/map?scope=activity')).status, 403)
})
