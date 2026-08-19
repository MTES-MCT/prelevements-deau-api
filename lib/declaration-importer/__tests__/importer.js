import test from 'ava'

import {
  markDeclarationSourceIngestionFailed,
  prepareDeclarationSourceForIngestion,
  shouldUpdateExploitationWaterUse
} from '../importer.js'

function createDeclaration() {
  return {
    id: 'declaration-id',
    type: 'aquasys',
    files: [
      {id: 'file-1'},
      {id: 'file-2'}
    ]
  }
}

function createFakeClient({existingSource = null} = {}) {
  const state = {
    existingSource,
    activityQueries: [],
    chunkDeletes: [],
    sourceCreates: [],
    sourceUpdates: []
  }

  const client = {
    state,
    async $queryRaw(query) {
      state.activityQueries.push(query)
      return []
    },
    async $transaction(callback) {
      return callback(client)
    },
    chunk: {
      async deleteMany(query) {
        state.chunkDeletes.push(query)
      }
    },
    source: {
      async findUnique() {
        return state.existingSource
      },
      async create({data}) {
        const source = {
          id: 'created-source',
          ...data
        }
        state.sourceCreates.push(data)
        state.existingSource = source
        return source
      },
      async update({where, data}) {
        const source = {
          id: where.id,
          ...state.existingSource,
          ...data
        }
        state.sourceUpdates.push({where, data})
        state.existingSource = source
        return source
      }
    }
  }

  return client
}

test('prepareDeclarationSourceForIngestion réinitialise une source existante avant ingestion', async t => {
  const client = createFakeClient({
    existingSource: {
      id: 'source-id',
      metadata: {
        replayRequestedAt: '2026-07-09T17:02:10.308Z',
        processingError: 'previous failure',
        processingFailedAt: '2026-07-09T17:10:48.519Z',
        parsingErrors: ['old parse error']
      }
    }
  })

  const source = await prepareDeclarationSourceForIngestion({
    declaration: createDeclaration(),
    client
  })

  t.is(source.id, 'source-id')
  t.deepEqual(client.state.chunkDeletes, [
    {
      where: {
        sourceId: 'source-id'
      }
    }
  ])
  t.deepEqual(client.state.sourceUpdates[0].data, {
    type: 'DECLARATION',
    status: 'PROCESSING',
    globalInstructionStatus: 'TO_INSTRUCT',
    metadata: {
      replayRequestedAt: '2026-07-09T17:02:10.308Z',
      declarationType: 'aquasys',
      fileCount: 2
    }
  })
})

test('prepareDeclarationSourceForIngestion crée une source en processing', async t => {
  const client = createFakeClient()

  const source = await prepareDeclarationSourceForIngestion({
    declaration: createDeclaration(),
    client
  })

  t.is(source.id, 'created-source')
  t.deepEqual(client.state.chunkDeletes, [])
  t.deepEqual(client.state.sourceCreates[0], {
    type: 'DECLARATION',
    status: 'PROCESSING',
    declarationId: 'declaration-id',
    metadata: {
      declarationType: 'aquasys',
      fileCount: 2
    }
  })
})

test('prepareDeclarationSourceForIngestion recalcule les acteurs retirés par un rejeu', async t => {
  const declarantUserId = '11111111-1111-4111-8111-111111111111'
  const preleveurUserId = '22222222-2222-4222-8222-222222222222'
  const client = createFakeClient({
    existingSource: {
      id: 'source-id',
      metadata: {},
      declaration: {
        declarantUserId,
        createdByDeclarantUserId: null
      },
      chunks: [{
        preleveurUserId,
        submittedByDeclarantUserId: null,
        collecteurUserId: null
      }]
    }
  })

  await prepareDeclarationSourceForIngestion({
    declaration: createDeclaration(),
    client
  })

  t.is(client.state.activityQueries.length, 1)
  t.deepEqual(client.state.activityQueries[0].values, [declarantUserId, preleveurUserId])
})

test('markDeclarationSourceIngestionFailed marque la source en erreur', async t => {
  const client = createFakeClient({
    existingSource: {
      id: 'source-id',
      metadata: {
        declarationType: 'aquasys',
        fileCount: 2
      }
    }
  })

  await markDeclarationSourceIngestionFailed({
    sourceId: 'source-id',
    error: new Error('Transaction expired'),
    client
  })

  const update = client.state.sourceUpdates[0]
  t.deepEqual(update.where, {id: 'source-id'})
  t.is(update.data.status, 'FAILED')
  t.is(update.data.globalInstructionStatus, 'TO_INSTRUCT')
  t.is(update.data.metadata.declarationType, 'aquasys')
  t.is(update.data.metadata.processingError, 'Transaction expired')
  t.truthy(update.data.metadata.processingFailedAt)
})

test('shouldUpdateExploitationWaterUse préserve l’exploitation pour un usage inconnu', t => {
  const exploitation = {
    id: 'exploitation-id',
    usageId: 'industry-root-id'
  }

  t.false(shouldUpdateExploitationWaterUse({
    id: 'unknown-id',
    code: '0',
    kind: 'USAGE'
  }, exploitation))

  t.true(shouldUpdateExploitationWaterUse({
    id: 'cooling-id',
    code: '4D',
    kind: 'SUB_USAGE',
    parentId: 'industry-root-id'
  }, {
    ...exploitation,
    usageId: 'other-root-id'
  }))

  t.false(shouldUpdateExploitationWaterUse({
    id: 'cooling-id',
    code: '4D',
    kind: 'SUB_USAGE',
    parentId: 'industry-root-id'
  }, exploitation))
})
