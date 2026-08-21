import test from 'ava'
import express from 'express'
import request from 'supertest'

import {createRoutes} from '../routes.js'

function createApp(authMethods) {
  const app = express()
  app.use(express.json())
  app.use(createRoutes({authMethods}))
  return app
}

test('la configuration est publique et conserve l’ordre des méthodes', async t => {
  const app = createApp(['password', 'magic_link'])
  const response = await request(app).get('/auth/config')

  t.is(response.status, 200)
  t.deepEqual(response.body, {methods: ['password', 'magic_link']})
})

test('les routes password sont absentes lorsque la méthode est désactivée', async t => {
  const app = createApp(['magic_link'])

  const responses = await Promise.all([
    request(app).post('/auth/password').send({}),
    request(app).post('/auth/password/activate').send({}),
    request(app).post('/auth/password/change').send({}),
    request(app).get('/admin/password-accesses'),
    request(app).post('/admin/password-accesses').send({}),
    request(app).delete('/admin/password-accesses/11111111-1111-4111-8111-111111111111')
  ])

  t.true(responses.every(response => response.status === 404))
})

test('les routes magic link sont absentes lorsque la méthode est désactivée', async t => {
  const app = createApp(['password'])
  const responses = await Promise.all([
    request(app).post('/auth/request').send({}),
    request(app).post('/auth/verify').send({})
  ])

  t.true(responses.every(response => response.status === 404))
})
