/* eslint-disable no-await-in-loop -- All synthetic fixtures live in one transaction that always rolls back. */
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import {Prisma} from '@prisma/client'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {buildDeclarantDeclarationFeed} from '../../handlers/declaration-feed.js'
import {buildDashboardVolumeMonthProjection, getDeclarationPeriodOptions, getVolumesByUsage, getVolumeYearOptions, getRegisteredPrelevementsByUsage} from '../../handlers/dashboard.js'
import {getReadableTelemetrySourceWhere, getVisibleTelemetryChunksWhere, scopeMeterSource} from '../telemetry-source-access.js'
import {getSourceForInstructor, listSourcesForInstructor} from '../instructor-sources.js'
import {ingestMeterBatch} from '../meter-ingestion.js'

const integration = process.env.METER_INTEGRATION_TESTS === '1' ? test.serial : test.skip
test.before(() => { if (process.env.METER_INTEGRATION_TESTS === '1') requireDisposableDatabase() })
test.after.always(async () => {
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

async function rollbackFixtures(operation) {
  const rollback = new Error('ROLLBACK_TELEMETRY_VISIBILITY_FIXTURES')
  try {
    await prisma.$transaction(async tx => {
      await operation(tx)
      throw rollback
    }, {timeout: 30000})
  } catch (error) {
    if (error !== rollback) throw error
  }
}

async function makeFixture(tx) {
  const key = randomUUID()
  const usage = await tx.sandreWaterUse.create({data: {code: `t${key.slice(0, 8)}`, kind: 'USAGE', label: 'Usage synthétique'}})
  const users = []
  for (const role of ['PRELEVEUR', 'PRELEVEUR', 'COLLECTEUR', 'PRELEVEUR']) {
    users.push(await tx.user.create({data: {role: 'DECLARANT', declarant: {create: {declarantRole: role,
      preleveurType: role === 'PRELEVEUR' ? 'IRRIGANT' : null, socialReason: `${key}-${users.length}`}}}, include: {declarant: true}}))
  }
  const [owner, other, collector, outsider] = users
  const admin = await tx.user.create({data: {role: 'ADMIN'}})
  const points = []
  const zones = []
  for (let index = 0; index < 2; index++) {
    points.push(await tx.pointPrelevement.create({data: {name: `Synthetic ${key}-${index}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'}}))
    const id = randomUUID()
    await tx.$executeRaw`INSERT INTO "Zone" (id,code,type,name,coordinates,"createdAt","updatedAt")
      VALUES (${id}::uuid, ${`${key}-${index}`}, 'SAGE', 'Zone synthétique',
        ST_Multi(ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))',4326)), CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`
    zones.push(id)
    await tx.pointPrelevementZone.create({data: {zoneId: id, pointPrelevementId: points[index].id}})
  }
  const exploitations = []
  for (const [point, user] of [[points[0], owner], [points[0], other], [points[1], owner]]) {
    exploitations.push(await tx.declarantPointPrelevement.create({data: {pointPrelevementId: point.id, declarantUserId: user.id, usageId: usage.id, status: 'EN_ACTIVITE'}}))
  }
  await tx.declarantCollecteurExploitation.create({data: {collecteurUserId: collector.id, exploitationId: exploitations[0].id}})
  const meter = await tx.compteur.create({data: {serialNumber: key}})
  const allocationSnapshot = [40, 30, 30].map((percentage, index) => ({key: `${key}:${index}`, percentage: String(percentage), inScope: true}))
  await tx.meterStream.create({data: {provider: 'synthetic', scope: key, externalId: key, compteurId: meter.id,
    enabled: true, activatedAt: new Date('2026-07-01Z'), allocationSnapshot, allocationSnapshotValidated: true}})
  for (const [index, exploitation] of exploitations.entries()) {
    await tx.meterAllocation.create({data: {sourceId: `${key}:${index}`, provider: 'synthetic', scope: key,
      compteurId: meter.id, exploitationId: exploitation.id, versions: {create: {version: 1, percentage: allocationSnapshot[index].percentage,
        enabled: true, startDate: new Date('2026-07-01Z'), metadata: {allocationSnapshot, allocationSnapshotValidated: true}}}}})
  }
  await ingestMeterBatch({provider: 'synthetic', scope: key, batchId: key, mode: 'LIVE', complete: true,
    fetchedAt: '2026-09-02T10:00:00Z', windowStart: '2026-08-30T00:00:00Z', windowEnd: '2026-09-02T00:00:00Z', readings: [
      {externalId: key, observedAt: '2026-08-31T21:59:30Z', index: '100', status: 'VALID'},
      {externalId: key, observedAt: '2026-08-31T22:00:30Z', index: '200', status: 'VALID'}
    ]}, {user: admin}, {client: {$transaction: action => action(tx)}})
  const publication = await tx.meterPublication.findFirstOrThrow({where: {compteurId: meter.id}})
  return {owner, other, collector, outsider, points, zones, publication, usage}
}

integration('une publication partagée reste visible sans divulguer les autres bénéficiaires ni leurs totaux', async t => {
  await rollbackFixtures(async tx => {
    const f = await makeFixture(tx)
    for (const [user, ids, expectedTotal, expectedChunks] of [
      [f.owner, [f.owner.id], 70, 2], [f.other, [f.other.id], 30, 1],
      [f.collector, [f.collector.id, f.owner.id], 40, 1]
    ]) {
      const source = await tx.source.findFirstOrThrow({
        where: {id: f.publication.sourceId, ...getReadableTelemetrySourceWhere(ids, {user})},
        include: {chunks: {where: getVisibleTelemetryChunksWhere({user}), include: {chunkValues: true}}, _count: {select: {chunks: true}}}
      })
      const visible = scopeMeterSource(source)
      t.is(visible.chunks.length, expectedChunks)
      t.is(visible._count.chunks, expectedChunks)
      t.is(visible.metadata.totalWaterVolumeWithdrawn, expectedTotal)
      t.true(visible.readOnly)
      t.true(visible.chunks.every(chunk => chunk.canInstruct === false && chunk.canReconcile === false))
      const feed = await buildDeclarantDeclarationFeed({user, client: tx, includeMeta: false,
        findReadableDeclarantUserIds: async () => ids, decorateDeclarationTypes: async rows => rows})
      t.is(feed.data.length, 1)
      t.is(feed.data[0].kind, 'TELEMETRY')
      t.is(feed.data[0].source.metadata.calculationStrategy, 'METER')
      t.is(feed.data[0].source.metadata.totalWaterVolumeWithdrawn, expectedTotal)
      t.is(feed.data[0].source.chunks.length, expectedChunks)
      t.true(feed.data[0].source.readOnly)
    }
    t.is(await tx.source.count({where: {id: f.publication.sourceId, ...getReadableTelemetrySourceWhere([f.outsider.id], {user: f.outsider})}}), 0)
    const instructor = await getSourceForInstructor(f.publication.sourceId, {readZoneIds: [f.zones[0]]}, {client: tx})
    t.is(instructor.chunks.length, 2)
    t.is(instructor.metadata.totalWaterVolumeWithdrawn, 70)
    t.true(instructor.chunks.every(chunk => chunk.pointPrelevementId === f.points[0].id && !chunk.canInstruct))
    const list = await listSourcesForInstructor({zoneIds: [f.zones[0]], types: ['API']}, {client: tx})
    t.is(list.items.length, 1)
    t.is(list.items[0].metadata.totalWaterVolumeWithdrawn, 70)
    t.is((await listSourcesForInstructor({zoneIds: [f.zones[0]], types: ['MANUAL']}, {client: tx})).items.length, 0)
    t.is((await listSourcesForInstructor({zoneIds: []}, {client: tx})).items.length, 0)
    t.is(await tx.declaration.count({where: {declarantUserId: {in: [f.owner.id, f.other.id]}}}), 0)

    const stats = await getRegisteredPrelevementsByUsage([f.zones[0]], 'month', '2026-08', {client: tx})
    t.is(stats.find(row => row.usage.id === f.usage.id).declaredPointsCount, 1)
    const september = await getRegisteredPrelevementsByUsage([f.zones[0]], 'month', '2026-09', {client: tx})
    t.is(september.find(row => row.usage.id === f.usage.id).declaredPointsCount, 1)
    const periods = await getDeclarationPeriodOptions([f.zones[0]], 'month', {client: tx})
    t.true(periods.some(period => period.value === '2026-08'))
    t.true(periods.some(period => period.value === '2026-09'))
    const charts = await getVolumesByUsage([f.zones[0]], 2026, null, {client: tx})
    t.is(charts.withdrawn.usages.find(row => row.usage.id === f.usage.id).total, 70)
    const years = await getVolumeYearOptions([f.zones[0]], null, {client: tx})
    t.true(years.includes(2026))

    const otherOnly = await tx.source.create({data: {type: 'API', status: 'COMPLETED', metadata: {calculationStrategy: 'METER'},
      chunks: {create: {calculationStrategy: 'METER', pointPrelevementId: f.points[0].id, preleveurUserId: f.other.id,
        usageId: f.usage.id, minDate: new Date('2026-08-01Z'), maxDate: new Date('2026-08-01Z')}}}})
    // Both beneficiaries exploit the same PP: that link is not sufficient to
    // read a source containing only the other beneficiary's allocated volume.
    t.is(await tx.source.count({where: {id: otherOnly.id, ...getReadableTelemetrySourceWhere([f.owner.id], {user: f.owner})}}), 0)
    t.is(await tx.source.count({where: {id: otherOnly.id, ...getReadableTelemetrySourceWhere([f.other.id], {user: f.other})}}), 1)
  })
})

integration('le prorata SQL METER respecte mois Paris, secondes, année, zéro et garde le legacy inchangé', async t => {
  const cases = [
    ['METER', 'irregular', '2026-08-31 21:59:30', '2026-08-31 22:00:30', '10', 2026, [[8, 5], [9, 5]]],
    ['GENERIC', '1 day', '2026-08-31 21:59:30', '2026-08-31 22:00:30', '10', 2026, [[8, 10]]],
    ['METER', 'irregular', '2025-12-31 22:59:30', '2025-12-31 23:00:30', '10', 2026, [[1, 5]]],
    ['METER', 'irregular', '2026-08-31 21:59:30', '2026-08-31 22:00:30', '0', 2026, [[8, 0], [9, 0]]],
    ['METER', 'irregular', '2026-08-31 22:00:00', '2026-08-31 22:00:00', '10', 2026, []],
    ['METER', 'irregular', '2026-08-31 21:59:30', '2026-08-31 22:00:00', '10', 2026, [[8, 10]]],
    ['METER', 'irregular', '2026-03-28 23:00:00', '2026-04-01 22:00:00', '95', 2026, [[3, 71], [4, 24]]],
    ['METER', 'irregular', '2026-08-31 21:59:59', '2026-08-31 22:00:01', '0.0002', 2026, [[8, 0.0001], [9, 0.0001]]]
  ]
  for (const [strategy, frequency, start, end, value, year, expected] of cases) {
    const rows = await prisma.$queryRaw(Prisma.sql`
      SELECT volume_period.month, volume_period.volume::float8 AS volume
      FROM (SELECT ${strategy}::text AS "calculationStrategy") c
      CROSS JOIN (SELECT ${frequency}::text AS frequency, ${start}::timestamp AS "periodStart",
        ${end}::timestamp AS "periodEnd", ${value}::numeric AS value) v
      ${buildDashboardVolumeMonthProjection(year)} ORDER BY volume_period.month
    `)
    t.deepEqual(rows.map(row => [row.month, row.volume]), expected)
  }
})
