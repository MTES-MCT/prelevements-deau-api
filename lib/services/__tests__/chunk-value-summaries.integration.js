/* eslint-disable no-await-in-loop -- SQL mutations, cache checks and lock synchronization are deliberately sequential. */
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import test from 'ava'
import prismaPkg from '@prisma/client'
import {prisma} from '../../../db/prisma.js'
import {listSeries, getAggregationSeriesScope} from '../../models/series.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {chunkValueSummaryGroupsSql, loadChunkValueCounts, refreshChunkValueSummaries, refreshChunkValueSummariesForSourceIds} from '../chunk-value-summaries.js'

const {Prisma} = prismaPkg
const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

function measure(metricTypeCode, unit, frequency, start, end) {
  const value = '1.12345678901234567890123456789'
  return {metricTypeCode, unit, frequency, periodStart: new Date(start), periodEnd: new Date(end), value, metadata: {nativeTemporal: true}}
}

async function createFixture(client) {
  const usage = await client.sandreWaterUse.findUniqueOrThrow({where: {code: '0'}})
  const source = await client.source.create({data: {type: 'API', status: 'COMPLETED'}})
  const chunkIds = Array.from({length: 3}, () => randomUUID())
  await client.chunk.createMany({data: chunkIds.map(id => ({id, sourceId: source.id, usageId: usage.id,
    minDate: new Date('2026-01-01'), maxDate: new Date('2026-12-31'), instructionStatus: 'VALIDATED'}))})
  const values = [
    measure('volume', 'm³', '1 day', '2026-01-01Z', '2026-01-02Z'),
    measure('volume', 'm³', '1 day', '2026-01-02Z', '2026-01-03Z'),
    measure('volume', null, '1 month', '2026-01-01Z', '2026-02-01Z'),
    measure('volume', '', '1 month', '2026-01-01Z', '2026-02-01Z'),
    measure('volume', 'm³', '1 month', '2026-01-01Z', '2026-02-01Z'),
    measure('volume prélevé', 'm³', '1 day', '2026-01-01Z', '2026-01-02Z'),
    measure('débit', 'L/s', 'instant', '2026-01-01T20:00:00Z', '2026-01-02T20:00:00Z'),
    measure('débit', 'L/s', 'instant', '2026-01-02T20:00:00Z', '2026-01-02T20:00:00Z'),
    measure('débit', 'L/s', '15 minutes', '2026-10-25T00:50:00Z', '2026-10-25T01:00:00Z'),
    measure('débit', 'L/s', '15 minutes', '2026-10-25T01:05:00Z', '2026-10-25T01:20:00Z')
  ]
  await client.chunkValue.createMany({data: values.map(value => ({...value, chunkId: chunkIds[0]}))})
  await client.chunkValue.create({data: {...values[0], chunkId: chunkIds[2]}})
  return {source, chunkIds, values}
}

async function fixture(run) {
  const rollback = new Error('ROLLBACK_CHUNK_VALUE_SUMMARIES')
  try {
    await prisma.$transaction(async client => {
      await run(client, await createFixture(client))
      throw rollback
    }, {timeout: 30000})
  } catch (error) { if (error !== rollback) throw error }
}

const ordered = groups => [...groups].sort((left, right) => JSON.stringify([left.metricTypeCode, left.unit, left.frequency]).localeCompare(JSON.stringify([right.metricTypeCode, right.unit, right.frequency])))
const groups = (client, chunkId) => client.$queryRaw(Prisma.sql`SELECT * FROM (${chunkValueSummaryGroupsSql(Prisma.sql`${chunkId}::uuid`)}) summary_groups`)
const summary = (client, chunkId) => client.chunkValueSummary.findUnique({where: {chunkId}})
const valuesFor = (client, chunkIds) => client.chunkValue.findMany({where: {chunkId: {in: chunkIds}}, orderBy: {id: 'asc'}})

