import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {getAuthorizedCumulativeAggregation, getAggregatedValuesFromSql, getNativeAggregationPolicy} from '../series-aggregation.js'
import {getVolumesByUsage, getVolumeYearOptions, getDeclarationPeriodOptions, getRegisteredPrelevementsByUsage} from '../dashboard.js'
import {refreshVolumeMetadataForSourceIds} from '../../services/volume-totals.js'
import {getSeriesValuesInRange} from '../../models/series.js'
import {normalizeExportFilters, queryExportRows, rowToExportObject} from '../../services/data-exports.js'

const integration = process.env.METER_INTEGRATION_TESTS === '1' ? test.serial : test.skip
test.before(() => { if (process.env.METER_INTEGRATION_TESTS === '1') requireDisposableDatabase() })
test.after.always(async () => {
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

async function fixtures(operation) {
  const rollback = new Error('ROLLBACK_NATIVE_PUBLICATION')
  try {
    await prisma.$transaction(async client => {
      const zoneId = randomUUID()
      await client.$executeRaw`INSERT INTO "Zone" (id, code, type, name, coordinates, "createdAt", "updatedAt")
        VALUES (${zoneId}::uuid, ${zoneId}, 'SAGE', 'Territoire synthétique',
          ST_Multi(ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))',4326)), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      const usage = await client.sandreWaterUse.create({data: {code: `n${randomUUID().slice(0, 12)}`, kind: 'USAGE', label: 'Usage synthétique'}})
      const point = await client.pointPrelevement.create({data: {name: 'Point natif synthétique', flowType: 'PRELEVEMENT', waterBodyType: 'SUPERFICIELLE', zones: {create: {zoneId}}}})
      const source = await client.source.create({data: {type: 'DECLARATION', status: 'COMPLETED', metadata: {nativeTemporal: true}}})
      const add = async ({targetSourceId = source.id, status = 'AUTOMATICALLY_VALIDATED', metric = 'volume', unit = 'm³', frequency = '1 month', valueType = 'cumulative', value = '31.123456789012345', start = '2025-12-31T20:00:00Z', end = '2026-01-31T20:00:00Z'} = {}) => client.chunk.create({data: {
        sourceId: targetSourceId, usageId: usage.id, pointPrelevementId: point.id, flowType: 'PRELEVEMENT',
        instructionStatus: status, autoCalculateVolumes: false, minDate: new Date(start), maxDate: new Date(end),
        metadata: {nativeTemporal: true, timezone: 'Indian/Reunion', valueType, frequency, unit},
        chunkValues: {create: {metricTypeCode: metric, unit, frequency, valueKind: 'DECLARED', value,
          periodStart: new Date(start), periodEnd: new Date(end), metadata: {nativeTemporal: true}}}
      }})
      await operation({client, zoneId, usage, point, source, add})
      throw rollback
    }, {timeout: 60000})
  } catch (error) { if (error !== rollback) throw error }
}

integration('publication native exclut les imports en cours et les anciennes séries remplacées, respecte le mois Réunion et les périodes longues', async t => {
  await fixtures(async ({client, zoneId, usage, point, source, add}) => {
    const accepted = await add()
    const processing = await client.source.create({data: {type: 'DECLARATION', status: 'PROCESSING', metadata: {nativeTemporal: true}}})
    const pending = await add({targetSourceId: processing.id, value: '9000'})
    const rejected = await add({status: 'REJECTED', value: '8000'})
    const options = {client, pointIds: [point.id], sourceId: source.id, user: {role: 'ADMIN'}, metricTypeCode: 'volume', startDate: '2026-01-01', endDate: '2026-01-31', aggregationFrequency: '1 month'}
    const authorized = await getAuthorizedCumulativeAggregation(options)
    t.is(authorized.seriesCount, 1)
    t.deepEqual(authorized.values, [{date: '2026-01', value: 31.123456789012344}])
    const direct = await getAggregatedValuesFromSql({...options, chunkIds: [accepted.id, pending.id, rejected.id], spatialOperator: 'sum', temporalOperator: 'sum'})
    t.deepEqual(direct, authorized.values)
    const policy = await getNativeAggregationPolicy({...options, aggregationFrequency: '1 day'})
    t.is(policy.frequency, '1 month')
    t.true(policy.nativeOnly)
    t.is(policy.unit, 'm³')
    const error = await t.throwsAsync(getNativeAggregationPolicy({...options, startDate: '2026-01-02'}))
    t.is(error.status, 400)
    t.regex(error.message, /coupe une mesure/)
    await refreshVolumeMetadataForSourceIds([source.id, processing.id], client)
    const refreshed = await client.source.findUnique({where: {id: source.id}})
    t.is(refreshed.metadata.totalWaterVolumeWithdrawn, 31.123456789012344)
    const pendingAfter = await client.chunk.findUnique({where: {id: pending.id}})
    t.is(pendingAfter.metadata.totalWaterVolume, 0)
    const years = await getVolumeYearOptions([zoneId], null, {client})
    t.true(years.includes(2026))
    t.false(years.includes(2025))
    const periods = await getDeclarationPeriodOptions([zoneId], 'month', {client, now: new Date('2026-02-01T00:00:00Z')})
    t.deepEqual(periods.map(period => period.value), ['2026-02', '2026-01'])
    const registeredOptions = {client, loadExploitations: async () => [{pointPrelevementId: point.id, usageId: usage.id, usage, secondaryUsageLinks: []}]}
    t.is((await getRegisteredPrelevementsByUsage([zoneId], 'month', '2026-01', registeredOptions))[0].declaredPointsCount, 1)
    await client.chunk.update({where: {id: accepted.id}, data: {instructionStatus: 'PENDING'}})
    t.is((await getRegisteredPrelevementsByUsage([zoneId], 'month', '2026-01', registeredOptions))[0].declaredPointsCount, 1)
    await client.source.update({where: {id: source.id}, data: {status: 'PROCESSING'}})
    t.is((await getRegisteredPrelevementsByUsage([zoneId], 'month', '2026-01', registeredOptions))[0].declaredPointsCount, 0)
    // Missing nativeTemporal JSON keys preserve historical PENDING eligibility.
    const legacySource = await client.source.create({data: {type: 'DECLARATION', status: 'COMPLETED'}})
    const legacy = await client.chunk.create({data: {sourceId: legacySource.id, pointPrelevementId: point.id, usageId: usage.id,
      minDate: new Date('2026-01-01'), maxDate: new Date('2026-01-31'), instructionStatus: 'PENDING'}})
    t.is((await getRegisteredPrelevementsByUsage([zoneId], 'month', '2026-01', registeredOptions))[0].declaredPointsCount, 1)
    await client.chunk.delete({where: {id: legacy.id}})
    await client.source.update({where: {id: source.id}, data: {status: 'COMPLETED'}})
    await add({frequency: '1 quarter', value: '90', end: '2026-03-31T20:00:00Z'})
    const charts = await getVolumesByUsage([zoneId], 2026, null, {client})
    t.is(charts.withdrawn.months[0].total, 31.123456789012344)
    t.is(charts.withdrawn.months[1].total, 0)
    t.is(charts.withdrawn.volumesWithoutMonthlyDetail, 90)
    t.is(charts.withdrawn.usages[0].total, 121.12345678901235)
  })
})

integration('index natifs gardent chaque observation dans une moyenne et ne mélangent pas les unités', async t => {
  await fixtures(async ({client, point, source, add}) => {
    const a = await add({metric: 'index', frequency: 'instant', valueType: 'instantaneous', value: '1', start: '2026-01-01T00:01:23Z', end: '2026-01-01T00:01:23Z'})
    const b = await add({metric: 'index', frequency: 'instant', valueType: 'instantaneous', value: '3', start: '2026-01-01T00:01:24Z', end: '2026-01-01T00:01:24Z'})
    const values = await getAggregatedValuesFromSql({client, chunkIds: [a.id, b.id], metricTypeCode: 'index', temporalOperator: 'mean', aggregationFrequency: '1 day', startDate: '2026-01-01', endDate: '2026-01-01'})
    t.deepEqual(values, [{date: '2026-01-01', value: 2}])
    await add({metric: 'débit', valueType: 'instantaneous', unit: 'm³/h'})
    await add({metric: 'débit', valueType: 'instantaneous', unit: 'L/s'})
    const error = await t.throwsAsync(getNativeAggregationPolicy({client, pointIds: [point.id], sourceId: source.id, user: {role: 'ADMIN'}, metricTypeCode: 'débit', aggregationFrequency: '1 day'}))
    t.is(error.status, 400)
    t.regex(error.message, /unités différentes/)
  })
})

integration('un cumul camion du 1 au 19 décembre reste entier dans une maille mensuelle', async t => {
  await fixtures(async ({client, point, source, add}) => {
    await add({frequency: 'irregular', value: '90', start: '2025-11-30T20:00:00Z', end: '2025-12-19T20:00:00Z'})
    const options = {client, pointIds: [point.id], sourceId: source.id, user: {role: 'ADMIN'},
      metricTypeCode: 'volume', aggregationFrequency: '1 day', startDate: '2025-12-01', endDate: '2025-12-31'}
    const policy = await getNativeAggregationPolicy(options)
    t.is(policy.frequency, '1 month')
    const aggregation = await getAuthorizedCumulativeAggregation({...options, aggregationFrequency: policy.frequency})
    t.deepEqual(aggregation.values, [{date: '2025-12', value: 90}])
    // An exclusive end exactly at a new month must not force a quarterly bucket.
    await add({frequency: 'irregular', value: '10', start: '2025-12-19T20:00:00Z', end: '2025-12-31T20:00:00Z'})
    t.is((await getNativeAggregationPolicy(options)).frequency, '1 month')
  })
})

integration('un cumul sur deux années reste lisible et exportable même si son agrégation est refusée', async t => {
  await fixtures(async ({client, zoneId, point, source, add}) => {
    const chunk = await add({frequency: 'irregular', value: '90.123456789012345', start: '2025-12-14T20:00:00Z', end: '2026-01-15T20:00:00Z'})
    const period = {startDate: '2025-12-01', endDate: '2026-01-31'}
    const error = await t.throwsAsync(getNativeAggregationPolicy({client, pointIds: [point.id], sourceId: source.id,
      user: {role: 'ADMIN'}, metricTypeCode: 'volume', aggregationFrequency: '1 day', ...period}))
    t.is(error.status, 400)
    t.regex(error.message, /valeurs originales.*exportez-les/)
    const original = await getSeriesValuesInRange(`${chunk.id}:volume`, period, client)
    t.is(original.length, 1)
    t.is(original[0].values.value, '90.123456789012345')
    t.is(original[0].periodStart.toISOString(), '2025-12-14T20:00:00.000Z')
    t.is(original[0].periodEnd.toISOString(), '2026-01-15T20:00:00.000Z')
    const rows = await queryExportRows({client, user: {role: 'ADMIN'},
      filters: normalizeExportFilters({...period, zoneIds: [zoneId]}), allowedZoneIds: [zoneId]})
    t.is(rows.length, 1)
    t.like(rowToExportObject(rows[0]), {valeur: '90.123456789012345', dateDebutPeriode: '2025-12-15',
      dateFinPeriode: '2026-01-16', fuseauHoraire: 'Indian/Reunion', borneFinExclusive: 'Oui'})
  })
})
