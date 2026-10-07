import test from 'ava'
import express from 'express'
import request from 'supertest'
import {createRoutes} from '../routes.js'

for (const role of ['ADMIN', 'DECLARANT']) {
  test(`la revue et la validation de compteur sont supprimées pour ${role}, avec et sans préfixe API`, async t => {
    const app = express()
    app.use(express.json())
    app.use((req, res, next) => {
      req.user = {id: '11111111-1111-4111-8111-111111111111', role}
      req.userRole = role
      req.auth = {type: 'USER_SESSION', role, user: req.user}
      next()
    })
    app.use(createRoutes())
    app.use('/api', createRoutes())
    const path = '/campaigns/22222222-2222-4222-8222-222222222222/meters/33333333-3333-4333-8333-333333333333'
    const responses = await Promise.all(['', '/api'].flatMap(prefix => [
      request(app).get(`${prefix}${path}/review`),
      request(app).post(`${prefix}${path}/approve`).send({confirmHistorical: true, allocations: []})
    ]))
    t.deepEqual(responses.map(response => response.status), [404, 404, 404, 404])
  })
}