// Independent aggregate over real values: no summary table, helper or cache marker.
const referenceGroups = (client, chunkId) => client.$queryRaw`
  SELECT "metricTypeCode", unit, frequency, count(*)::bigint AS "valueCount",
    min("periodStart") AS "minPeriodStart", max("periodStart") AS "maxPeriodStart",
    min("periodStart") FILTER (WHERE "periodEnd">"periodStart") AS "minIntervalPeriodStart",
    max("periodEnd") FILTER (WHERE "periodEnd">"periodStart") AS "maxIntervalPeriodEnd",
    min("periodEnd") AS "minPeriodEnd", max("periodEnd") AS "maxPeriodEnd",
    max("periodEnd" - CASE WHEN "periodEnd">"periodStart" THEN interval '1 millisecond' ELSE interval '0' END) AS "maxCoveredPeriodEnd",
    min("periodStart" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Paris') AS "minParisPeriodStart",
    min("periodEnd" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Paris') AS "minParisPeriodEnd",
    max("periodEnd" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Paris') AS "maxParisPeriodEnd"
  FROM "ChunkValue" WHERE "chunkId"=${chunkId}::uuid GROUP BY "metricTypeCode",unit,frequency
`

integration('résumés froids et chauds : groupes, dates, unités, fréquences et valeurs restent identiques', async t => {
  await fixture(async (client, {source, chunkIds, values}) => {
    const beforeValues = await valuesFor(client, chunkIds)
    const beforeStates = await client.chunkValueSummary.findMany({where: {chunkId: {in: chunkIds}}, orderBy: {chunkId: 'asc'}})
    const reference = ordered(await referenceGroups(client, chunkIds[0]))
    t.deepEqual(ordered(await groups(client, chunkIds[0])), reference)
    t.deepEqual(await loadChunkValueCounts(chunkIds, {client}), new Map([[chunkIds[0], values.length], [chunkIds[1], 0], [chunkIds[2], 1]]))
    t.deepEqual(await client.chunkValueSummary.findMany({where: {chunkId: {in: chunkIds}}, orderBy: {chunkId: 'asc'}}), beforeStates)
    await refreshChunkValueSummariesForSourceIds([source.id], client)
    t.deepEqual(ordered(await groups(client, chunkIds[0])), reference)
    const state = await summary(client, chunkIds[0])
    t.true(state.valid)
    t.is(state.formatVersion, 1)
    t.is(state.valueCount, BigInt(values.length))
    const empty = await summary(client, chunkIds[1])
    t.true(empty.valid)
    t.is(empty.valueCount, 0n)
    t.deepEqual(empty.groups, [])
    t.deepEqual(await groups(client, chunkIds[1]), [])
    t.is((await loadChunkValueCounts(chunkIds, {client})).get(chunkIds[0]), values.length)
    t.deepEqual(await valuesFor(client, chunkIds), beforeValues)
    const instant = reference.find(group => group.metricTypeCode === 'débit' && group.frequency === 'instant')
    t.deepEqual(instant.maxCoveredPeriodEnd, new Date('2026-01-02T20:00:00Z'))
    const autumn = reference.find(group => group.frequency === '15 minutes')
    t.deepEqual(autumn.minParisPeriodStart, new Date('2026-10-25T02:05:00Z'))
  })
})

integration('invalidation SQL : insert, update entre chunks, suppression et rollback préservent les autres résumés', async t => {
  await fixture(async (client, {chunkIds, values}) => {
    await refreshChunkValueSummaries(chunkIds, {client})
    const unaffected = await summary(client, chunkIds[2])
    await client.$executeRaw`SAVEPOINT summary_mutation`
    const inserted = await client.chunkValue.create({data: {...values[0], chunkId: chunkIds[0]}})
    t.false((await summary(client, chunkIds[0])).valid)
    t.is((await loadChunkValueCounts(chunkIds, {client})).get(chunkIds[0]), values.length + 1)
    t.false((await summary(client, chunkIds[0])).valid)
    await client.$executeRaw`ROLLBACK TO SAVEPOINT summary_mutation`
    t.true((await summary(client, chunkIds[0])).valid)
    t.is((await loadChunkValueCounts(chunkIds, {client})).get(chunkIds[0]), values.length)
    t.is(await client.chunkValue.findUnique({where: {id: inserted.id}}), null)
    const moved = (await valuesFor(client, [chunkIds[0]]))[0]
    await client.$executeRaw`UPDATE "ChunkValue" SET "chunkId"=${chunkIds[1]}::uuid, unit='modified', "metricTypeCode"='index',
      "periodStart"='2027-01-01'::timestamp,"periodEnd"='2027-01-01'::timestamp WHERE id=${moved.id}::uuid`
    t.false((await summary(client, chunkIds[0])).valid)
    t.false((await summary(client, chunkIds[1])).valid)
    t.deepEqual(ordered(await groups(client, chunkIds[0])), ordered(await referenceGroups(client, chunkIds[0])))
    t.deepEqual(ordered(await groups(client, chunkIds[1])), ordered(await referenceGroups(client, chunkIds[1])))
    await refreshChunkValueSummaries(chunkIds.slice(0, 2), {client})
    await client.$executeRaw`DELETE FROM "ChunkValue" WHERE "chunkId"=${chunkIds[1]}::uuid`
    t.false((await summary(client, chunkIds[1])).valid)
    t.is((await loadChunkValueCounts(chunkIds, {client})).get(chunkIds[1]), 0)
    await refreshChunkValueSummaries([chunkIds[1]], {client})
    t.deepEqual((await summary(client, chunkIds[1])).groups, [])
    t.deepEqual(await summary(client, chunkIds[2]), unaffected)
    await client.chunk.delete({where: {id: chunkIds[1]}})
    t.is(await summary(client, chunkIds[1]), null)
  })
})

