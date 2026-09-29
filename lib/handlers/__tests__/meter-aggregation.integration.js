/* eslint-disable no-await-in-loop -- Independent synthetic fixtures are confined to one rollback-only transaction. */
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {getSeriesById, getSeriesValuesInRange, listSeries} from '../../models/series.js'
import {ingestMeterBatch} from '../../services/meter-ingestion.js'
import {assertResolvedPointsAccess, getAggregatedValuesFromSql, getExactMeterPeriods, scopeResolvedPointsForAggregation} from '../series-aggregation.js'
import {buildAggregationOptionsPayload, listAggregationOptionGroups} from '../series-aggregation-options.js'
import {getVolumesByUsage} from '../dashboard.js'

const integration = process.env.METER_INTEGRATION_TESTS === '1' ? test.serial : test.skip
test.before(() => { if (process.env.METER_INTEGRATION_TESTS === '1') requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function withFixture(operation) {
  const rollback = new Error('ROLLBACK_METER_AGGREGATION')
  try {
    await prisma.$transaction(async client => {
      const key = randomUUID()
      const usage = await client.sandreWaterUse.create({data: {code: `agg${key.slice(0, 8)}`, label: 'Usage agrégation synthétique', kind: 'USAGE'}})
      const users = []
      for (const role of ['PRELEVEUR', 'PRELEVEUR', 'COLLECTEUR', 'PRELEVEUR']) users.push(await client.user.create({
        data: {role: 'DECLARANT', declarant: {create: {declarantRole: role, preleveurType: role === 'COLLECTEUR' ? null : 'IRRIGANT'}}}, include: {declarant: true}
      }))
      const [owner, other, collector, outsider] = users
      const admin = await client.user.create({data: {role: 'ADMIN'}})
      const points = []
      const zones = []
      for (let index = 0; index < 2; index++) {
        const point = await client.pointPrelevement.create({data: {name: `Synthetic aggregation ${key}-${index}`, flowType: 'PRELEVEMENT', waterBodyType: 'SUPERFICIELLE'}})
        points.push(point)
        const zoneId = randomUUID()
        await client.$executeRaw`INSERT INTO "Zone" (id,code,type,name,coordinates,"createdAt","updatedAt")
          VALUES (${zoneId}::uuid, ${`${key}-${index}`}, 'SAGE', 'Zone synthétique',
          ST_Multi(ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))',4326)), CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`
        zones.push(zoneId)
        await client.pointPrelevementZone.create({data: {pointPrelevementId: point.id, zoneId}})
      }
      const exploitations = []
      for (const [pointIndex, user] of [[0, owner], [0, other], [1, owner]]) exploitations.push(await client.declarantPointPrelevement.create({
        data: {pointPrelevementId: points[pointIndex].id, declarantUserId: user.id, usageId: usage.id, status: 'EN_ACTIVITE'}
      }))
      await client.declarantCollecteurExploitation.create({data: {collecteurUserId: collector.id, exploitationId: exploitations[0].id}})
      const meter = await client.compteur.create({data: {serialNumber: key}})
      const snapshot = [40, 30, 30].map((percentage, index) => ({key: `${key}-${index}`, percentage: String(percentage), inScope: true}))
      await client.meterStream.create({data: {provider: 'synthetic-aggregation', scope: key, externalId: key, compteurId: meter.id,
        enabled: true, activatedAt: new Date('2026-01-01Z'), allocationSnapshot: snapshot, allocationSnapshotValidated: true}})
      for (const [index, exploitation] of exploitations.entries()) await client.meterAllocation.create({data: {
        sourceId: snapshot[index].key, provider: 'synthetic-aggregation', scope: key, compteurId: meter.id, exploitationId: exploitation.id,
        versions: {create: {version: 1, enabled: true, percentage: snapshot[index].percentage, startDate: new Date('2026-01-01Z'),
          metadata: {allocationSnapshot: snapshot, allocationSnapshotValidated: true}}}
      }})
      await ingestMeterBatch({provider: 'synthetic-aggregation', scope: key, batchId: key, mode: 'LIVE', complete: true,
        fetchedAt: '2026-03-30T10:00:00Z', windowStart: '2026-03-28T00:00:00Z', windowEnd: '2026-03-30T00:00:00Z', readings: [
          {externalId: key, observedAt: '2026-03-28T23:00:00Z', index: '1000', status: 'VALID'},
          {externalId: key, observedAt: '2026-03-29T22:00:00Z', index: '1100', status: 'VALID'}
        ]}, {user: admin}, {client: {$transaction: action => action(client)}})
      const publication = await client.meterPublication.findFirstOrThrow({where: {compteurId: meter.id}})
      const chunks = await client.chunk.findMany({where: {sourceId: publication.sourceId}})
      await operation(client, {owner, other, collector, outsider, admin, points, zones, usage, publication, chunks, meter})
      throw rollback
    }, {timeout: 30000})
  } catch (error) { if (error !== rollback) throw error }
}

async function aggregate(client, chunkIds, options = {}) {
  return getAggregatedValuesFromSql({client, chunkIds, metricTypeCode: 'volume',
    temporalOperator: 'sum', spatialOperator: 'sum', aggregationFrequency: '1 day', ...options})
}

integration('parts METER : courbes, options et périodes exactes suivent le bénéficiaire et la délégation à une seule exploitation', async t => {
  await withFixture(async (client, f) => {
    const pointIds = [f.points[0].id]
    const scope = {sourceId: f.publication.sourceId, pointIds, parameter: 'volume', startDate: '2026-03-29', endDate: '2026-03-29', includeOverlappingPeriods: true}
    for (const [user, expected, count] of [[f.owner, 40, 1], [f.other, 30, 1], [f.collector, 40, 1], [f.admin, 70, 2]]) {
      await assertResolvedPointsAccess(user, [{id: pointIds[0]}], [], {client})
      const series = await listSeries({...scope, user}, {client})
      t.is(series.length, count)
      t.true(series.every(row => row.minDate === '2026-03-29' && row.maxDate === '2026-03-29'))
      t.deepEqual(await aggregate(client, series.map(row => row.computed.chunkId), scope), [{date: '2026-03-29', value: expected}])
      const groups = await listAggregationOptionGroups({client, pointIds, sourceId: scope.sourceId, user})
      const options = buildAggregationOptionsPayload({groupedBySeries: groups, resolvedPoints: []})
      t.is(options.parameters[0].seriesCount, count)
      t.is(options.parameters[0].minDate, '2026-03-29')
      t.is(options.parameters[0].maxDate, '2026-03-29')
      // Even an accidentally broad chunk list must not leak exact periods.
      const exact = await getExactMeterPeriods({client, chunkIds: f.chunks.filter(row => pointIds.includes(row.pointPrelevementId)).map(row => row.id),
        user, pointIds, metricTypeCode: 'volume', startDate: scope.startDate, endDate: scope.endDate})
      t.is(exact.reduce((sum, row) => sum + Number(row.value), 0), expected)
    }
    for (const request of [{user: f.owner, preleveurId: f.other.id}, {user: f.other, collecteurId: f.collector.id}]) {
      t.deepEqual(await listSeries({...scope, ...request}, {client}), [])
      t.deepEqual(await listAggregationOptionGroups({client, pointIds, sourceId: scope.sourceId, ...request}), [])
    }
    const delegated = await listSeries({...scope, pointIds: f.points.map(point => point.id), user: f.admin, collecteurId: f.collector.id}, {client})
    t.is(delegated.length, 1)
    t.deepEqual(await aggregate(client, delegated.map(row => row.computed.chunkId)), [{date: '2026-03-29', value: 40}])
    t.is((await t.throwsAsync(assertResolvedPointsAccess(f.outsider, [{id: pointIds[0]}], [], {client}))).status, 403)
    const instructor = {role: 'INSTRUCTOR'}
    const allowed = await assertResolvedPointsAccess(instructor, f.points.map(point => ({id: point.id})), [f.zones[0]], {client, allowPartialInstructorScope: true})
    t.deepEqual(allowed.map(point => point.id), pointIds)
    t.is((await listSeries({...scope, user: instructor}, {client})).length, 2)
    // /series?sourceId=... has no point filter: its separate meter permission
    // scope must still exclude the other territory without changing GENERIC.
    const sourceOnly = await listSeries({sourceId: scope.sourceId, parameter: 'volume', user: instructor, meterPointIds: pointIds}, {client})
    t.is(sourceOnly.length, 2)
    t.true(sourceOnly.every(row => row.pointPrelevement === pointIds[0]))
    const metadata = await getSeriesById(sourceOnly[0].id, client)
    t.is(metadata.minDate, '2026-03-29')
    t.is(metadata.maxDate, '2026-03-29')
    const raw = await getSeriesValuesInRange(sourceOnly[0].id, {startDate: '2026-03-29', endDate: '2026-03-29'}, client)
    t.is(raw.length, 1)
    t.is(raw[0].date, '2026-03-29')
    t.is(raw[0].periodStart.toISOString(), '2026-03-28T23:00:00.000Z')
    t.is(raw[0].periodEnd.toISOString(), '2026-03-29T22:00:00.000Z')
    t.deepEqual(await getExactMeterPeriods({client, chunkIds: f.chunks.map(row => row.id), user: instructor, pointIds,
      metricTypeCode: 'volume'}).then(rows => rows.map(row => row.pointPrelevementId)), [pointIds[0], pointIds[0]])
  })
})

integration('le contrat point-level GENERIC reste inchangé alors que METER se limite aux parts autorisées', async t => {
  await withFixture(async (client, f) => {
    const ordinary = await client.source.create({data: {type: 'API', status: 'COMPLETED', chunks: {create: {
      pointPrelevementId: f.points[0].id, preleveurUserId: f.other.id, usageId: f.usage.id, instructionStatus: 'VALIDATED',
      minDate: new Date('2026-02-01Z'), maxDate: new Date('2026-02-02Z'), chunkValues: {create: {
        periodStart: new Date('2026-02-01Z'), periodEnd: new Date('2026-02-02Z'), metricTypeCode: 'volume', frequency: '1 day', value: 9
      }}
    }}}})
    const series = await listSeries({user: f.owner, pointIds: [f.points[0].id], parameter: 'volume'}, {client})
    t.is(series.filter(row => row.calculationStrategy === 'METER').length, 1)
    t.true(series.some(row => row.computed.sourceId === ordinary.id && row.computed.preleveur === f.other.id))
    const options = await listAggregationOptionGroups({client, user: f.owner, pointIds: [f.points[0].id]})
    t.is(options.reduce((sum, row) => sum + row.seriesCount, 0), 2)
  })
})

integration('sourceId seul : une publication METER multizones est intersectée, jamais les sources ordinaires ou mixtes ni les points explicites', async t => {
  await withFixture(async (client, f) => {
    const user = {role: 'INSTRUCTOR'}
    const scope = {client, user, sourceId: f.publication.sourceId,
      resolvedPoints: f.points.map(point => ({id: point.id})), permittedZoneIds: [f.zones[0]]}
    const allowed = await scopeResolvedPointsForAggregation(scope)
    const pointIds = allowed.map(point => point.id)
    t.deepEqual(pointIds, [f.points[0].id])
    const series = await listSeries({user, sourceId: scope.sourceId, pointIds, parameter: 'volume'}, {client})
    t.is(series.length, 2)
    t.deepEqual(await aggregate(client, series.map(row => row.computed.chunkId)), [{date: '2026-03-29', value: 70}])
    const groups = await listAggregationOptionGroups({client, user, sourceId: scope.sourceId, pointIds})
    t.is(groups.reduce((count, row) => count + row.seriesCount, 0), 2)
    const own = await listSeries({user: f.owner, sourceId: scope.sourceId, pointIds, parameter: 'volume'}, {client})
    t.deepEqual(await aggregate(client, own.map(row => row.computed.chunkId)), [{date: '2026-03-29', value: 40}])
    const none = await scopeResolvedPointsForAggregation({...scope, permittedZoneIds: []})
    t.deepEqual(none, [])
    t.deepEqual(await listAggregationOptionGroups({client, user, sourceId: scope.sourceId, pointIds: []}), [])
    t.deepEqual(await listSeries({user, sourceId: scope.sourceId, pointIds: [], parameter: 'volume'}, {client}), [])
    t.is((await t.throwsAsync(scopeResolvedPointsForAggregation({...scope, pointIdsStr: f.points.map(point => point.id).join(',')}))).status, 403)

    // Metadata or even a METER-labelled chunk cannot impersonate a physical
    // publication. Ordinary and genuinely mixed sources retain all-or-none.
    const ordinary = await client.source.create({data: {type: 'API', status: 'COMPLETED', metadata: {calculationStrategy: 'METER'}}})
    t.is((await t.throwsAsync(scopeResolvedPointsForAggregation({...scope, sourceId: ordinary.id}))).status, 403)
    await client.chunk.create({data: {sourceId: ordinary.id, calculationStrategy: 'METER', compteurId: f.meter.id,
      pointPrelevementId: f.points[0].id, usageId: f.usage.id, minDate: new Date('2026-03-29Z'), maxDate: new Date('2026-03-30Z')}})
    t.is((await t.throwsAsync(scopeResolvedPointsForAggregation({...scope, sourceId: ordinary.id}))).status, 403)
    await client.chunk.create({data: {sourceId: scope.sourceId, pointPrelevementId: f.points[0].id, usageId: f.usage.id,
      minDate: new Date('2026-03-29Z'), maxDate: new Date('2026-03-30Z')}})
    t.is((await t.throwsAsync(scopeResolvedPointsForAggregation(scope))).status, 403)
  })
})

integration('les projections METER utilisent les jours Paris de 23/25 heures, sans modifier les jours UTC GENERIC', async t => {
  await withFixture(async (client, f) => {
    for (const [strategy, start, end, value, expected] of [
      ['METER', '2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z', 23, [['2026-03-29', 23]]],
      ['METER', '2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z', 25, [['2026-10-25', 25]]],
      ['METER', '2026-03-28T22:30:00Z', '2026-03-28T23:30:00Z', 2, [['2026-03-28', 1], ['2026-03-29', 1]]],
      ['METER', '2026-03-29T21:30:00Z', '2026-03-29T22:30:00Z', 2, [['2026-03-29', 1], ['2026-03-30', 1]]],
      ['METER', '2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z', 0, [['2026-03-29', 0]]],
      ['GENERIC', '2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z', 23, [['2026-03-28', 1], ['2026-03-29', 22]]]
    ]) {
      const isolatedPoint = await client.pointPrelevement.create({data: {name: `Synthetic day ${randomUUID()}`, flowType: 'PRELEVEMENT', waterBodyType: 'SUPERFICIELLE'}})
      const source = await client.source.create({data: {type: 'API', status: 'COMPLETED', chunks: {create: {
        calculationStrategy: strategy, pointPrelevementId: isolatedPoint.id, usageId: f.usage.id,
        minDate: new Date(start), maxDate: new Date(end), instructionStatus: 'VALIDATED', chunkValues: {create: {
          periodStart: new Date(start), periodEnd: new Date(end), metricTypeCode: 'volume',
          frequency: strategy === 'METER' ? 'irregular' : '1 day', valueKind: strategy === 'METER' ? 'COMPUTED' : 'DECLARED', value
        }}
      }}}, include: {chunks: true}})
      const ids = source.chunks.map(chunk => chunk.id)
      t.deepEqual((await aggregate(client, ids)).map(row => [row.date, row.value]), expected)
      t.deepEqual((await aggregate(client, ids, {startDate: '2026-03-29', endDate: '2026-03-29'})).map(row => [row.date, row.value]),
        expected.filter(([date]) => date === '2026-03-29'))
    }
  })
})

integration('les agrégats mensuels des compteurs concordent avec le dashboard au changement de mois Paris', async t => {
  await withFixture(async (client, f) => {
    const source = await client.source.create({data: {type: 'API', status: 'COMPLETED', chunks: {create: {
      calculationStrategy: 'METER', pointPrelevementId: f.points[0].id, usageId: f.usage.id, flowType: 'PRELEVEMENT',
      minDate: new Date('2026-08-31Z'), maxDate: new Date('2026-08-31Z'), instructionStatus: 'VALIDATED', chunkValues: {create: {
        periodStart: new Date('2026-08-31T21:59:30Z'), periodEnd: new Date('2026-08-31T22:00:30Z'),
        metricTypeCode: 'volume', frequency: 'irregular', valueKind: 'COMPUTED', value: '0.0002'
      }}
    }}}, include: {chunks: true}})
    const months = await aggregate(client, source.chunks.map(row => row.id), {aggregationFrequency: '1 month'})
    t.deepEqual(months, [{date: '2026-08', value: 0.0001}, {date: '2026-09', value: 0.0001}])
    const dashboard = await getVolumesByUsage([f.zones[0]], 2026, null, {client})
    t.is(dashboard.withdrawn.months[7].total, months[0].value)
    t.is(dashboard.withdrawn.months[8].total, months[1].value)
  })
})
