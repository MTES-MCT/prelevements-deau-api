import test from 'ava'
import express from 'express'
import request from 'supertest'

import {createUserActivityHandler} from '../user-activity.js'
import {createRoutes} from '../../routes.js'
import {findAuditAction} from '../../audit/catalog.js'

const USER = {id: '11111111-1111-4111-8111-111111111111', role: 'DECLARANT'}
const ACTOR = {type: 'USER', id: '22222222-2222-4222-8222-222222222222', role: 'ADMIN'}

function createApp({auth, recordActivity, direct = false}) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.auth = auth
    req.user = auth?.user
    req.userRole = auth?.role
    next()
  })
  const handler = createUserActivityHandler({recordActivity})
  if (direct) {
    app.post('/users/me/activity', handler)
  } else {
    const routes = createRoutes({userActivityHandler: handler})
    app.use('/', routes)
    app.use('/api', routes)
  }

  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({message: error.message})
  })
  return app
}

test('le signal est accessible aux sessions humaines, avec ou sans préfixe API', async t => {
  const calls = []
  const app = createApp({
    auth: {type: 'USER_SESSION', user: USER, role: USER.role},
    recordActivity: async user => {
      calls.push(user)
      return {month: '2026-09'}
    }
  })
  const responses = await Promise.all([
    request(app).post('/users/me/activity'),
    request(app).post('/api/users/me/activity').send({})
  ])

  t.deepEqual(responses.map(response => response.status), [200, 200])
  t.true(responses.every(response => response.headers['cache-control'] === 'no-store'))
  t.deepEqual(responses[0].body, {month: '2026-09'})
  t.deepEqual(calls, [
    {userId: USER.id, role: 'DECLARANT'},
    {userId: USER.id, role: 'DECLARANT'}
  ])
})

test('l’impersonation ne compte que l’agent réel, jamais le préleveur consulté', async t => {
  const app = createApp({
    auth: {type: 'USER_SESSION', user: USER, actor: ACTOR, impersonation: {actor: ACTOR}},
    recordActivity: async user => {
      t.deepEqual(user, {userId: ACTOR.id, role: 'ADMIN'})
      return {month: '2026-09'}
    }
  })
  t.is((await request(app).post('/users/me/activity')).status, 200)
})

test('les sessions anonymes et les comptes de service ne peuvent pas déclencher la collecte', async t => {
  const auths = [
    undefined,
    {type: 'SERVICE_ACCOUNT_ACCESS', user: USER},
    {type: 'SERVICE_ACCOUNT_IMPERSONATION', user: USER, actor: {type: 'SERVICE_ACCOUNT'}}
  ]
  const responses = await Promise.all(auths.map(auth => request(createApp({
    auth,
    recordActivity: async () => t.fail('Aucune écriture ne doit être déclenchée.')
  })).post('/users/me/activity')))
  t.deepEqual(responses.map(response => response.status), [401, 403, 403])
})

test('le handler contrôle l’identité même sans son middleware et avant tout accès au cache', async t => {
  const auths = [
    undefined,
    {type: 'SERVICE_ACCOUNT_IMPERSONATION', user: USER},
    {type: 'USER_SESSION'},
    {type: 'USER_SESSION', user: {...USER, deletedAt: new Date()}},
    {type: 'USER_SESSION', user: {...USER, role: 'SERVICE_ACCOUNT'}},
    {type: 'USER_SESSION', user: USER, impersonation: {startedAt: new Date()}},
    {type: 'USER_SESSION', user: USER, actor: {type: 'SERVICE_ACCOUNT', id: ACTOR.id}}
  ]
  const responses = await Promise.all(auths.map(auth => request(createApp({
    auth,
    direct: true,
    recordActivity: async () => t.fail('Le cache ne doit pas être consulté.')
  })).post('/users/me/activity')))
  t.deepEqual(responses.map(response => response.status), [401, 403, 403, 403, 403, 403, 403])
})

test('le client ne peut fournir ni identité, ni catégorie, ni mois, ni historique de navigation', async t => {
  const app = createApp({
    auth: {type: 'USER_SESSION', user: USER},
    recordActivity: async () => t.fail('Aucune écriture ne doit être déclenchée.')
  })
  const responses = await Promise.all([
    request(app).post('/users/me/activity').send({userId: ACTOR.id}),
    request(app).post('/users/me/activity').send({role: 'ADMIN'}),
    request(app).post('/users/me/activity').send({month: '2025-01'}),
    request(app).post('/users/me/activity').send({path: '/declarations/private'}),
    request(app).post('/users/me/activity?month=2025-01'),
    request(app).post('/users/me/activity').send([])
  ])
  t.true(responses.every(response => response.status === 400))
})

test('la panne de collecte reste une erreur générique, sans faux succès ni détail privé', async t => {
  const app = createApp({
    auth: {type: 'USER_SESSION', user: USER},
    recordActivity: async () => {
      throw new Error('Erreur SQL avec un identifiant privé et un secret')
    }
  })
  const response = await request(app).post('/users/me/activity')
  t.is(response.status, 503)
  t.is(response.headers['cache-control'], 'no-store')
  t.deepEqual(response.body, {message: 'La mesure d’activité est momentanément indisponible.'})
})

test('le signal mensuel n’ajoute pas de journal d’audit détaillé', t => {
  t.is(findAuditAction('POST', '/users/me/activity'), null)
})