integration('format périmé et TRUNCATE : fallback exact puis reconstruction des résumés vides', async t => {
  await fixture(async (client, {chunkIds, values}) => {
    await refreshChunkValueSummaries(chunkIds, {client})
    await client.chunkValueSummary.update({where: {chunkId: chunkIds[0]}, data: {formatVersion: 0, valueCount: 999n}})
    t.is((await loadChunkValueCounts(chunkIds, {client})).get(chunkIds[0]), values.length)
    t.deepEqual(ordered(await groups(client, chunkIds[0])), ordered(await referenceGroups(client, chunkIds[0])))
    await refreshChunkValueSummaries([chunkIds[0]], {client})
    t.is((await summary(client, chunkIds[0])).formatVersion, 1)
    // The whole fixture is rolled back; the disposable database guard is mandatory.
    await client.$executeRawUnsafe('TRUNCATE TABLE "ChunkValue" CASCADE')
    t.true((await client.chunkValueSummary.findMany({where: {chunkId: {in: chunkIds}}})).every(row => !row.valid))
    t.deepEqual(await loadChunkValueCounts(chunkIds, {client}), new Map(chunkIds.map(id => [id, 0])))
    await refreshChunkValueSummaries(chunkIds, {client})
    const rebuilt = await client.chunkValueSummary.findMany({where: {chunkId: {in: chunkIds}}})
    t.true(rebuilt.every(row => row.valid && row.valueCount === 0n && row.groups.length === 0))
  })
})

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return {promise, resolve}
}

async function waitForBlock(blocked, blocker) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw`SELECT ${blocker}::integer=ANY(pg_blocking_pids(${blocked}::integer)) AS blocked`
    if (row.blocked) return true
    await delay(10)
  }
  return false
}

for (const writerFirst of [false, true]) {
  integration(`concurrence : ${writerFirst ? 'l’écriture précède' : 'le refresh précède'} le verrou concurrent, aucune invalidation perdue`, async t => {
    const fixtureData = await createFixture(prisma)
    const {source, chunkIds, values} = fixtureData
    const ready = deferred(), release = deferred(), otherPid = deferred()
    let first, second
    try {
      await refreshChunkValueSummaries(chunkIds, {client: prisma})
      if (writerFirst) await prisma.chunkValueSummary.update({where: {chunkId: chunkIds[0]}, data: {valid: false}})
      first = prisma.$transaction(async client => {
        const [{pid}] = await client.$queryRaw`SELECT pg_backend_pid() AS pid`
        if (writerFirst) await client.chunkValue.create({data: {...values[0], chunkId: chunkIds[0]}})
        else {
          await client.$queryRaw`SELECT "chunkId" FROM "ChunkValueSummary" WHERE "chunkId"=${chunkIds[0]}::uuid FOR UPDATE`
          await client.chunkValueSummary.update({where: {chunkId: chunkIds[0]}, data: {valid: false}})
          await refreshChunkValueSummaries([chunkIds[0]], {client})
        }
        ready.resolve(pid)
        await release.promise
      }, {timeout: 15000})
      const blocker = await ready.promise
      second = prisma.$transaction(async client => {
        const [{pid}] = await client.$queryRaw`SELECT pg_backend_pid() AS pid`
        otherPid.resolve(pid)
        if (writerFirst) await refreshChunkValueSummaries([chunkIds[0]], {client})
        else await client.chunkValue.create({data: {...values[0], chunkId: chunkIds[0]}})
      }, {timeout: 15000})
      try { t.true(await waitForBlock(await otherPid.promise, blocker)) } finally { release.resolve() }
      await Promise.all([first, second])
      const state = await summary(prisma, chunkIds[0])
      t.is(state.valid, writerFirst)
      t.is((await loadChunkValueCounts(chunkIds, {client: prisma})).get(chunkIds[0]), values.length + 1)
      t.deepEqual(ordered(await groups(prisma, chunkIds[0])), ordered(await referenceGroups(prisma, chunkIds[0])))
      if (writerFirst) t.is(state.valueCount, BigInt(values.length + 1))
    } finally {
      release.resolve()
      await Promise.allSettled([first, second].filter(Boolean))
      await prisma.source.delete({where: {id: source.id}})
    }
  })
}


