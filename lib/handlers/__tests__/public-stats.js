import test from 'ava'
import express from 'express'
import request from 'supertest'

import {createPublicStatsHandler} from '../public-stats.js'
import {createRoutes} from '../../routes.js'

const NOW = new Date('2026-09-09T12:00:00Z')

function createApp(loadStats) {
  const app = express()
  const router = createRoutes({
    publicStatsHandler: createPublicStatsHandler({loadStats, now: () => NOW})
  })
  // Même ordre que dans api.js : le montage racine intercepte aussi /api.
  app.use('/', router)
  app.use('/api', router)
  app.use((error, req, res, _next) => {
    res.status(error.status || 500).json({message: error.message})
  })
  return app
}

test('les statistiques publiques sont accessibles sans session et avec un ancien token', async t => {
  const queries = []
  const snapshot = {month: '2026-08', totals: {preleveursCount: 4}}
  const app = createApp(async query => {
    queries.push(query)
    return snapshot
  })
  const responses = await Promise.all([
    request(app).get('/stats/public'),
    request(app).get('/api/stats/public'),
    request(app).get('/api/stats/public').set('Authorization', 'Bearer expired-token'),
    request(app).get('/stats/public?month=2026-07')
  ])

  t.true(responses.every(response => response.status === 200))
  t.true(responses.every(response => response.headers['cache-control'] === 'public, max-age=300'))
  t.deepEqual(responses[0].body, snapshot)
  t.deepEqual(queries.map(query => query.month).sort(), ['2026-07', '2026-08', '2026-08', '2026-08'])
  t.true(queries.every(query => query.now === NOW))
})

test('les paramètres invalides et les mois non terminés ne déclenchent aucun calcul', async t => {
  const app = createApp(async () => {
    t.fail('Le calcul ne doit pas être appelé.')
  })
  const queries = [
    'month=2026-13',
    'month=2026-9',
    'month=',
    'month=2026-09',
    'month=2027-01',
    'month=0001-01',
    'month=2026-07&month=2026-08',
    'userId=private-account'
  ]
  const responses = await Promise.all(queries.map(query => request(app).get(`/stats/public?${query}`)))
  t.true(responses.every(response => response.status === 400))
  t.true(responses.every(response => response.headers['cache-control'] === 'no-store'))
})

test('une erreur de calcul reste une erreur non mise en cache, pas un résultat vide', async t => {
  const app = createApp(async () => {
    throw new Error('Calcul indisponible')
  })
  const response = await request(app).get('/stats/public')
  t.is(response.status, 500)
  t.is(response.headers['cache-control'], 'no-store')
  t.falsy(response.body.totals)
})

test('la nouvelle route publique ne donne accès ni à l’ancien endpoint ni aux espaces privés', async t => {
  const app = createApp(async () => ({}))
  const responses = await Promise.all([
    '/stats',
    '/api/stats',
    '/admin/dashboard',
    '/api/admin/dashboard',
    '/admin/audit-events',
    '/api/admin/audit-events',
    '/stats/private',
    '/api/stats/private'
  ].map(path => request(app).get(path)))
  t.true(responses.every(response => response.status === 401))
})
