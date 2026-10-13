import test from 'ava'
import {applyManifest} from '../apply-epidropt.js'
import {digest, stableId} from '../epidropt.js'

test('un ancien manifeste ne réactive aucun des cinq points AEP supprimés logiquement', async t => {
  const points = ['1', '2', '5', '6', '8'].map(name => ({id: stableId(`retired-aep:${name}`),
    sourceId: `synthetic-retired:${name}`, references: [], data: {name}}))
  const payload = {formatVersion: 1, scope: 'epidropt', points, declarants: [], exploitations: [], meters: [], allocations: [], issues: []}
  const manifest = {...payload, manifestHash: digest(payload)}
  let writes = 0
  const unexpectedWrite = async () => { writes += 1; throw new Error('UNEXPECTED_WRITE') }
  const client = {
    $executeRaw: async () => 0,
    $executeRawUnsafe: async () => 0,
    $queryRaw: async () => [],
    externalReference: {findMany: async () => []},
    meterAllocation: {findMany: async () => []},
    pointPrelevement: {
      findMany: async ({where}) => [{id: where.OR[0].id}],
      findUnique: async ({where}) => where.id ? {id: where.id, deletedAt: new Date('2026-10-12T00:00:00Z')} : null,
      create: unexpectedWrite,
      update: unexpectedWrite
    }
  }
  client.$transaction = execute => execute(client)
  for (const apply of [false, true]) {
    const result = await applyManifest(client, manifest, {apply})
    t.false(result.complete)
    t.false(result.applied)
    t.is(writes, 0)
    t.deepEqual(result.changes, [])
    t.deepEqual(result.executionIssues.map(issue => issue.code), Array(5).fill('POINT_SUPPRIME'))
  }
})
