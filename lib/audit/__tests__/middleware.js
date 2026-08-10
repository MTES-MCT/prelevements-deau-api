import {EventEmitter} from 'node:events'

import test from 'ava'

import {createAuditMiddleware} from '../middleware.js'

function createRequest({body = {}, method = 'POST', path = '/declarations'} = {}) {
  return {
    body,
    ip: '127.0.0.1',
    method,
    path,
    query: {},
    requestId: 'api-request-id',
    get(name) {
      return name.toLowerCase() === 'user-agent' ? 'Test browser' : undefined
    }
  }
}

function createResponse(statusCode = 201) {
  const response = new EventEmitter()
  response.statusCode = statusCode
  response.writableFinished = true
  response.json = body => body
  response.send = body => body
  return response
}

function waitForFinalization() {
  return new Promise(resolve => {
    setImmediate(resolve)
  })
}

test('le middleware bloque l’action si la trace initiale ne peut pas être créée', async t => {
  const middleware = createAuditMiddleware({
    client: {
      auditEvent: {
        async create() {
          throw new Error('database unavailable')
        }
      }
    }
  })
  const request = createRequest()
  const response = createResponse()
  const error = await new Promise(resolve => {
    middleware(request, response, resolve)
  })

  t.is(error.status, 503)
  t.is(request.auditEventId, undefined)
})

test('le middleware finalise une action et exclut les données sensibles', async t => {
  let createData
  let updateData
  const middleware = createAuditMiddleware({
    client: {
      auditEvent: {
        async create({data}) {
          createData = data
          return {id: '11111111-1111-4111-8111-111111111111'}
        },
        async update({data}) {
          updateData = data
        }
      },
      user: {
        async findUnique() {
          return null
        }
      }
    }
  })
  const request = createRequest({
    body: {
      token: 'never-store-me',
      comment: 'never-store-me-either',
      role: 'DECLARANT',
      values: [1, 2, 3]
    }
  })
  const response = createResponse()

  await new Promise((resolve, reject) => {
    middleware(request, response, error => {
      if (error) {
        reject(error)
        return
      }

      request.auth = {type: 'USER_SESSION'}
      request.userRole = 'DECLARANT'
      request.user = {
        id: '22222222-2222-4222-8222-222222222222',
        email: 'user@example.test',
        firstName: 'Nathalie',
        lastName: 'Jury',
        role: 'DECLARANT'
      }
      response.emit('finish')
      resolve()
    })
  })
  await waitForFinalization()

  t.is(createData.actionType, 'DECLARATION.FILE_CREATED')
  t.deepEqual(createData.metadata.changedFields, ['role', 'values'])
  t.is(createData.metadata.valuesCount, 3)
  t.false(JSON.stringify(createData.metadata).includes('never-store-me'))
  t.is(updateData.outcome, 'SUCCESS')
  t.is(updateData.actorUserId, request.user.id)
  t.is(updateData.effectiveUserId, request.user.id)
  t.is(updateData.actorLabel, 'Nathalie Jury')
})

test('le middleware distingue un refus d’une erreur métier', async t => {
  let updateData
  const middleware = createAuditMiddleware({
    client: {
      auditEvent: {
        async create() {
          return {id: '11111111-1111-4111-8111-111111111111'}
        },
        async update({data}) {
          updateData = data
        }
      },
      user: {
        async findUnique() {
          return null
        }
      }
    }
  })
  const request = createRequest()
  const response = createResponse(403)

  await new Promise(resolve => {
    middleware(request, response, () => {
      response.emit('finish')
      resolve()
    })
  })
  await waitForFinalization()

  t.is(updateData.outcome, 'DENIED')
})

test('le middleware classe une limitation de débit comme un refus', async t => {
  let updateData
  const middleware = createAuditMiddleware({
    client: {
      auditEvent: {
        async create() {
          return {id: '11111111-1111-4111-8111-111111111111'}
        },
        async update({data}) {
          updateData = data
        }
      },
      user: {
        async findUnique() {
          return null
        }
      }
    }
  })
  const request = createRequest()
  const response = createResponse(429)

  await new Promise(resolve => {
    middleware(request, response, () => {
      response.emit('finish')
      resolve()
    })
  })
  await waitForFinalization()

  t.is(updateData.outcome, 'DENIED')
})

