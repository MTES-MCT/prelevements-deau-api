import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import {resolve} from 'node:path'
import process from 'node:process'
import {pathToFileURL} from 'node:url'
import {gzipSync} from 'node:zlib'

import {prisma} from '../db/prisma.js'
import {requireDisposableDatabase} from '../lib/util/test-helpers/disposable-database.js'

// This script deliberately cannot target an application database. It only
// creates synthetic fixtures, and removes its own source/points/user afterwards.
requireDisposableDatabase()

function integers(name, fallback, maximum) {
  const values = (process.env[name] || fallback).split(',').map(Number)
  assert(values.every(value => Number.isInteger(value) && value > 0 && value <= maximum), `Invalid ${name}`)
  return values
}

const pointCounts = integers('SERIES_BENCH_POINTS', '1000,10000', 10000)
const concurrencies = integers('SERIES_BENCH_CONCURRENCY', '1,5', 10)
const [iterations] = integers('SERIES_BENCH_ITERATIONS', '5', 30)
const repository = resolve(process.env.SERIES_BENCH_REPOSITORY || '.')
const {getAggregatedSeriesHandler} = await import(pathToFileURL(resolve(repository, 'lib/handlers/series-aggregation.js')))
const {getAggregatedSeriesOptionsHandler} = await import(pathToFileURL(resolve(repository, 'lib/handlers/series-aggregation-options.js')))
const view = process.env.SERIES_BENCH_VIEW === 'legacy' ? undefined : 'chart'

async function createFixture(pointCount, fixture) {
  fixture.usage = await prisma.sandreWaterUse.create({data: {
    code: `b${randomUUID().slice(0, 12)}`, kind: 'USAGE', label: 'Benchmark graphe synthétique'
  }})
  fixture.owner = await prisma.user.create({data: {
    role: 'DECLARANT', declarant: {create: {declarantRole: 'PRELEVEUR', preleveurType: 'IRRIGANT', socialReason: 'Benchmark synthétique'}}
  }})
  fixture.source = await prisma.source.create({data: {type: 'API', status: 'COMPLETED'}})
  // Deterministic IDs inside a random namespace make cleanup precise, including
  // a partial setup failure. The data represents 2023-2025, not the current date.
  fixture.namespace = randomUUID()
  await prisma.$executeRaw`
    INSERT INTO "PointPrelevement" (id, name, "waterBodyType", "flowType", "createdAt", "updatedAt")
    SELECT md5(${fixture.namespace} || ':point:' || n)::uuid,
      ${fixture.namespace} || ':point:' || n, 'SUPERFICIELLE', 'PRELEVEMENT', now(), now()
    FROM generate_series(1, ${pointCount}::int) n
  `
  await prisma.$executeRaw`
    INSERT INTO "DeclarantPointPrelevement" (id, "declarantUserId", "pointPrelevementId", "usageId", "status", "createdAt", "updatedAt")
    SELECT md5(${fixture.namespace} || ':exploitation:' || n)::uuid, ${fixture.owner.id}::uuid,
      md5(${fixture.namespace} || ':point:' || n)::uuid, ${fixture.usage.id}::uuid, 'EN_ACTIVITE', now(), now()
    FROM generate_series(1, ${pointCount}::int) n
  `
  await prisma.$executeRaw`
    INSERT INTO "Chunk" (id, "sourceId", "pointPrelevementId", "exploitationId", "preleveurUserId", "usageId",
      "calculationStrategy", "flowType", "instructionStatus", "minDate", "maxDate", "createdAt", "updatedAt")
    SELECT md5(${fixture.namespace} || ':chunk:' || n)::uuid, ${fixture.source.id}::uuid,
      md5(${fixture.namespace} || ':point:' || n)::uuid, md5(${fixture.namespace} || ':exploitation:' || n)::uuid,
      ${fixture.owner.id}::uuid, ${fixture.usage.id}::uuid,
      (CASE WHEN n % 2 = 0 THEN 'METER' ELSE 'GENERIC' END)::"ChunkCalculationStrategy",
      'PRELEVEMENT', 'AUTOMATICALLY_VALIDATED', '2023-01-01', '2025-12-31', now(), now()
    FROM generate_series(1, ${pointCount}::int) n
  `
  await prisma.$executeRaw`
    INSERT INTO "ChunkValue" (id, "chunkId", "metricTypeCode", unit, frequency, "periodStart", "periodEnd", "valueKind", value, "createdAt", "updatedAt")
    SELECT md5(c.id::text || ':volume:' || period)::uuid, c.id, 'volume', 'm³',
      CASE WHEN c."calculationStrategy" = 'METER' THEN 'irregular' ELSE '1 year' END,
      CASE WHEN c."calculationStrategy" = 'METER' THEN (period AT TIME ZONE 'Europe/Paris') AT TIME ZONE 'UTC' ELSE period END,
      CASE WHEN c."calculationStrategy" = 'METER' THEN ((period + interval '1 month') AT TIME ZONE 'Europe/Paris') AT TIME ZONE 'UTC'
        ELSE period + interval '1 year' END,
      (CASE WHEN c."calculationStrategy" = 'METER' THEN 'COMPUTED' ELSE 'DECLARED' END)::"ChunkValueKind", 100, now(), now()
    FROM "Chunk" c CROSS JOIN LATERAL generate_series(timestamp '2023-01-01', timestamp '2025-12-01',
      CASE WHEN c."calculationStrategy" = 'METER' THEN interval '1 month' ELSE interval '1 year' END) period
    WHERE c."sourceId" = ${fixture.source.id}::uuid
  `
  await prisma.$executeRaw`
    INSERT INTO "ChunkValue" (id, "chunkId", "metricTypeCode", unit, frequency, "periodStart", "periodEnd", value, "createdAt", "updatedAt")
    SELECT md5(c.id::text || ':flow:' || period)::uuid, c.id, 'débit', 'L/s', '1 day', period, period + interval '1 day', 2, now(), now()
    FROM "Chunk" c CROSS JOIN generate_series(timestamp '2023-01-01', timestamp '2025-12-01', interval '1 month') period
    WHERE c."sourceId" = ${fixture.source.id}::uuid
  `
  for (const table of ['PointPrelevement', 'DeclarantPointPrelevement', 'Chunk', 'ChunkValue']) {
    await prisma.$executeRawUnsafe(`ANALYZE "${table}"`)
  }
}

