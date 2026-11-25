/* eslint-disable no-await-in-loop -- All fixtures share a guarded transaction that always rolls back. */
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {getDashboardStationSelection} from '../dashboard-water-resources.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {refreshChunkValueSummaries} from '../../services/chunk-value-summaries.js'
import {countDashboardPoints, getDeclarationPeriodOptions, getVolumeYearOptions, resolveDashboardZoneSelection} from '../dashboard.js'

const integration = process.env.METER_INTEGRATION_TESTS === '1' ? test.serial : test.skip
test.before(() => { if (process.env.METER_INTEGRATION_TESTS === '1') requireDisposableDatabase() })
test.after.always(async () => {
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

async function rollbackFixtures(operation) {
  const rollback = new Error('ROLLBACK_DASHBOARD_FIXTURES')
  try {
    await prisma.$transaction(async client => {
      await operation(client)
      throw rollback
    }, {timeout: 30000})
  } catch (error) {
    if (error !== rollback) throw error
  }
}

async function fixture(client) {
  const zoneId = randomUUID()
  await client.$executeRaw`INSERT INTO "Zone" (id, code, type, name, coordinates, "createdAt", "updatedAt")
    VALUES (${zoneId}::uuid, ${zoneId}, 'SAGE', 'Dashboard synthétique',
      ST_Multi(ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))',4326)), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  const point = await client.pointPrelevement.create({data: {
    name: randomUUID(), waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT',
    zones: {create: {zoneId}}
  }})
  const usage = await client.sandreWaterUse.create({data: {
    code: `d${randomUUID().slice(0, 12)}`, kind: 'USAGE', label: 'Dashboard synthétique'
  }})
  const actor = await client.user.create({data: {
    role: 'DECLARANT', declarant: {create: {declarantRole: 'PRELEVEUR', preleveurType: 'IRRIGANT'}}
  }})
  return {zoneId, point, usage, actor}
}

async function addChunk(client, f, {
  start, end = start, strategy = 'GENERIC', values = [], source,
  pointId = f.point.id, usageId = f.usage.id, ...data
}) {
  const storedSource = await client.source.create({data: {type: 'API', status: 'COMPLETED', ...source}})
  const chunk = await client.chunk.create({data: {
    sourceId: storedSource.id, pointPrelevementId: pointId, usageId,
    minDate: new Date(start), maxDate: new Date(end), calculationStrategy: strategy,
    instructionStatus: 'VALIDATED', ...data,
    chunkValues: {create: values.map(value => ({
      metricTypeCode: 'volume', value: 10, frequency: strategy === 'METER' ? 'irregular' : '1 day',
      periodStart: new Date(start), periodEnd: new Date(end), ...value
    }))}
  }})
  await refreshChunkValueSummaries([chunk.id], {client})
  return chunk
}

const now = new Date('2025-06-10T12:00:00Z')
const keys = options => options.map(option => option.value)

integration('les périodes SQL gardent les trous entre chunks et les bornes Paris exclusives METER', async t => {
  await rollbackFixtures(async client => {
    const f = await fixture(client)
    for (const start of ['2024-01-02', '2024-03-02', '2025-07-02']) await addChunk(client, f, {start})
    await addChunk(client, f, {
      start: '2024-12-31T23:00:00Z', end: '2025-01-01T00:00:00Z', strategy: 'METER', values: [{}]
    })
    await addChunk(client, f, {
      start: '2025-03-30T00:00:00Z', end: '2025-03-31T22:00:00Z', strategy: 'METER', values: [{}]
    })
    // Empty METER chunks do not inherit their calendar metadata.
    await addChunk(client, f, {start: '2023-03-01', strategy: 'METER'})
    t.deepEqual(keys(await getDeclarationPeriodOptions([f.zoneId], 'month', {client, now})),
      ['2025-06', '2025-03', '2025-01', '2024-03', '2024-01'])
    const weeks = keys(await getDeclarationPeriodOptions([f.zoneId], 'week', {client, now}))
    t.true(weeks.includes('2025-W01'))
    t.true(weeks.includes('2025-W13'))
    t.true(weeks.includes('2025-W14'))
    t.false(weeks.includes('2024-W52'))
    t.deepEqual(keys(await getDeclarationPeriodOptions([], 'month', {client, now})), ['2025-06'])
  })
})

integration('les périodes SQL respectent acteurs, déclaration, zones, usages et sources admissibles', async t => {
  await rollbackFixtures(async client => {
    const f = await fixture(client)
    const hidden = await client.sandreWaterUse.create({data: {
      code: `h${randomUUID().slice(0, 12)}`, kind: 'USAGE', label: 'Masqué', dashboardVisible: false
    }})
    const child = await client.sandreWaterUse.create({data: {
      code: `s${randomUUID().slice(0, 12)}`, kind: 'SUB_USAGE', parentId: hidden.id, label: 'Sous-usage masqué'
    }})
    for (const [start, actorField] of [
      ['2024-01-01', 'preleveurUserId'], ['2024-03-01', 'submittedByDeclarantUserId'], ['2024-05-01', 'collecteurUserId']
    ]) await addChunk(client, f, {start, [actorField]: f.actor.id})
    const declaration = await client.declaration.create({data: {
      code: randomUUID().slice(0, 6), declarantUserId: f.actor.id, type: 'ANNUAL', waterWithdrawalType: 'volume'
    }})
    await addChunk(client, f, {start: '2024-09-01', source: {type: 'DECLARATION', declarationId: declaration.id}})
    await addChunk(client, f, {start: '2024-07-01'})
    await addChunk(client, f, {start: '2023-01-01', instructionStatus: 'REJECTED', preleveurUserId: f.actor.id})
    await addChunk(client, f, {start: '2023-02-01', source: {status: 'PROCESSING'}, preleveurUserId: f.actor.id})
    await addChunk(client, f, {start: '2023-03-01', source: {type: 'BATCH'}, preleveurUserId: f.actor.id})
    await addChunk(client, f, {start: '2023-04-01', usageId: child.id, preleveurUserId: f.actor.id})
    const outside = await client.pointPrelevement.create({data: {name: randomUUID(), waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'}})
    await addChunk(client, f, {start: '2023-05-01', pointId: outside.id, preleveurUserId: f.actor.id})
    const deleted = await client.pointPrelevement.create({data: {
      name: randomUUID(), waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT', deletedAt: new Date(), zones: {create: {zoneId: f.zoneId}}
    }})
    await addChunk(client, f, {start: '2023-06-01', pointId: deleted.id, preleveurUserId: f.actor.id})
    t.deepEqual(keys(await getDeclarationPeriodOptions([f.zoneId], 'month', {client, now, declarantUserIds: [f.actor.id]})),
      ['2025-06', '2024-09', '2024-05', '2024-03', '2024-01'])
    t.deepEqual(keys(await getDeclarationPeriodOptions([f.zoneId], 'month', {client, now, declarantUserIds: []})), ['2025-06'])
    t.true(keys(await getDeclarationPeriodOptions([f.zoneId], 'month', {client, now})).includes('2024-07'))
  })
})

integration('les années SQL compactes gardent les années absentes, les zéros et les limites Paris', async t => {
  await rollbackFixtures(async client => {
    const f = await fixture(client)
    await addChunk(client, f, {start: '2021-03-01', end: '2021-03-02', values: [{}, {}]})
    await addChunk(client, f, {start: '2023-03-01', end: '2023-03-02', values: [{}]})
    await addChunk(client, f, {
      start: '2023-12-31T23:00:00Z', end: '2024-01-02T00:00:00Z', strategy: 'METER', values: [{}]
    })
    await addChunk(client, f, {start: '2020-01-01', end: '2020-01-02', values: [{value: 0}]})
    await addChunk(client, f, {start: '2019-01-01', end: '2019-01-02', values: [{}], instructionStatus: 'REJECTED'})
    await addChunk(client, f, {start: '2018-01-01', end: '2018-01-02', values: [{}], source: {status: 'FAILED'}})
    const currentYear = new Date().getUTCFullYear()
    t.deepEqual(await getVolumeYearOptions([f.zoneId], null, {client}),
      [...new Set([currentYear, 2024, 2023, 2021])].sort((a, b) => b - a))
    t.deepEqual(await getVolumeYearOptions([f.zoneId], ['SOUTERRAIN'], {client}), [currentYear])
    t.deepEqual(await getVolumeYearOptions([f.zoneId], [], {client}), [currentYear])
  })
})


integration('périodes natives : cache chaud et froid gardent les instants Réunion, les fins exclusives et les trous', async t => {
  await rollbackFixtures(async client => {
    const f = await fixture(client)
    const metadata = {nativeTemporal: true, timezone: 'Indian/Reunion'}
    const chunks = []
    for (const [start, end] of [
      ['2024-01-31T20:00:00Z', '2024-02-28T20:00:00Z'],
      ['2024-04-30T20:00:00Z', '2024-04-30T20:00:00Z']
    ]) chunks.push(await addChunk(client, f, {start, end, metadata, values: [{metadata}]}))
    chunks.push(await addChunk(client, f, {start: '2024-06-29T20:00:00Z', end: '2024-06-30T20:00:00Z', metadata,
      values: [{metadata}, {periodStart: new Date('2024-06-30T20:00:00Z'), periodEnd: new Date('2024-06-30T20:00:00Z'), metadata}]}))
    const ids = chunks.map(chunk => chunk.id)
    await client.chunkValueSummary.updateMany({where: {chunkId: {in: ids}}, data: {valid: false}})
    const cold = await getDeclarationPeriodOptions([f.zoneId], 'month', {client, now})
    t.deepEqual(keys(cold), ['2025-06', '2024-07', '2024-06', '2024-05', '2024-02'])
    const weeks = await getDeclarationPeriodOptions([f.zoneId], 'week', {client, now})
    await refreshChunkValueSummaries(ids, {client})
    t.deepEqual(await getDeclarationPeriodOptions([f.zoneId], 'month', {client, now}), cold)
    t.deepEqual(await getDeclarationPeriodOptions([f.zoneId], 'week', {client, now}), weeks)
    await client.chunk.updateMany({where: {id: {in: ids}}, data: {instructionStatus: 'REJECTED'}})
    t.true((await client.chunkValueSummary.findMany({where: {chunkId: {in: ids}}})).every(row => row.valid))
    t.deepEqual(keys(await getDeclarationPeriodOptions([f.zoneId], 'month', {client, now})), ['2025-06'])
  })
})

integration('un point confié dans deux territoires ouvre les deux choix au collecteur, sans ouvrir les autres points du préleveur', async t => {
  await rollbackFixtures(async client => {
    const {zoneId, point, usage, actor} = await fixture(client)
    const ptge = randomUUID()
    const elsewhere = randomUUID()
    const department = randomUUID()
    const geometry = 'MULTIPOLYGON(((0 0,0 1,1 1,1 0,0 0)))'
    await client.$executeRaw`INSERT INTO "Zone" (id, type, code, name, coordinates, "updatedAt") VALUES
      (${ptge}::uuid, 'PTGE', ${zoneId}, 'Adour', ST_GeomFromText(${geometry},4326), now()),
      (${elsewhere}::uuid, 'PTGE', ${elsewhere}, 'Zone amont', ST_GeomFromText(${geometry},4326), now()),
      (${department}::uuid, 'DEPARTEMENT', ${department}, 'Département', ST_GeomFromText(${geometry},4326), now())`
    await client.pointPrelevementZone.createMany({data: [ptge, department].map(id => ({pointPrelevementId: point.id, zoneId: id}))})
    const otherPoint = await client.pointPrelevement.create({data: {
      name: 'Point non confié', waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT', zones: {create: {zoneId: elsewhere}}
    }})
    const collector = await client.user.create({data: {role: 'DECLARANT', declarant: {create: {declarantRole: 'COLLECTEUR'}}}, include: {declarant: true}})
    await client.declarantPointPrelevement.create({data: {
      declarantUserId: actor.id, pointPrelevementId: point.id, usageId: usage.id, collecteurs: {create: {collecteurUserId: collector.id}}
    }})
    await client.declarantPointPrelevement.create({data: {declarantUserId: actor.id, pointPrelevementId: otherPoint.id, usageId: usage.id}})

    const select = (user, codes, options = {}) => resolveDashboardZoneSelection(user, codes, {client, ...options})
    const selection = await select(collector)
    t.deepEqual(selection.accessibleZones.map(zone => zone.id), [ptge, zoneId])
    t.deepEqual(selection.selectedZones.map(zone => zone.id), [ptge])
    t.deepEqual((await select(actor)).accessibleZones.map(zone => zone.id), [ptge, zoneId, elsewhere])
    const admin = {role: 'ADMIN'}
    t.deepEqual((await select(admin, [zoneId, elsewhere])).selectedZones.map(zone => zone.id), [ptge, zoneId, elsewhere])
    t.deepEqual((await select(admin, [zoneId, elsewhere], {requestedZoneId: elsewhere})).selectedZones.map(zone => zone.id), [elsewhere])
    t.deepEqual((await select(collector, undefined, {requestedZoneId: zoneId})).selectedZones.map(zone => zone.id), [zoneId])
    t.is((await t.throwsAsync(() => select(collector, undefined, {requestedZoneId: elsewhere}))).status, 403)
    t.is(await countDashboardPoints([elsewhere], {client, collecteurUserId: collector.id}), 0)
    t.deepEqual((await getDashboardStationSelection(collector, {zoneId, scope: 'activity'}, select)).zoneIds, [ptge, zoneId])
    t.deepEqual((await getDashboardStationSelection(collector, {zoneId, scope: 'territory'}, select)).zoneIds, [zoneId])
    t.is((await t.throwsAsync(() => getDashboardStationSelection({role: 'INSTRUCTOR'}, {scope: 'activity'}, select))).status, 403)
  })
})

integration('un agent retrouve sa zone par défaut à chaque visite même si un même code désigne deux territoires', async t => {
  await rollbackFixtures(async client => {
    const {zoneId} = await fixture(client)
    const second = randomUUID()
    await client.$executeRaw`INSERT INTO "Zone" (id, type, code, name, coordinates, "updatedAt") VALUES
      (${second}::uuid, 'PTGE', ${zoneId}, 'Adour', ST_GeomFromText('MULTIPOLYGON(((0 0,1 0,1 1,0 0)))',4326), now())`
    const instructor = await client.user.create({data: {role: 'INSTRUCTOR', instructor: {create: {}}}})
    for (const id of [zoneId, second]) {
      await client.instructorZone.create({data: {instructorUserId: instructor.id, zoneId: id, startDate: new Date('2000-01-01'),
        isDashboardDefault: id === zoneId, permissions: {create: {permission: 'zone.dashboard.read'}}}})
    }
    const load = async (requestedZoneId, codes) => (await resolveDashboardZoneSelection(instructor, codes, {
      client, requestedZoneId
    })).selectedZones.map(zone => zone.id)
    t.deepEqual(await load(), [zoneId])
    t.deepEqual(await load(second), [second])
    t.deepEqual(await load(), [zoneId])
    t.deepEqual(await load(undefined, zoneId), [zoneId])
    t.is((await t.throwsAsync(() => load('invalide'))).status, 400)
    await client.instructorZone.updateMany({where: {instructorUserId: instructor.id, zoneId}, data: {endDate: new Date()}})
    t.deepEqual(await load(), [zoneId])
    await client.instructorZone.updateMany({where: {instructorUserId: instructor.id, zoneId}, data: {endDate: new Date('2001-01-01')}})
    t.deepEqual(await load(), [second])
    t.is((await t.throwsAsync(() => load(zoneId))).status, 403)
    await client.instructorZonePermission.deleteMany({where: {instructorZone: {instructorUserId: instructor.id}}})
    t.deepEqual(await load(), [])
  })
})
