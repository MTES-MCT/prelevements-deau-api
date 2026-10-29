import test from 'ava'
import {loadSourceChunkValues} from '../source-chunk-values.js'
import {getSourceForAdmin} from '../instructor-sources.js'

test('aucune requête sans chunk autorisé, y compris pour une source absente', async t => {
  const sources = [null, {chunks: []}]
  t.is(await loadSourceChunkValues(sources, {client: {}}), sources)
})

test('les comptes sont bornés aux IDs visibles et seules les valeurs legacy sont chargées', async t => {
  const native = {id: 'native', metadata: {nativeTemporal: true}}
  const legacy = {id: 'legacy', metadata: {}, _count: {other: 1}}
  const empty = {id: 'empty', metadata: {nativeTemporal: false}}
  const value = {id: 'value', chunkId: 'legacy', value: '12.123456789012345', periodEnd: new Date('2026-01-02'), remark: 'Conservée'}
  const client = {
    async $queryRaw(query) {
      t.deepEqual(query.values.filter(value => typeof value === 'string'), ['native', 'legacy', 'empty'])
      return [{id: 'native', valueCount: 3_190_410n}, {id: 'legacy', valueCount: 1n}]
    },
    chunkValue: {
      async findMany(query) {
        t.deepEqual(query, {where: {chunkId: {in: ['legacy', 'empty']}}, orderBy: {periodEnd: 'asc'}})
        return [value]
      }
    }}
  await loadSourceChunkValues([{chunks: [native, legacy, empty]}], {client, includeLegacyValues: true})
  t.deepEqual(native.chunkValues, [])
  t.is(native._count.chunkValues, 3_190_410)
  t.deepEqual(legacy._count, {other: 1, chunkValues: 1})
  t.is(legacy.chunkValues[0], value)
  t.is(empty._count.chunkValues, 0)
  t.deepEqual(empty.chunkValues, [])
})

test('un détail entièrement natif ne demande aucune ligne de valeurs', async t => {
  const native = {id: 'native', metadata: {nativeTemporal: true}}
  const client = {$queryRaw: async () => [{id: 'native', valueCount: 12n}], chunkValue: {
    findMany: async () => {t.fail('Aucune lecture native hors pagination'); return []}
  }}
  await loadSourceChunkValues([{chunks: [native]}], {client, includeLegacyValues: true})
  t.deepEqual(native.chunkValues, [])
  t.is(native._count.chunkValues, 12)
})

test('le détail admin conserve les comptes exacts sans relation de valeurs ni agrégat global dans la projection', async t => {
  const client = {
    source: {async findFirst(query) {
      t.falsy(query.include.chunks.include.chunkValues)
      t.falsy(query.include.chunks.include._count)
      return {id: 'source', status: 'COMPLETED', metadata: {nativeTemporal: true}, chunks: [{id: 'chunk', metadata: {nativeTemporal: true}}]}
    }},
    async $queryRaw(query) {
      t.deepEqual(query.values.filter(value => typeof value === 'string'), ['chunk'])
      return [{id: 'chunk', valueCount: 3_190_410n}]
    }
  }
  const source = await getSourceForAdmin('source', {client})
  t.is(source.chunks[0]._count.chunkValues, 3_190_410)
  t.deepEqual(source.chunks[0].chunkValues, [])
})
