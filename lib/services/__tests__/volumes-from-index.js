import test from 'ava'
import {reconstructVolumesForChunks} from '../volumes-from-index.js'

test('la reconstruction legacy ne supprime ni ne recalcule les publications METER', async t => {
  const queries = []
  const deletions = []
  const client = {
    async $queryRaw(strings) {
      queries.push(strings.join(''))
      return []
    },
    chunkValue: {async deleteMany({where}) {
      deletions.push(where)
    }}
  }
  const genericChunk = {
    id: 'generic', pointPrelevementId: 'point', calculationStrategy: 'GENERIC',
    chunkValues: [{metricTypeCode: 'index', valueKind: 'DECLARED'}]
  }
  const result = await reconstructVolumesForChunks([
    genericChunk, {...genericChunk, id: 'meter', calculationStrategy: 'METER'}
  ], client)

  t.deepEqual(deletions[0].chunkId.in, ['generic'])
  t.is(result.details[1].reason, 'NON_GENERIC_CALCULATION')
  t.true(result.details[1].skipped)
  t.true(queries[0].includes('c."calculationStrategy" = \'GENERIC\''))
  t.true(queries[0].includes('PARTITION BY "preleveurUserId", "exploitationId", "compteurId"'))
})
