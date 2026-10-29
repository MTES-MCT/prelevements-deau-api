/* eslint-disable no-await-in-loop -- Cache states and cursor pages are verified in order. */
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import prismaPkg from '@prisma/client'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {refreshChunkValueSummaries} from '../../services/chunk-value-summaries.js'
import {buildDeclarantDeclarationFeed, decodeDeclarationFeedCursor} from '../declaration-feed.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
const queries = []
let database
test.before(() => {
  if (!enabled) return
  requireDisposableDatabase()
  database = new prismaPkg.PrismaClient({adapter: globalThis.prismaAdapter, log: [{level: 'query', emit: 'event'}]})
  database.$on('query', query => queries.push(query))
})
test.after.always(async () => {
  await database?.$disconnect()
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

async function createFixture(client) {
  const usage = await client.sandreWaterUse.findUniqueOrThrow({where: {code: '0'}})
  const actors = await Promise.all([0, 1].map(() => client.user.create({data: {
    role: 'DECLARANT', declarant: {create: {declarantRole: 'PRELEVEUR', preleveurType: 'AUTRE'}}
  }})))
  const declarations = []
  for (const [index, createdAt] of ['2026-03-01', '2026-01-01', '2026-04-01'].entries()) {
    declarations.push(await client.declaration.create({data: {
      code: randomUUID().slice(0, 6), type: 'synthetic-file', dataSourceType: 'SPREADSHEET',
      waterWithdrawalType: 'WITHDRAWAL', processingStatus: 'COMPLETED',
      declarantUserId: actors[index === 2 ? 1 : 0].id, createdAt: new Date(createdAt),
      source: {create: {type: 'DECLARATION', status: 'COMPLETED'}}
    }, include: {source: true}}))
  }
  const telemetry = await client.source.create({data: {
    type: 'API', status: 'COMPLETED', createdAt: new Date('2026-02-01'),
    metadata: {calculationStrategy: 'METER', totalWaterVolumeWithdrawn: 999}
  }})
  const chunks = []
  const specs = [
    {sourceId: declarations[0].source.id, count: 2, native: true},
    {sourceId: declarations[0].source.id, count: 3},
    {sourceId: declarations[0].source.id, count: 0},
    {sourceId: declarations[1].source.id, count: 5},
    {sourceId: declarations[2].source.id, count: 6},
    {sourceId: telemetry.id, count: 4, calculationStrategy: 'METER', preleveurUserId: actors[0].id},
    {sourceId: telemetry.id, count: 7, calculationStrategy: 'METER', preleveurUserId: actors[1].id}
  ]
  for (const spec of specs) {
    const {count, native, ...fields} = spec
    const chunk = await client.chunk.create({data: {
      ...fields, usageId: usage.id, instructionStatus: 'VALIDATED',
      minDate: new Date('2026-01-01'), maxDate: new Date('2026-01-31'),
      createdAt: new Date(Date.UTC(2026, 0, chunks.length + 1)),
      metadata: {nativeTemporal: Boolean(native), totalWaterVolumeWithdrawn: count}
    }})
    if (count) await client.chunkValue.createMany({data: Array.from({length: count}, (_, index) => ({
      chunkId: chunk.id, metricTypeCode: 'volume', unit: 'm³', frequency: '1 day', value: '1.25',
      periodStart: new Date(Date.UTC(2026, 0, index + 1)), periodEnd: new Date(Date.UTC(2026, 0, index + 2))
    }))})
    chunks.push({...chunk, expectedCount: count})
  }
  const user = {id: actors[0].id, role: 'DECLARANT', declarant: {declarantRole: 'PRELEVEUR'}}
  const feed = options => buildDeclarantDeclarationFeed({
    user, includeMeta: false, limit: 2, client,
    findReadableDeclarantUserIds: async () => [user.id],
    decorateDeclarationTypes: async rows => rows,
    ...options
  })
  return {declarations, telemetry, chunks, feed}
}

async function fixture(run) {
  const rollback = new Error('ROLLBACK_DECLARATION_FEED')
  try {
    await database.$transaction(async client => {
      await run(client, await createFixture(client))
      throw rollback
    }, {timeout: 30000})
  } catch (error) { if (error !== rollback) throw error }
}

integration('feed SQL : comptes exacts natifs et historiques, sans agrégation globale ni lecture hors page ou droits', async t => {
  await fixture(async (client, {declarations, telemetry, chunks, feed}) => {
    const selectedChunks = [chunks[0], chunks[1], chunks[2], chunks[5]]
    let cold
    for (const state of ['cold', 'warm', 'stale']) {
      if (state === 'warm') await refreshChunkValueSummaries(chunks.map(chunk => chunk.id), {client})
      if (state === 'stale') {
        await client.chunkValueSummary.update({where: {chunkId: chunks[0].id}, data: {valid: false, valueCount: 999n}})
        await client.chunkValueSummary.update({where: {chunkId: chunks[1].id}, data: {formatVersion: 0, valueCount: 999n}})
      }
      const summaries = await client.chunkValueSummary.findMany({orderBy: {chunkId: 'asc'}})
      queries.length = 0
      const response = await feed()
      const feedQueries = [...queries]
      if (state === 'cold') cold = response
      else t.deepEqual(response, cold)
      t.deepEqual(response.data.map(row => row.id), [`declaration-${declarations[0].id}`, `telemetry-${telemetry.id}`])
      t.deepEqual(response.data.flatMap(row => row.source.chunks.map(chunk => [chunk.id, chunk._count.chunkValues])),
        selectedChunks.map(chunk => [chunk.id, chunk.expectedCount]))
      t.deepEqual(response.data[0].declaration.source.chunks, response.data[0].source.chunks)
      t.is(response.data[1].source.metadata.totalWaterVolumeWithdrawn, 4)
      t.true(response.meta.pagination.hasNext)
      t.false(feedQueries.some(query => query.query.includes('_aggr_count_chunkValues')))
      const countQueries = feedQueries.filter(query => query.query.includes('COALESCE(s."valueCount"'))
      t.is(countQueries.length, 1)
      t.deepEqual(JSON.parse(countQueries[0].params), [1, ...selectedChunks.map(chunk => chunk.id)])
      t.deepEqual(await client.chunkValueSummary.findMany({orderBy: {chunkId: 'asc'}}), summaries)
    }
  })
})

integration('feed SQL : curseur et page vide ne comptent que les séries effectivement retournées', async t => {
  await fixture(async (_client, {declarations, chunks, feed}) => {
    const first = await feed()
    queries.length = 0
    const second = await feed({cursor: decodeDeclarationFeedCursor(first.meta.pagination.nextCursor)})
    t.deepEqual(second.data.map(row => row.id), [`declaration-${declarations[1].id}`])
    t.is(second.data[0].source.chunks[0]._count.chunkValues, 5)
    t.false(second.meta.pagination.hasNext)
    const countQueries = queries.filter(query => query.query.includes('COALESCE(s."valueCount"'))
    t.is(countQueries.length, 1)
    t.deepEqual(JSON.parse(countQueries[0].params), [1, chunks[3].id])
    queries.length = 0
    const empty = await feed({kinds: []})
    t.deepEqual(empty.data, [])
    t.false(queries.some(query => query.query.includes('ChunkValue')))
  })
})