async function cleanup(fixture) {
  if (fixture.source) await prisma.source.delete({where: {id: fixture.source.id}})
  if (fixture.owner) {
    await prisma.declarantPointPrelevement.deleteMany({where: {declarantUserId: fixture.owner.id}})
    await prisma.user.delete({where: {id: fixture.owner.id}})
  }
  if (fixture.namespace) await prisma.pointPrelevement.deleteMany({where: {name: {startsWith: `${fixture.namespace}:point:`}}})
  if (fixture.usage) await prisma.sandreWaterUse.delete({where: {id: fixture.usage.id}})
}

async function invoke(handler, query) {
  let body
  const response = {send(value) { body = value }, json(value) { body = value }}
  const start = performance.now()
  await handler({query, user: {id: '00000000-0000-4000-8000-000000000001', role: 'ADMIN'}, permittedZoneIds: []}, response)
  const handlerMs = performance.now() - start
  const serialized = JSON.stringify(body)
  return {body, handlerMs, serializedMs: performance.now() - start, bytes: Buffer.byteLength(serialized), gzipBytes: gzipSync(serialized).length}
}

function percentile(values, quantile) {
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] * 10) / 10
}

async function loadGraph(fixture, pointCount) {
  const query = {preleveurId: fixture.owner.id, ...(view ? {view} : {})}
  const startedAt = performance.now()
  const options = await invoke(getAggregatedSeriesOptionsHandler, {...query, includeExploitationIndexes: 'true', includeMeterReadings: 'true'})
  const metrics = await Promise.all(['volume', 'débit'].map(metricTypeCode => invoke(getAggregatedSeriesHandler, {
    ...query, metricTypeCode, pointFlowType: 'PRELEVEMENT', aggregationFrequency: '1 month',
    temporalOperator: metricTypeCode === 'volume' ? 'sum' : 'mean', startDate: '2023-01-01', endDate: '2025-12-31'
  })))
  const elapsedMs = performance.now() - startedAt
  const volume = metrics[0].body
  const total = volume.values.reduce((sum, bucket) => sum + bucket.value, 0)
  const expectedTotal = Math.floor(pointCount / 2) * 3600 + Math.ceil(pointCount / 2) * 300
  assert(Math.abs(total - expectedTotal) <= 0.000001 * expectedTotal, 'Synthetic volume total changed')
  assert.equal(volume.values.length, 36)
  assert.equal(volume.metadata.exactVolumesEstimated, true)
  assert.equal(metrics[1].body.values.length, 36)
  assert(metrics[1].body.values.every(bucket => bucket.value === pointCount * 2), 'Synthetic flow changed')
  return {
    elapsedMs, optionsMs: options.handlerMs, volumeMs: metrics[0].handlerMs, flowMs: metrics[1].handlerMs,
    bytes: options.bytes + metrics.reduce((sum, metric) => sum + metric.bytes, 0),
    gzipBytes: options.gzipBytes + metrics.reduce((sum, metric) => sum + metric.gzipBytes, 0),
    buckets: volume.values.length, total, exactPeriods: volume.exactPeriods?.length ?? 0,
    points: options.body.points?.length ?? 0
  }
}

async function measure(fixture, pointCount, concurrency) {
  const samples = []
  for (let iteration = 0; iteration < iterations; iteration++) {
    samples.push(...await Promise.all(Array.from({length: concurrency}, () => loadGraph(fixture, pointCount))))
  }
  const timings = Object.fromEntries(['elapsedMs', 'optionsMs', 'volumeMs', 'flowMs'].map(key => [key, {
    p50: percentile(samples.map(sample => sample[key]), 0.5), p95: percentile(samples.map(sample => sample[key]), 0.95)
  }]))
  console.log(JSON.stringify({event: 'measured', pointCount, view: view || 'legacy', concurrency, samples: samples.length,
    timings, bytes: samples[0].bytes, gzipBytes: samples[0].gzipBytes, buckets: samples[0].buckets,
    exactPeriods: samples[0].exactPeriods, points: samples[0].points}))
}

try {
  for (const pointCount of pointCounts) {
    const fixture = {}
    try {
      await createFixture(pointCount, fixture)
      const first = await loadGraph(fixture, pointCount)
      console.log(JSON.stringify({event: 'first', pointCount, view: view || 'legacy', ...first}))
      for (const concurrency of concurrencies) {
        await measure(fixture, pointCount, concurrency)
      }
    } finally {
      await cleanup(fixture)
    }
  }
} finally {
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
}
