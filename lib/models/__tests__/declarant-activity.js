import test from 'ava'

import {
  buildDeclarantActivityPreviewQuery,
  buildDeclarantActivityRefreshQuery,
  getDeclarantUserIdsForSourceActivity,
  refreshSourceDeclarantsLastDeclarationAt
} from '../declarant.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const SUBMITTER_ID = '22222222-2222-4222-8222-222222222222'
const COLLECTEUR_ID = '33333333-3333-4333-8333-333333333333'

test('la requête d’activité retient les sources terminées et les chunks non rejetés', t => {
  const refreshQuery = buildDeclarantActivityRefreshQuery([USER_ID])
  const previewQuery = buildDeclarantActivityPreviewQuery([USER_ID])

  t.regex(refreshQuery.sql, /s\.type IN \('DECLARATION'::"SourceType", 'API'::"SourceType"\)/)
  t.regex(refreshQuery.sql, /s\.status = 'COMPLETED'::"SourceStatus"/)
  t.regex(refreshQuery.sql, /chunk\."instructionStatus" <> 'REJECTED'::"ChunkInstructionStatus"/)
  t.regex(refreshQuery.sql, /chunk\."preleveurUserId" = d\."userId"/)
  t.deepEqual(refreshQuery.values, [USER_ID])
  t.deepEqual(previewQuery.values, [USER_ID])
})

test('les acteurs d’une source sont dédupliqués', async t => {
  const client = {
    source: {
      findUnique: async () => ({
        declaration: {
          declarantUserId: USER_ID,
          createdByDeclarantUserId: SUBMITTER_ID
        },
        chunks: [{
          preleveurUserId: USER_ID,
          submittedByDeclarantUserId: SUBMITTER_ID,
          collecteurUserId: COLLECTEUR_ID
        }]
      })
    }
  }

  t.deepEqual(
    await getDeclarantUserIdsForSourceActivity('source-1', {client}),
    [USER_ID, SUBMITTER_ID, COLLECTEUR_ID]
  )
})

test('le rafraîchissement d’une source recalcule tous ses acteurs', async t => {
  let query
  const client = {
    source: {
      findUnique: async () => ({
        declaration: {declarantUserId: USER_ID, createdByDeclarantUserId: null},
        chunks: [{
          preleveurUserId: USER_ID,
          submittedByDeclarantUserId: COLLECTEUR_ID,
          collecteurUserId: COLLECTEUR_ID
        }]
      })
    },
    $queryRaw: async value => {
      query = value
      return []
    }
  }

  await refreshSourceDeclarantsLastDeclarationAt('source-1', {client})

  t.deepEqual(query.values, [USER_ID, COLLECTEUR_ID])
})
