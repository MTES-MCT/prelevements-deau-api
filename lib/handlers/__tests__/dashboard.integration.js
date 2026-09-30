/* eslint-disable no-await-in-loop -- All fixtures share a guarded transaction that always rolls back. */
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {getDeclarationPeriodOptions, getVolumeYearOptions} from '../dashboard.js'

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
  return client.chunk.create({data: {
    sourceId: storedSource.id, pointPrelevementId: pointId, usageId,
    minDate: new Date(start), maxDate: new Date(end), calculationStrategy: strategy,
    instructionStatus: 'VALIDATED', ...data,
    chunkValues: {create: values.map(value => ({
      metricTypeCode: 'volume', value: 10, frequency: strategy === 'METER' ? 'irregular' : '1 day',
      periodStart: new Date(start), periodEnd: new Date(end), ...value
    }))}
  }})
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
