import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import pg from 'pg'
import {prisma} from '../../db/prisma.js'
import {requireDisposableDatabase} from '../../lib/util/test-helpers/disposable-database.js'
import {backfillChunkValueSummaries} from '../lib/chunk-value-summary-backfill.js'

const integration = process.env.METER_INTEGRATION_TESTS === '1' ? test.serial : test.skip
test.before(() => { if (process.env.METER_INTEGRATION_TESTS === '1') requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

integration('reprise des résumés : simulation, lots bornés, rejeu sans écriture et originaux conservés', async t => {
  const client = new pg.Client({connectionString: process.env.DATABASE_URL})
  await client.connect()
  const source = await prisma.source.create({data: {type: 'API', status: 'COMPLETED', metadata: {fixture: 'summary-backfill'}}})
  try {
    const usage = await prisma.sandreWaterUse.findUniqueOrThrow({where: {code: '0'}})
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    await prisma.chunk.createMany({data: ids.map(id => ({id, sourceId: source.id, usageId: usage.id,
      minDate: new Date('2026-01-01'), maxDate: new Date('2026-12-31')}))})
    await prisma.chunkValue.createMany({data: ids.map(chunkId => ({chunkId, metricTypeCode: 'volume', unit: 'm³', frequency: '1 day',
      periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-01-02'), value: '123.12345678901234567890123456789'}))})
    const readValues = () => prisma.chunkValue.findMany({where: {chunkId: {in: ids}}, orderBy: {id: 'asc'}})
    const beforeValues = await readValues()
    const beforeSource = await prisma.source.findUnique({where: {id: source.id}})
    const beforeStates = await prisma.chunkValueSummary.findMany({orderBy: {chunkId: 'asc'}})
    const dryRun = await backfillChunkValueSummaries(client)
    t.true(dryRun.before.remaining >= 3)
    t.is(dryRun.refreshed, 0)
    t.deepEqual(await prisma.chunkValueSummary.findMany({orderBy: {chunkId: 'asc'}}), beforeStates)
    const progress = []
    const first = await backfillChunkValueSummaries(client, {apply: true, batchSize: 1, maxBatches: 1,
      onProgress: report => progress.push(report)})
    t.is(first.batches, 1)
    t.is(first.refreshed, 1)
    t.false(first.complete)
    t.is(progress[0].cursor, first.cursor)
    const resumed = await backfillChunkValueSummaries(client, {apply: true, after: first.cursor, batchSize: 2, maxBatches: 10000})
    t.true(resumed.complete)
    t.is(resumed.after.remaining, 0)
    const completedStates = await prisma.chunkValueSummary.findMany({orderBy: {chunkId: 'asc'}})
    const replay = await backfillChunkValueSummaries(client, {apply: true})
    t.is(replay.refreshed, 0)
    t.is(replay.batches, 0)
    t.true(replay.complete)
    t.deepEqual(await prisma.chunkValueSummary.findMany({orderBy: {chunkId: 'asc'}}), completedStates)
    t.deepEqual(await readValues(), beforeValues)
    t.deepEqual(await prisma.source.findUnique({where: {id: source.id}}), beforeSource)
  } finally {
    await prisma.source.delete({where: {id: source.id}})
    await client.end()
  }
})

test('paramètres de reprise refusés avant tout accès SQL', async t => {
  const client = {query: () => { t.fail('SQL inattendu') }}
  for (const options of [{batchSize: 0}, {batchSize: 101}, {maxBatches: 0}, {maxBatches: 1.5}, {after: 'invalid'}]) {
    await t.throwsAsync(backfillChunkValueSummaries(client, options), {message: 'Paramètres de reprise invalides.'})
  }
})