integration('listes de séries : grain historique et filtres de visibilité restent exacts avec un cache chaud', async t => {
  await fixture(async (client, {source, chunkIds}) => {
    const options = {sourceId: source.id, user: {role: 'ADMIN'}}
    const sortSeries = rows => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    const cold = sortSeries(await listSeries(options, {client}))
    const reference = await client.chunkValue.groupBy({by: ['chunkId', 'metricTypeCode', 'unit', 'frequency'],
      where: {chunkId: {in: chunkIds}}, _count: {_all: true}})
    t.is(cold.length, reference.length)
    t.deepEqual(cold.map(row => row.numberOfValues).sort(), reference.map(row => row._count._all).sort())
    t.is((await getAggregationSeriesScope(options, {client})).seriesCount, reference.length)
    const dateOptions = {...options, parameter: 'volume', startDate: '2026-01-02', endDate: '2026-01-02'}
    const filteredCold = sortSeries(await listSeries(dateOptions, {client}))
    t.true(filteredCold.length < cold.length)
    await refreshChunkValueSummaries(chunkIds, {client})
    t.deepEqual(sortSeries(await listSeries(options, {client})), cold)
    t.deepEqual(sortSeries(await listSeries(dateOptions, {client})), filteredCold)
    await client.source.update({where: {id: source.id}, data: {status: 'PROCESSING'}})
    t.deepEqual(await listSeries(options, {client}), [])
    t.deepEqual(await getAggregationSeriesScope(options, {client}), {chunkIds: [], seriesCount: 0})
    t.true((await summary(client, chunkIds[0])).valid)
    await client.source.update({where: {id: source.id}, data: {status: 'COMPLETED'}})
    await client.chunk.update({where: {id: chunkIds[0]}, data: {instructionStatus: 'REJECTED'}})
    t.deepEqual(sortSeries(await listSeries(options, {client})), cold.filter(row => row.computed.chunkId !== chunkIds[0]))
    t.true((await summary(client, chunkIds[0])).valid)
  })
})

integration('lecteur concurrent : le cache visible reste cohérent avant commit puis retombe sur les valeurs après commit', async t => {
  const {source, chunkIds, values} = await createFixture(prisma)
  const ready = deferred(), release = deferred()
  let writer
  try {
    await refreshChunkValueSummaries(chunkIds)
    writer = prisma.$transaction(async client => {
      await client.chunkValue.create({data: {...values[0], chunkId: chunkIds[0]}})
      ready.resolve()
      await release.promise
    }, {timeout: 15000})
    await ready.promise
    t.true((await summary(prisma, chunkIds[0])).valid)
    t.is((await loadChunkValueCounts(chunkIds)).get(chunkIds[0]), values.length)
    t.deepEqual(ordered(await groups(prisma, chunkIds[0])), ordered(await referenceGroups(prisma, chunkIds[0])))
    t.is(await refreshChunkValueSummaries([chunkIds[0]]), 0)
    release.resolve()
    await writer
    t.false((await summary(prisma, chunkIds[0])).valid)
    t.is((await loadChunkValueCounts(chunkIds)).get(chunkIds[0]), values.length + 1)
    await refreshChunkValueSummaries([chunkIds[0]])
    t.true((await summary(prisma, chunkIds[0])).valid)
    t.is((await summary(prisma, chunkIds[0])).valueCount, BigInt(values.length + 1))
  } finally {
    release.resolve()
    await Promise.allSettled([writer].filter(Boolean))
    await prisma.source.delete({where: {id: source.id}})
  }
})
