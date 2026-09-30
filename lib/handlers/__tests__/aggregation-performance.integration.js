/* eslint-disable no-await-in-loop -- Synthetic fixtures share a rollback-only, guarded transaction. */
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'

import {prisma} from '../../../db/prisma.js'
import {getAggregationSeriesScope, getMeterSeriesChunkScope} from '../../models/series.js'
import {ingestMeterBatch} from '../../services/meter-ingestion.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {getAuthorizedCumulativeAggregation, getAggregatedValuesFromSql, hasExactMeterPeriods} from '../series-aggregation.js'
import {buildAggregationOptionsPayload, listAggregationOptionGroups} from '../series-aggregation-options.js'

const integration = process.env.METER_INTEGRATION_TESTS === '1' ? test.serial : test.skip

test.before(() => {
  if (process.env.METER_INTEGRATION_TESTS === '1') requireDisposableDatabase()
})
test.after.always(async () => {
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

async function rollbackFixtures(operation) {
  const rollback = new Error('ROLLBACK_AUTHORIZED_AGGREGATION_FIXTURES')
  try {
    await prisma.$transaction(async client => {
      const key = randomUUID()
      const usages = []
      for (const label of ['Irrigation synthétique', 'Industrie synthétique']) usages.push(await client.sandreWaterUse.create({
        data: {code: randomUUID().slice(0, 15), kind: 'USAGE', label}
      }))
      const users = []
      for (const declarantRole of ['PRELEVEUR', 'PRELEVEUR', 'COLLECTEUR', 'COLLECTEUR', 'PRELEVEUR']) {
        users.push(await client.user.create({data: {role: 'DECLARANT', declarant: {create: {
          declarantRole, preleveurType: declarantRole === 'PRELEVEUR' ? 'IRRIGANT' : null
        }}}, include: {declarant: true}}))
      }
      const [owner, other, collector, otherCollector, outsider] = users
      const admin = await client.user.create({data: {role: 'ADMIN'}})
      const points = []
      for (const flowType of ['PRELEVEMENT', 'PRELEVEMENT', 'REJET']) points.push(await client.pointPrelevement.create({
        data: {name: `Agrégation synthétique ${key} ${points.length}`, flowType, waterBodyType: 'SUPERFICIELLE'}
      }))
      const exploitations = []
      for (const [point, user, usage] of [[points[0], owner, usages[0]], [points[0], other, usages[1]], [points[1], owner, usages[0]]]) {
        exploitations.push(await client.declarantPointPrelevement.create({data: {
          pointPrelevementId: point.id, declarantUserId: user.id, usageId: usage.id, status: 'EN_ACTIVITE'
        }}))
      }
      for (const [user, exploitation] of [[collector, exploitations[0]], [otherCollector, exploitations[1]]]) {
        await client.declarantCollecteurExploitation.create({data: {collecteurUserId: user.id, exploitationId: exploitation.id}})
      }
      const source = await client.source.create({data: {type: 'API', status: 'COMPLETED'}})
      await operation(client, {key, usages, owner, other, collector, otherCollector, outsider, admin, points, exploitations, source})
      throw rollback
    }, {timeout: 90000})
  } catch (error) {
    if (error !== rollback) throw error
  }
}

function volume(periodStart, periodEnd, value, overrides = {}) {
  return {metricTypeCode: 'volume', unit: 'm³', frequency: '1 month',
    periodStart: new Date(periodStart), periodEnd: new Date(periodEnd), value, ...overrides}
}

async function createChunk(client, fixture, values, overrides = {}) {
  return client.chunk.create({data: {
    sourceId: fixture.source.id, pointPrelevementId: fixture.points[0].id, usageId: fixture.usages[0].id,
    instructionStatus: 'VALIDATED', minDate: new Date('2020-01-01Z'), maxDate: new Date('2027-01-01Z'),
    chunkValues: {create: values}, ...overrides
  }})
}

async function publishSharedMeter(client, fixture) {
  const meter = await client.compteur.create({data: {serialNumber: fixture.key}})
  const snapshot = [40, 30, 30].map((percentage, index) => ({key: `${fixture.key}-${index}`, percentage: String(percentage), inScope: true}))
  await client.meterStream.create({data: {provider: 'aggregation-performance', scope: fixture.key, externalId: fixture.key,
    compteurId: meter.id, enabled: true, activatedAt: new Date('2026-01-01Z'),
    allocationSnapshot: snapshot, allocationSnapshotValidated: true}})
  for (const [index, exploitation] of fixture.exploitations.entries()) await client.meterAllocation.create({data: {
    sourceId: snapshot[index].key, provider: 'aggregation-performance', scope: fixture.key,
    compteurId: meter.id, exploitationId: exploitation.id,
    versions: {create: {version: 1, enabled: true, percentage: snapshot[index].percentage, startDate: new Date('2026-01-01Z'),
      metadata: {allocationSnapshot: snapshot, allocationSnapshotValidated: true}}}
  }})
  await ingestMeterBatch({provider: 'aggregation-performance', scope: fixture.key, batchId: fixture.key,
    mode: 'LIVE', complete: true, fetchedAt: '2026-03-30T10:00:00Z',
    windowStart: '2026-03-28T00:00:00Z', windowEnd: '2026-03-30T00:00:00Z', readings: [
      {externalId: fixture.key, observedAt: '2026-03-28T23:00:00Z', index: '1000', status: 'VALID'},
      {externalId: fixture.key, observedAt: '2026-03-29T22:00:00Z', index: '1100', status: 'VALID'}
    ]}, {user: fixture.admin}, {client: {$transaction: action => action(client)}})
  return client.meterPublication.findFirstOrThrow({where: {compteurId: meter.id}})
}

// The reference deliberately keeps the old Prisma scope and separate value /
// existence reads. It must not reuse the optimized SQL authorization helper.
async function assertEquivalent(t, client, fixture, changes = {}) {
  const options = {pointIds: [fixture.points[0].id], user: fixture.admin, metricTypeCode: 'volume',
    aggregationFrequency: '1 week', ...changes}
  const scope = await getAggregationSeriesScope({...options, parameter: options.metricTypeCode,
    flowType: options.pointFlowType, includeOverlappingPeriods: true}, {client})
  const values = await getAggregatedValuesFromSql({...options, ...scope, client, spatialOperator: 'sum', temporalOperator: 'sum'})
  const exactVolumesEstimated = await hasExactMeterPeriods({...options, ...scope}, {client})
  const actual = await getAuthorizedCumulativeAggregation({...options, client})
  t.is(actual.seriesCount, scope.seriesCount)
  t.is(actual.exactVolumesEstimated, exactVolumesEstimated)
  t.deepEqual(actual.values.map(row => row.date), values.map(row => row.date))
  for (const [index, row] of actual.values.entries()) {
    const reference = values[index].value
    t.true(Math.abs(row.value - reference) <= Math.max(1e-9, Math.abs(reference) * 1e-12), `${row.date}: ${row.value} / ${reference}`)
  }
  return actual
}

// Options historically scope ordinary chunks at point level even with a
// preleveur filter. Resolve the legacy authorization independently, then use
// its original per-chunk grouping and Paris date conversion as the reference.
async function assertEquivalentOptions(t, client, fixture, changes = {}) {
  const options = {pointIds: [fixture.points[0].id], user: fixture.admin, ...changes}
  const chunks = await client.chunk.findMany({where: {
    pointPrelevementId: {in: options.pointIds}, source: {status: 'COMPLETED'},
    instructionStatus: {in: ['PENDING', 'VALIDATED', 'AUTOMATICALLY_VALIDATED']},
    ...(options.sourceId ? {sourceId: options.sourceId} : {}),
    ...(options.exploitationId ? {exploitationId: options.exploitationId} : {}),
    AND: getMeterSeriesChunkScope(options)
  }, select: {id: true}})
  const rows = await client.$queryRaw`
    SELECT cv."metricTypeCode", cv.unit, COALESCE(c."flowType", point."flowType")::text AS "flowType",
      min(CASE WHEN c."calculationStrategy" = 'METER' AND cv.frequency = 'irregular'
        THEN cv."periodStart" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Paris' ELSE cv."periodStart" END) AS "minPeriodStart",
      min(CASE WHEN c."calculationStrategy" = 'METER' AND cv.frequency = 'irregular'
        THEN cv."periodEnd" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Paris' ELSE cv."periodEnd" END) AS "minPeriodEnd",
      max(CASE WHEN c."calculationStrategy" = 'METER' AND cv.frequency = 'irregular'
        THEN cv."periodEnd" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Paris' ELSE cv."periodEnd" END) AS "maxPeriodEnd",
      1::int AS "seriesCount"
    FROM "ChunkValue" cv JOIN "Chunk" c ON c.id = cv."chunkId"
    LEFT JOIN "PointPrelevement" point ON point.id = c."pointPrelevementId"
    WHERE c.id = ANY(${chunks.map(chunk => chunk.id)}::uuid[])
    GROUP BY c.id, cv."metricTypeCode", cv.unit, COALESCE(c."flowType", point."flowType")
    ORDER BY cv."metricTypeCode", cv.unit NULLS FIRST, COALESCE(c."flowType", point."flowType") NULLS FIRST
  `
  const actualGroups = await listAggregationOptionGroups({...options, client, includeExploitationIndexes: false})
  const payload = groupedBySeries => buildAggregationOptionsPayload({groupedBySeries, resolvedPoints: [], view: 'chart'})
  const actual = payload(actualGroups)
  t.deepEqual(actual, payload(rows))
  const summaryGroups = await listAggregationOptionGroups({...options, client, includeExploitationIndexes: false, detail: 'summary'})
  t.deepEqual(payload(summaryGroups), {parameters: actual.parameters.filter(parameter => parameter.name !== 'index')})
  return actual
}

integration('agrégation autorisée : bénéficiaires, usages et filtres collecteurs restent strictement intersectés', async t => {
  await rollbackFixtures(async (client, f) => {
    const publication = await publishSharedMeter(client, f)
    const base = {sourceId: publication.sourceId, startDate: '2026-03-29', endDate: '2026-03-29'}
    const cases = [
      [{user: f.admin}, 70, 2], [{user: {role: 'INSTRUCTOR'}}, 70, 2],
      [{user: f.owner}, 40, 1], [{user: f.other}, 30, 1],
      [{user: f.collector}, 40, 1], [{user: f.otherCollector}, 30, 1],
      [{user: f.outsider}, 0, 0],
      [{user: f.admin, collecteurId: f.collector.id}, 40, 1],
      [{user: f.collector, collecteurId: f.otherCollector.id}, 0, 0],
      [{user: f.otherCollector, collecteurId: f.collector.id}, 0, 0],
      [{user: f.other, collecteurId: f.collector.id}, 0, 0],
      [{user: f.owner, preleveurId: f.other.id}, 0, 0],
      [{user: f.admin, preleveurId: f.owner.id, collecteurId: f.collector.id}, 40, 1],
      [{user: f.admin, exploitationId: f.exploitations[1].id}, 30, 1],
      [{user: f.collector, exploitationId: f.exploitations[1].id}, 0, 0]
    ]
    for (const [filter, expectedVolume, expectedCount] of cases) {
      const result = await assertEquivalent(t, client, f, {...base, ...filter})
      t.is(result.seriesCount, expectedCount)
      t.is(result.values.reduce((sum, row) => sum + row.value, 0), expectedVolume)
      const options = await assertEquivalentOptions(t, client, f, {sourceId: publication.sourceId, ...filter})
      t.is(options.parameters.reduce((sum, item) => sum + item.seriesCount, 0), expectedCount)
    }
    const otherTerritory = await assertEquivalent(t, client, f, {...base, user: {role: 'INSTRUCTOR'}, pointIds: [f.points[1].id]})
    t.deepEqual(otherTerritory.values, [{date: '2026-W13', value: 30}])
    const empty = await assertEquivalent(t, client, f, {...base, sourceId: undefined, pointIds: []})
    t.deepEqual(empty, {seriesCount: 0, exactVolumesEstimated: false, values: []})
  })
})

integration('agrégation autorisée : une délégation révoquée cesse immédiatement de donner accès', async t => {
  await rollbackFixtures(async (client, f) => {
    const publication = await publishSharedMeter(client, f)
    const filter = {sourceId: publication.sourceId, user: f.collector}
    t.is((await assertEquivalent(t, client, f, filter)).seriesCount, 1)
    await client.declarantCollecteurExploitation.deleteMany({where: {collecteurUserId: f.collector.id}})
    t.deepEqual(await assertEquivalent(t, client, f, filter), {seriesCount: 0, exactVolumesEstimated: false, values: []})
    t.deepEqual(await assertEquivalentOptions(t, client, f, filter), {parameters: []})
    t.deepEqual(await assertEquivalent(t, client, f, {...filter, user: f.admin, collecteurId: f.collector.id}),
      {seriesCount: 0, exactVolumesEstimated: false, values: []})
    t.is((await assertEquivalent(t, client, f, {...filter, user: f.owner})).seriesCount, 1)
  })
})

integration('agrégation autorisée : une contribution hors fenêtre ou hors métrique reste une preuve au niveau du chunk', async t => {
  await rollbackFixtures(async (client, f) => {
    const publication = await publishSharedMeter(client, f)
    const own = await client.chunk.findFirstOrThrow({where: {
      sourceId: publication.sourceId, exploitationId: f.exploitations[0].id
    }})
    // Only the native March volume carries a contribution. These additional
    // synthetic values deliberately exercise the existing chunk-level ACL;
    // narrowing the grant to candidate value IDs would wrongly hide them.
    const januaryValue = await client.chunkValue.create({data: {chunkId: own.id,
      ...volume('2026-01-01Z', '2026-02-01Z', 11)}})
    const differentMetric = await client.chunkValue.create({data: {chunkId: own.id,
      ...volume('2026-03-01Z', '2026-04-01Z', 17, {metricTypeCode: 'volume restitué'})}})
    t.is(await client.meterVolumeContribution.count({where: {
      chunkValueId: {in: [januaryValue.id, differentMetric.id]}
    }}), 0)

    for (const [changes, expected] of [
      [{metricTypeCode: 'volume', startDate: '2026-01-01', endDate: '2026-01-31'}, [{date: '2026-01', value: 11}]],
      [{metricTypeCode: 'volume restitué', startDate: '2026-03-01', endDate: '2026-03-31'}, [{date: '2026-03', value: 17}]]
    ]) {
      const scope = {sourceId: publication.sourceId, aggregationFrequency: '1 month', ...changes}
      const allowed = await assertEquivalent(t, client, f, {...scope, user: f.collector})
      t.is(allowed.seriesCount, 1)
      t.deepEqual(allowed.values, expected)
      const denied = await assertEquivalent(t, client, f, {...scope, user: f.otherCollector})
      t.deepEqual(denied, {seriesCount: 0, exactVolumesEstimated: false, values: []})
      const intersection = await assertEquivalent(t, client, f, {...scope,
        user: f.collector, collecteurId: f.otherCollector.id})
      t.deepEqual(intersection, {seriesCount: 0, exactVolumesEstimated: false, values: []})
    }
  })
})

integration('agrégation autorisée : rattachement publié immuable et aucune délégation sans contribution', async t => {
  await rollbackFixtures(async (client, f) => {
    const publication = await publishSharedMeter(client, f)
    const own = await client.chunk.findFirstOrThrow({where: {sourceId: publication.sourceId, exploitationId: f.exploitations[0].id}})
    for (const exploitationId of [null, f.exploitations[1].id]) {
      // Current schema protects the denormalized scope too. Assert that guard
      // rather than disabling it to manufacture a historical inconsistency.
      await client.$executeRawUnsafe('SAVEPOINT immutable_meter_scope')
      const error = await t.throwsAsync(client.chunk.update({where: {id: own.id}, data: {exploitationId}}))
      await client.$executeRawUnsafe('ROLLBACK TO SAVEPOINT immutable_meter_scope')
      await client.$executeRawUnsafe('RELEASE SAVEPOINT immutable_meter_scope')
      t.regex(error.message, exploitationId === null
        ? /Physical meter publication scope is immutable/
        : /The exploitation does not match the chunk beneficiary and point/)
      for (const [user, expected] of [[f.collector, 40], [f.otherCollector, 30]]) {
        const result = await assertEquivalent(t, client, f, {sourceId: publication.sourceId, user})
        t.is(result.values.reduce((sum, row) => sum + row.value, 0), expected)
        await assertEquivalentOptions(t, client, f, {sourceId: publication.sourceId, user})
      }
    }
    await createChunk(client, f, [volume('2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z', 999,
      {frequency: 'irregular', valueKind: 'COMPUTED'})], {calculationStrategy: 'METER',
      exploitationId: f.exploitations[0].id, preleveurUserId: f.owner.id})
    const unpublished = {sourceId: f.source.id, user: f.collector}
    t.deepEqual(await assertEquivalent(t, client, f, unpublished), {seriesCount: 0, exactVolumesEstimated: false, values: []})
    t.deepEqual(await assertEquivalentOptions(t, client, f, unpublished), {parameters: []})
  })
})

integration('agrégation autorisée : mailles, fenêtres partielles et heures été/hiver restent identiques', async t => {
  await rollbackFixtures(async (client, f) => {
    for (const [strategy, start, end, value] of [
      ['GENERIC', '2024-02-28T12:00:00Z', '2026-11-01T06:00:00Z', '123456.7891'],
      ['GENERIC', '2025-12-28T23:59:30Z', '2026-01-05T00:00:30Z', '7'],
      ['METER', '2026-03-28T23:00:00Z', '2026-04-01T22:00:00Z', '95'],
      ['METER', '2026-10-24T22:00:00Z', '2026-10-26T23:00:00Z', '49'],
      ['METER', '2026-10-25T00:45:00Z', '2026-10-25T01:15:00Z', '3'],
      ['METER', '2026-08-31T21:59:59Z', '2026-08-31T22:00:01Z', '0.0002'],
      ['METER', '2026-08-31T21:59:30Z', '2026-08-31T22:00:00Z', '0']
    ]) await createChunk(client, f, [volume(start, end, value, {
      frequency: strategy === 'METER' ? 'irregular' : '1 month', valueKind: strategy === 'METER' ? 'COMPUTED' : 'DECLARED'
    })], {calculationStrategy: strategy})
    for (const aggregationFrequency of ['1 day', '1 week', '1 month', '1 quarter', '1 year']) {
      for (const dates of [{}, {startDate: '2026-03-29', endDate: '2026-03-29'},
        {startDate: '2026-10-25', endDate: '2026-10-25'}, {startDate: '2026-09-01'}, {endDate: '2025-12-31'}]) {
        await assertEquivalent(t, client, f, {aggregationFrequency, ...dates})
      }
    }
  })
})

integration('agrégation autorisée : alias, unités et fréquences conservent le nombre de séries, les zéros et le vide', async t => {
  await rollbackFixtures(async (client, f) => {
    const value = volume('2026-01-01Z', '2026-02-01Z', 0)
    await createChunk(client, f, [value, {...value, unit: null}, {...value, unit: 'm3'},
      {...value, frequency: '1 day'}, {...value, metricTypeCode: 'volume prélevé'},
      volume('2026-02-01Z', '2026-03-01Z', 0)])
    const actual = await assertEquivalent(t, client, f, {startDate: '2026-01-01', endDate: '2026-01-31'})
    t.is(actual.seriesCount, 5)
    t.true(actual.values.length > 0)
    t.true(actual.values.every(row => row.value === 0))
    await assertEquivalentOptions(t, client, f)
    t.deepEqual(await assertEquivalent(t, client, f, {startDate: '2027-01-01', endDate: '2027-01-31'}),
      {seriesCount: 0, exactVolumesEstimated: false, values: []})
    const emptySource = await client.source.create({data: {type: 'API', status: 'COMPLETED'}})
    await createChunk(client, f, [], {sourceId: emptySource.id})
    t.deepEqual(await assertEquivalent(t, client, f, {sourceId: emptySource.id}), {seriesCount: 0, exactVolumesEstimated: false, values: []})
    // Zero-duration rows cannot be inserted: the database requires end >
    // start. Exercise its smallest representable positive duration instead.
    const shortDuration = await client.source.create({data: {type: 'API', status: 'COMPLETED'}})
    await createChunk(client, f, [volume('2026-01-15T00:00:00.000Z', '2026-01-15T00:00:00.001Z', 10)], {sourceId: shortDuration.id})
    const shortest = await assertEquivalent(t, client, f, {sourceId: shortDuration.id})
    t.is(shortest.seriesCount, 1)
    t.deepEqual(shortest.values, [{date: '2026-W03', value: 10}])
  })
})

integration('agrégation autorisée : le marqueur de volumes estimés conserve les périodes COMPUTED non irrégulières', async t => {
  await rollbackFixtures(async (client, f) => {
    await createChunk(client, f, [
      volume('2026-03-29T12:00:00Z', '2026-03-29T13:00:00Z', 10, {frequency: '1 day'}),
      // Selected series uses UTC for this regular frequency, while the exact
      // period marker intentionally retains its historical Paris bounds.
      volume('2026-03-28T23:00:00Z', '2026-03-29T00:00:00Z', 5, {frequency: '1 day', valueKind: 'COMPUTED'})
    ], {calculationStrategy: 'METER'})
    const actual = await assertEquivalent(t, client, f, {startDate: '2026-03-29', endDate: '2026-03-29', aggregationFrequency: '1 day'})
    t.true(actual.exactVolumesEstimated)
    t.is(actual.seriesCount, 1)
    t.deepEqual(actual.values, [{date: '2026-03-29', value: 10}])
    const declaredOnly = await client.source.create({data: {type: 'API', status: 'COMPLETED'}})
    await createChunk(client, f, [volume('2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z', 23,
      {frequency: 'irregular'})], {sourceId: declaredOnly.id, calculationStrategy: 'METER'})
    const declared = await assertEquivalent(t, client, f, {sourceId: declaredOnly.id, startDate: '2026-03-29', endDate: '2026-03-29'})
    t.false(declared.exactVolumesEstimated)
  })
})

integration('agrégation autorisée : sources incomplètes, rejets, flux et fallback préleveur historique restent inchangés', async t => {
  await rollbackFixtures(async (client, f) => {
    const value = volume('2026-01-01Z', '2026-02-01Z', 31)
    // A closed exploitation still establishes the historical fallback for
    // ordinary chunks whose beneficiary was not recorded at ingestion time.
    await client.declarantPointPrelevement.update({where: {id: f.exploitations[0].id}, data: {endDate: new Date('2025-01-01Z')}})
    await createChunk(client, f, [value])
    await createChunk(client, f, [value], {preleveurUserId: f.owner.id})
    await createChunk(client, f, [value], {preleveurUserId: f.other.id})
    await createChunk(client, f, [value], {instructionStatus: 'REJECTED'})
    for (const status of ['PENDING', 'PROCESSING', 'FAILED']) {
      const source = await client.source.create({data: {type: 'API', status}})
      await createChunk(client, f, [value], {sourceId: source.id})
    }
    for (const status of ['PENDING', 'AUTOMATICALLY_VALIDATED']) await createChunk(client, f, [value], {instructionStatus: status})
    await createChunk(client, f, [value], {flowType: 'REJET'})
    await createChunk(client, f, [value], {pointPrelevementId: f.points[2].id})
    const own = await assertEquivalent(t, client, f, {preleveurId: f.owner.id, pointFlowType: 'PRELEVEMENT', aggregationFrequency: '1 month'})
    t.is(own.seriesCount, 4)
    t.deepEqual(own.values, [{date: '2026-01', value: 124}])
    for (const pointFlowType of ['PRELEVEMENT', 'REJET']) await assertEquivalent(t, client, f, {
      pointIds: f.points.map(point => point.id), pointFlowType
    })
    for (const filter of [{user: f.owner}, {user: f.collector}, {preleveurId: f.owner.id}, {collecteurId: f.collector.id}]) {
      await assertEquivalent(t, client, f, filter)
      await assertEquivalentOptions(t, client, f, filter)
    }
  })
})

integration('agrégation autorisée : le flux explicite du chunk prime sur celui du point, sinon le point fait référence', async t => {
  await rollbackFixtures(async (client, f) => {
    for (const [point, flowType, quantity] of [
      [f.points[0], null, 11], [f.points[0], 'REJET', 17],
      [f.points[2], null, 23], [f.points[2], 'PRELEVEMENT', 31]
    ]) {
      await createChunk(client, f, [volume('2026-01-01Z', '2026-02-01Z', quantity)], {
        pointPrelevementId: point.id, flowType
      })
    }
    for (const [pointFlowType, expected] of [['PRELEVEMENT', 42], ['REJET', 40]]) {
      const result = await assertEquivalent(t, client, f, {pointIds: f.points.map(point => point.id),
        pointFlowType, aggregationFrequency: '1 month'})
      t.is(result.seriesCount, 2)
      t.deepEqual(result.values, [{date: '2026-01', value: expected}])
    }
  })
})