test('le middleware distingue auteur réel et utilisateur effectif pendant une impersonation', async t => {
  let updateData
  const middleware = createAuditMiddleware({
    client: {
      auditEvent: {
        async create() {
          return {id: '11111111-1111-4111-8111-111111111111'}
        },
        async update({data}) {
          updateData = data
        }
      },
      user: {
        async findUnique() {
          return null
        }
      }
    }
  })
  const request = createRequest()
  const response = createResponse()

  await new Promise(resolve => {
    middleware(request, response, () => {
      request.auth = {type: 'USER_SESSION'}
      request.authActor = {
        type: 'USER',
        id: '33333333-3333-4333-8333-333333333333',
        email: 'admin@example.test',
        firstName: 'Samy',
        lastName: 'Ghribi',
        role: 'ADMIN'
      }
      request.user = {
        id: '22222222-2222-4222-8222-222222222222',
        email: 'nathalie@example.test',
        firstName: 'Nathalie',
        lastName: 'Jury',
        role: 'DECLARANT'
      }
      request.userRole = 'DECLARANT'
      response.emit('finish')
      resolve()
    })
  })
  await waitForFinalization()

  t.is(updateData.actorUserId, request.authActor.id)
  t.is(updateData.actorRole, 'ADMIN')
  t.is(updateData.effectiveUserId, request.user.id)
  t.is(updateData.effectiveUserRole, 'DECLARANT')
})

test('le middleware conserve le compte de service comme auteur de son impersonation', async t => {
  let updateData
  const middleware = createAuditMiddleware({
    client: {
      auditEvent: {
        async create() {
          return {id: '11111111-1111-4111-8111-111111111111'}
        },
        async update({data}) {
          updateData = data
        }
      },
      user: {
        async findUnique() {
          return null
        }
      }
    }
  })
  const request = createRequest()
  const response = createResponse()

  await new Promise(resolve => {
    middleware(request, response, () => {
      request.auth = {type: 'SERVICE_ACCOUNT_IMPERSONATION'}
      request.authActor = {
        type: 'SERVICE_ACCOUNT',
        id: '44444444-4444-4444-8444-444444444444',
        name: 'Orchestrateur'
      }
      request.user = {
        id: '22222222-2222-4222-8222-222222222222',
        email: 'nathalie@example.test',
        role: 'DECLARANT'
      }
      request.userRole = 'DECLARANT'
      response.emit('finish')
      resolve()
    })
  })
  await waitForFinalization()

  t.is(updateData.actorType, 'SERVICE_ACCOUNT')
  t.is(updateData.actorServiceAccountId, request.authActor.id)
  t.is(updateData.effectiveUserId, request.user.id)
})

test('le middleware persiste la mutation métier avec l’événement réussi', async t => {
  const declarationId = '55555555-5555-4555-8555-555555555555'
  let mutationData
  let updateData
  const client = {
    auditEvent: {
      async create() {
        return {id: '11111111-1111-4111-8111-111111111111'}
      },
      async update({data}) {
        updateData = data
      }
    },
    auditMutation: {
      async create({data}) {
        mutationData = data
      }
    },
    declaration: {
      async findUnique() {
        return {
          id: declarationId,
          declarantUserId: '22222222-2222-4222-8222-222222222222',
          dataSourceType: 'SPREADSHEET',
          waterWithdrawalType: 'VOLUME',
          processingStatus: 'CREATED',
          comment: 'Ne doit pas apparaître dans l’audit.'
        }
      }
    },
    async $transaction(callback) {
      return callback(client)
    }
  }
  const middleware = createAuditMiddleware({client})
  const request = createRequest()
  const response = createResponse()

  await new Promise((resolve, reject) => {
    middleware(request, response, error => {
      if (error) {
        reject(error)
        return
      }

      response.send({id: declarationId})
      response.emit('finish')
      resolve()
    })
  })
  await waitForFinalization()

  t.is(updateData.outcome, 'SUCCESS')
  t.is(updateData.targetId, declarationId)
  t.is(mutationData.auditEventId, request.auditEventId)
  t.is(mutationData.operation, 'CREATE')
  t.is(mutationData.entityType, 'DECLARATION')
  t.is(mutationData.entityId, declarationId)
  t.deepEqual(mutationData.after, {
    declarantUserId: '22222222-2222-4222-8222-222222222222',
    dataSourceType: 'SPREADSHEET',
    waterWithdrawalType: 'VOLUME',
    processingStatus: 'CREATED'
  })
  t.false(JSON.stringify(mutationData).includes('Ne doit pas apparaître'))
})
