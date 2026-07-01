import {Buffer} from 'node:buffer'
import test from 'ava'

import {
  createBullBoardAuthMiddleware,
  createBullBoardRouter
} from '../board.js'

function createResponse() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    status(statusCode) {
      this.statusCode = statusCode
      return this
    },
    json(body) {
      this.body = body
      return this
    }
  }
}

function basicAuth(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
}

test('createBullBoardAuthMiddleware retourne 401 sans authentification', t => {
  const middleware = createBullBoardAuthMiddleware('test-password')
  const response = createResponse()
  let nextCalled = false

  middleware({headers: {}}, response, () => {
    nextCalled = true
  })

  t.false(nextCalled)
  t.is(response.statusCode, 401)
  t.deepEqual(response.body, {error: 'Authentification requise'})
  t.is(response.headers['www-authenticate'], 'Basic realm="BullBoard"')
})

test('createBullBoardAuthMiddleware retourne 401 avec un mauvais mot de passe', t => {
  const middleware = createBullBoardAuthMiddleware('test-password')
  const response = createResponse()
  let nextCalled = false

  middleware({
    headers: {
      authorization: basicAuth('admin', 'wrong-password')
    }
  }, response, () => {
    nextCalled = true
  })

  t.false(nextCalled)
  t.is(response.statusCode, 401)
  t.deepEqual(response.body, {error: 'Authentification échouée'})
})

test('createBullBoardAuthMiddleware laisse passer le bon mot de passe', t => {
  const middleware = createBullBoardAuthMiddleware('test-password')
  const response = createResponse()
  let nextCalled = false

  middleware({
    headers: {
      authorization: basicAuth('admin', 'test-password')
    }
  }, response, () => {
    nextCalled = true
  })

  t.true(nextCalled)
  t.is(response.statusCode, null)
  t.is(response.body, null)
})

test('createBullBoardRouter se construit sans queue injectée', async t => {
  const {router, close} = createBullBoardRouter('/admin/queues', 'test-password', {queues: []})

  t.truthy(router)
  await close()
  t.pass()
})
