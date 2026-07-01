import test from 'ava'

import {
  markDeclarationProcessingCompleted,
  markDeclarationProcessingUploaded,
  requestDeclarationProcessing
} from '../declaration-processing.js'

function createFakeClient() {
  const state = {
    declarationUpdates: [],
    events: []
  }

  const client = {
    state,
    async $transaction(callback) {
      return callback(client)
    },
    declaration: {
      async update(update) {
        state.declarationUpdates.push(update)
        return update.data
      }
    },
    declarationProcessingEvent: {
      async create({data}) {
        state.events.push(data)
        return data
      }
    }
  }

  return client
}

test('markDeclarationProcessingUploaded trace le statut uploadé', async t => {
  const client = createFakeClient()

  await markDeclarationProcessingUploaded({
    declarationId: 'declaration-id',
    createdByUserId: 'user-id',
    metadata: {fileCount: 2},
    client
  })

  t.is(client.state.declarationUpdates[0].data.processingStatus, 'UPLOADED')
  t.deepEqual(client.state.events[0], {
    declarationId: 'declaration-id',
    status: 'UPLOADED',
    message: 'Déclaration uploadée',
    metadata: {fileCount: 2},
    createdByUserId: 'user-id'
  })
})

test('markDeclarationProcessingCompleted trace le statut terminé', async t => {
  const client = createFakeClient()

  await markDeclarationProcessingCompleted({
    declarationId: 'declaration-id',
    metadata: {sourceId: 'source-id'},
    client
  })

  t.is(client.state.declarationUpdates[0].data.processingStatus, 'COMPLETED')
  t.true(client.state.declarationUpdates[0].data.processingCompletedAt instanceof Date)
  t.deepEqual(client.state.events[0], {
    declarationId: 'declaration-id',
    status: 'COMPLETED',
    message: 'Traitement terminé',
    metadata: {sourceId: 'source-id'},
    createdByUserId: null
  })
})

test('requestDeclarationProcessing marque QUEUED quand l’orchestration accepte', async t => {
  const client = createFakeClient()

  const result = await requestDeclarationProcessing({
    declarationId: 'declaration-id',
    createdByUserId: 'user-id',
    required: true,
    metadata: {fileCount: 1},
    async notify(payload) {
      t.deepEqual(payload, {
        declarationId: 'declaration-id',
        required: true
      })

      return {
        queued: true,
        jobId: 'job-id'
      }
    },
    client
  })

  t.deepEqual(result, {queued: true, jobId: 'job-id'})
  t.is(client.state.declarationUpdates[0].data.processingStatus, 'QUEUED')
  t.is(client.state.declarationUpdates[0].data.processingJobId, 'job-id')
  t.deepEqual(client.state.events[0], {
    declarationId: 'declaration-id',
    status: 'QUEUED',
    message: 'Traitement demandé',
    metadata: {
      fileCount: 1,
      orchestration: {
        queued: true,
        jobId: 'job-id'
      }
    },
    createdByUserId: 'user-id'
  })
})

test('requestDeclarationProcessing marque FAILED quand l’orchestration échoue', async t => {
  const client = createFakeClient()
  const error = new Error('hook failed')

  await t.throwsAsync(
    requestDeclarationProcessing({
      declarationId: 'declaration-id',
      replay: true,
      async notify() {
        throw error
      },
      client
    }),
    {message: 'hook failed'}
  )

  t.is(client.state.declarationUpdates[0].data.processingStatus, 'FAILED')
  t.is(client.state.declarationUpdates[0].data.processingError, 'hook failed')
  t.deepEqual(client.state.events[0], {
    declarationId: 'declaration-id',
    status: 'FAILED',
    message: 'hook failed',
    metadata: {
      replay: true
    },
    createdByUserId: null
  })
})
