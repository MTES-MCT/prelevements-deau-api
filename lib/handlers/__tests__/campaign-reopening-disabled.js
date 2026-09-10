import test from 'ava'
import express from 'express'
import request from 'supertest'
import {createRoutes} from '../../routes.js'

const campaignId = '10000000-0000-4000-8000-000000000001'
const farmerId = '10000000-0000-4000-8000-000000000002'

function createApp(role) {
  const app = express()
  app.use(express.json())
  if (role) {
    app.use((req, res, next) => {
      // Session locale au test : ni jeton réel ni authentification en BDD.
      req.user = {id: farmerId, role}
      req.userRole = role
      req.auth = {type: 'USER_SESSION'}
      next()
    })
  }

  const router = createRoutes()
  app.use('/', router)
  app.use('/api', router)
  app.use((error, req, res, _next) => {
    res.status(error.statusCode || 500).json({message: error.message})
  })
  return app
}

for (const role of ['ADMIN', 'INSTRUCTOR', 'DECLARANT']) {
  test(`l’ancienne route répond explicitement 410 au rôle ${role} sur les deux volets`, async t => {
    const app = createApp(role)
    const results = await Promise.all(['', '/api'].flatMap(prefix => ['INDEX', 'NEEDS'].map(kind => request(app)
      .post(`${prefix}/campaigns/${campaignId}/responses/${kind}/reopen`)
      .send({preleveurUserId: farmerId, expectedVersion: 1, reason: 'Ancien client'}))))
    t.true(results.every(result => result.status === 410))
    t.true(results.every(result => result.body.message === 'La réouverture manuelle des réponses n’est plus disponible.'))
  })
}

test('l’ancienne route reste authentifiée et ne devient pas une route publique', async t => {
  const response = await request(createApp()).post(`/campaigns/${campaignId}/responses/INDEX/reopen`).send({})
  t.is(response.status, 401)
})

test('les paramètres de route invalides restent refusés avant l’ancienne commande', async t => {
  const app = createApp('ADMIN')
  const responses = await Promise.all([
    request(app).post('/campaigns/incorrect/responses/INDEX/reopen').send({}),
    request(app).post(`/campaigns/${campaignId}/responses/INCONNU/reopen`).send({})
  ])
  t.true(responses.every(response => response.status === 400))
})
