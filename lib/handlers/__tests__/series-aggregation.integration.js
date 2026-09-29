/* eslint-disable no-await-in-loop -- Synthetic fixtures share a guarded transaction that always rolls back. */
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'

import {prisma} from '../../../db/prisma.js'
import {getAggregationSeriesScope, listSeries} from '../../models/series.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {getAggregatedSeriesHandler, getAggregatedValuesFromSql, hasExactMeterPeriods} from '../series-aggregation.js'

const integration = process.env.METER_INTEGRATION_TESTS === '1' ? test.serial : test.skip

test.before(() => {
  if (process.env.METER_INTEGRATION_TESTS === '1') requireDisposableDatabase()
})
test.after.always(async () => {
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

async function rollbackFixtures(operation) {
  const rollback = new Error('ROLLBACK_AGGREGATION_FIXTURES')
  try {
    await prisma.$transaction(async client => {
      await operation(client)
      throw rollback
    }, {timeout: 60000})
  } catch (error) {
    if (error !== rollback) throw error
  }
}

async function createFixture(client) {
  const usage = await client.sandreWaterUse.create({data: {code: `a${randomUUID().slice(0, 12)}`, kind: 'USAGE', label: 'Usage agrégation synthétique'}})
  const source = await client.source.create({data: {type: 'API', status: 'COMPLETED'}})
  const point = await client.pointPrelevement.create({data: {name: `Agrégation ${randomUUID()}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'}})
  return {usage, source, point}
}

async function createChunk(client, fixture, {id, strategy = 'GENERIC', preleveurUserId, status = 'VALIDATED', values}) {
  return client.chunk.create({data: {
    id,
    sourceId: fixture.source.id, pointPrelevementId: fixture.point.id, usageId: fixture.usage.id,
    calculationStrategy: strategy, preleveurUserId, instructionStatus: status,
    minDate: new Date('2020-01-01Z'), maxDate: new Date('2027-01-01Z'),
    chunkValues: {create: values.map(value => ({
      metricTypeCode: 'volume', unit: 'm³', frequency: strategy === 'METER' ? 'irregular' : '1 month',
      valueKind: strategy === 'METER' ? 'COMPUTED' : 'DECLARED', ...value,
      periodStart: new Date(value.periodStart), periodEnd: new Date(value.periodEnd)
    }))}
  }})
}

function assertEquivalentValues(t, actual, expected, label) {
  t.deepEqual(actual.map(row => row.date), expected.map(row => row.date), label)
  for (const [index, row] of actual.entries()) {
    const reference = expected[index].value
    t.true(Math.abs(row.value - reference) <= Math.max(1e-9, Math.abs(reference) * 1e-12), `${label}: ${row.date}, ${row.value} / ${reference}`)
  }
}

// The HTTP handler uses the shared client. Forward its reads into the fixture
// transaction so the complete handler runs real SQL without committing data.
async function withHandlerTransaction(client, operation) {
  const reads = [
    [prisma.user, 'findFirst', client.user],
    [prisma.declarantCollecteurExploitation, 'findMany', client.declarantCollecteurExploitation],
    [prisma.chunkValue, 'groupBy', client.chunkValue],
    [prisma.chunkValue, 'findMany', client.chunkValue],
    [prisma, '$queryRawUnsafe', client]
  ].map(([target, method, transactionTarget]) => ({
    target, method, original: target[method], replacement: transactionTarget[method].bind(transactionTarget)
  }))
  try {
    for (const {target, method, replacement} of reads) target[method] = replacement
    return await operation()
  } finally {
    for (const {target, method, original} of reads) target[method] = original
  }
}

integration('le handler collecteur conserve les volumes hebdomadaires dans la vue graphique', async t => {
  await rollbackFixtures(async client => {
    const fixture = await createFixture(client)
    const admin = await client.user.create({data: {role: 'ADMIN'}})
    const owner = await client.user.create({data: {
      role: 'DECLARANT', declarant: {create: {declarantRole: 'PRELEVEUR', preleveurType: 'IRRIGANT'}}
    }})
    const collector = await client.user.create({data: {
      role: 'DECLARANT', declarant: {create: {declarantRole: 'COLLECTEUR'}}
    }})
    const exploitation = await client.declarantPointPrelevement.create({data: {
      declarantUserId: owner.id, pointPrelevementId: fixture.point.id, usageId: fixture.usage.id
    }})
    await client.declarantCollecteurExploitation.create({data: {
      collecteurUserId: collector.id, exploitationId: exploitation.id
    }})
    await createChunk(client, fixture, {preleveurUserId: owner.id, values: [{
      frequency: '1 year', periodStart: '2026-01-01T00:00:00Z', periodEnd: '2027-01-01T00:00:00Z', value: '3650'
    }]})

    await withHandlerTransaction(client, async () => {
      const query = {
        collecteurId: collector.id, metricTypeCode: 'volume', pointFlowType: 'PRELEVEMENT',
        temporalOperator: 'sum', aggregationFrequency: '1 week', startDate: '2026-01-01', endDate: '2026-09-28'
      }
      let detailed
      await getAggregatedSeriesHandler({user: admin, query}, {send(body) { detailed = body }})
      let chart
      await getAggregatedSeriesHandler({user: admin, query: {...query, view: 'chart'}}, {send(body) { chart = body }})

      t.deepEqual(chart.values, detailed.values)
      const {points, ...metadata} = detailed.metadata
      t.deepEqual(chart.metadata, metadata)
      t.deepEqual(points, [{id: fixture.point.id, name: fixture.point.name}])
      t.false(Object.hasOwn(chart, 'exactPeriods'))
      t.like(chart.metadata, {seriesCount: 1, valuesCount: 40, minDate: '2026-W01', maxDate: '2026-W40'})
      t.deepEqual(chart.values[0], {date: '2026-W01', value: 40})
      t.deepEqual(chart.values.at(-1), {date: '2026-W40', value: 10})
      t.is(chart.values.reduce((total, row) => total + row.value, 0), 2710)
    })
  })
})

integration('la présence de périodes METER supporte plusieurs lots de paramètres Prisma', async t => {
  await rollbackFixtures(async client => {
    const fixture = await createFixture(client)
    const prefix = randomUUID().slice(0, 24)
    // Prisma batches large IN filters. Keep one real match at each sorted end
    // so both batches find a row; the remaining IDs require no database writes.
    const chunkIds = Array.from({length: 32770}, (_, index) => `${prefix}${index.toString(16).padStart(12, '0')}`)
    for (const id of [chunkIds[0], chunkIds.at(-1)]) {
      await createChunk(client, fixture, {id, strategy: 'METER', values: [{
        periodStart: '2026-01-01T00:00:00Z', periodEnd: '2026-01-02T00:00:00Z', value: '10'
      }]})
    }
    const options = {
      metricTypeCode: 'volume', user: {role: 'ADMIN'}, pointIds: [fixture.point.id],
      startDate: '2026-01-01', endDate: '2026-09-28'
    }
    const matchingIds = [chunkIds[0], chunkIds.at(-1)]
    t.false(await hasExactMeterPeriods({...options, chunkIds: []}, {client}))
    t.true(await hasExactMeterPeriods({...options, chunkIds: [chunkIds[0]]}, {client}))
    t.true(await hasExactMeterPeriods({...options, chunkIds}, {client}))
    t.true(await hasExactMeterPeriods({...options, chunkIds: chunkIds.slice(1)}, {client}))
    t.false(await hasExactMeterPeriods({...options, chunkIds: chunkIds.slice(1, -1)}, {client}))
    t.false(await hasExactMeterPeriods({...options, chunkIds, user: {role: 'DECLARANT', id: randomUUID()}}, {client}))
    t.false(await hasExactMeterPeriods({...options, chunkIds: matchingIds,
      user: {role: 'INSTRUCTOR'}, pointIds: [randomUUID()]}, {client}))
    t.false(await hasExactMeterPeriods({...options, chunkIds: matchingIds,
      startDate: '2026-09-01', endDate: '2026-09-28'}, {client}))
  })
})

integration('les buckets directs conservent le calcul journalier pour toutes les mailles et fenêtres', async t => {
  await rollbackFixtures(async client => {
    const fixture = await createFixture(client)
    const cases = [
      ['GENERIC', '2020-01-01T00:00:00Z', '2027-01-01T00:00:00Z', '123456.7891'],
      ['GENERIC', '2024-02-28T12:00:00Z', '2024-03-02T06:00:00Z', '11'],
      ['GENERIC', '2025-12-28T23:59:30Z', '2026-01-05T00:00:30Z', '7'],
      ['METER', '2026-08-31T21:59:30Z', '2026-08-31T22:00:30Z', '10'],
      ['METER', '2025-12-31T22:59:30Z', '2025-12-31T23:00:30Z', '10'],
      ['METER', '2026-03-28T23:00:00Z', '2026-04-01T22:00:00Z', '95'],
      ['METER', '2026-10-24T22:00:00Z', '2026-10-26T23:00:00Z', '49'],
      ['METER', '2026-10-25T00:45:00Z', '2026-10-25T01:15:00Z', '3'],
      ['METER', '2026-08-31T21:59:59Z', '2026-08-31T22:00:01Z', '0.0002'],
      ['METER', '2026-08-31T21:59:30Z', '2026-08-31T22:00:00Z', '0']
    ]
    const chunks = []
    for (const [strategy, periodStart, periodEnd, value] of cases) {
      chunks.push(await createChunk(client, fixture, {strategy, values: [{periodStart, periodEnd, value}]}))
    }
    const windows = [
      {},
      {startDate: '2026-03-29', endDate: '2026-03-29'},
      {startDate: '2024-02-29', endDate: '2026-10-25'},
      {startDate: '2026-09-01'},
      {endDate: '2025-12-31'}
    ]
    for (const aggregationFrequency of ['1 day', '1 week', '1 month', '1 quarter', '1 year']) {
      for (const window of windows) {
        const options = {chunkIds: chunks.map(chunk => chunk.id), metricTypeCode: 'volume', aggregationFrequency,
          temporalOperator: 'sum', ...window, client}
        // The neutral spatial operator exercises the retained daily sum path.
        const reference = await getAggregatedValuesFromSql(options)
        const actual = await getAggregatedValuesFromSql({...options, spatialOperator: 'sum'})
        assertEquivalentValues(t, actual, reference, `${aggregationFrequency} ${JSON.stringify(window)}`)
      }
    }
    const exactMonth = await getAggregatedValuesFromSql({chunkIds: [chunks[3].id], metricTypeCode: 'volume',
      aggregationFrequency: '1 month', temporalOperator: 'sum', spatialOperator: 'sum', client})
    t.deepEqual(exactMonth, [{date: '2026-08', value: 5}, {date: '2026-09', value: 5}])
    const partialDay = await getAggregatedValuesFromSql({chunkIds: [chunks[5].id], metricTypeCode: 'volume',
      aggregationFrequency: '1 year', temporalOperator: 'sum', spatialOperator: 'sum',
      startDate: '2026-03-29', endDate: '2026-03-29', client})
    t.deepEqual(partialDay, [{date: '2026', value: 23}])
  })
})

integration('le scope minimal conserve comptes de séries, bénéficiaires METER et fallback historique', async t => {
  await rollbackFixtures(async client => {
    const fixture = await createFixture(client)
    const owner = await client.user.create({data: {role: 'DECLARANT', declarant: {create: {declarantRole: 'PRELEVEUR', preleveurType: 'IRRIGANT'}}}})
    const other = await client.user.create({data: {role: 'DECLARANT', declarant: {create: {declarantRole: 'PRELEVEUR', preleveurType: 'IRRIGANT'}}}})
    await client.declarantPointPrelevement.create({data: {declarantUserId: owner.id, pointPrelevementId: fixture.point.id,
      usageId: fixture.usage.id, status: 'EN_ACTIVITE', endDate: new Date('2026-01-01Z')}})
    const value = {periodStart: '2026-03-01Z', periodEnd: '2026-04-01Z', value: '10'}
    const own = await createChunk(client, fixture, {strategy: 'METER', preleveurUserId: owner.id, values: [value]})
    const foreign = await createChunk(client, fixture, {strategy: 'METER', preleveurUserId: other.id, values: [value]})
    const legacy = await createChunk(client, fixture, {values: [value, {...value, metricTypeCode: 'volume prélevé', unit: null, frequency: '1 day'}]})
    await createChunk(client, fixture, {status: 'REJECTED', values: [value]})
    for (const filter of [{user: {role: 'ADMIN'}}, {user: owner, preleveurId: owner.id}, {user: other}, {user: {role: 'INSTRUCTOR'}}]) {
      const options = {pointIds: [fixture.point.id], parameter: 'volume', startDate: '2026-03-15', endDate: '2026-03-20',
        includeOverlappingPeriods: true, ...filter}
      const detailed = await listSeries(options, {client})
      const compact = await getAggregationSeriesScope(options, {client})
      t.is(compact.seriesCount, detailed.length)
      t.deepEqual([...compact.chunkIds].sort(), [...new Set(detailed.map(series => series.computed.chunkId))].sort())
      if (filter.preleveurId) {
        t.deepEqual([...compact.chunkIds].sort(), [own.id, legacy.id].sort())
        t.false(compact.chunkIds.includes(foreign.id))
        t.is(compact.seriesCount, 3)
      }
    }
  })
})
