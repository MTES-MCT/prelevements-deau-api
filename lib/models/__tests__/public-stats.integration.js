import {randomUUID} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import process from 'node:process'

import {PrismaPg} from '@prisma/adapter-pg'
import prismaPackage from '@prisma/client'
import test from 'ava'
import pgPackage from 'pg'

import {buildPublicStatsDataQuery, getPublicStats} from '../public-stats.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'

const {Prisma, PrismaClient} = prismaPackage
const {Pool} = pgPackage
const DATABASE_URL = process.env.PUBLIC_STATS_TEST_DATABASE_URL
const BENCHMARK_VALUE_COUNT = Number.parseInt(
  process.env.PUBLIC_STATS_TEST_BENCHMARK_VALUES ?? '0',
  10
)
const TEST_MONTH = '2026-08'
const TEST_NOW = new Date('2026-09-15T12:00:00.000Z')
const TRANSACTION_OPTIONS = {maxWait: 5000, timeout: 30_000}

let pool
let client

function defineIntegrationTest(title, implementation) {
  if (DATABASE_URL) {
    test.serial(title, implementation)
    return
  }

  // eslint-disable-next-line ava/no-skip-test -- requires an explicitly provided disposable PostgreSQL database.
  test.skip(title, implementation)
}

test.before(() => {
  if (!DATABASE_URL) {
    return
  }

  requireDisposableDatabase(DATABASE_URL)
  pool = new Pool({connectionString: DATABASE_URL, max: 1})
  client = new PrismaClient({adapter: new PrismaPg(pool)})
})

test.after.always(async () => {
  if (!client) {
    return
  }

  await client.$disconnect()
  await pool.end()
})

async function withRolledBackFixtures(operation) {
  const rollback = new Error('ROLLBACK_PUBLIC_STATS_FIXTURES')

  try {
    await client.$transaction(async transaction => {
      // Public stats are global. Hide fixtures retained by other integration files
      // only inside this transaction; its mandatory rollback restores them all.
      // The database guard above forbids real environments. Run integrations with concurrency=1.
      await transaction.$executeRaw`TRUNCATE TABLE "User" CASCADE`
      await operation(transaction)
      throw rollback
    }, TRANSACTION_OPTIONS)
  } catch (error) {
    if (error !== rollback) {
      throw error
    }
  }
}

async function createPreleveur(transaction, runId, key, preleveurType) {
  return transaction.user.create({
    data: {
      email: `${key}.${runId}@example.test`,
      firstName: runId,
      lastName: key,
      role: 'DECLARANT',
      declarant: {
        create: {
          declarantRole: 'PRELEVEUR',
          declarantType: 'LEGAL_PERSON',
          preleveurType,
          socialReason: `Préleveur ${key}`
        }
      }
    },
    select: {id: true}
  })
}

async function createCollecteur(transaction, runId) {
  return transaction.user.create({
    data: {
      email: `collecteur.${runId}@example.test`,
      firstName: runId,
      lastName: 'collecteur',
      role: 'DECLARANT',
      declarant: {
        create: {
          declarantRole: 'COLLECTEUR',
          declarantType: 'LEGAL_PERSON',
          socialReason: 'Collecteur hors statistiques'
        }
      }
    },
    select: {id: true}
  })
}

async function createAgent(transaction, runId, role) {
  return transaction.user.create({
    data: {
      email: `${role.toLowerCase()}.${runId}@example.test`,
      firstName: runId,
      lastName: role,
      role,
      ...(role === 'INSTRUCTOR' && {instructor: {create: {}}})
    },
    select: {id: true}
  })
}

async function createZone(transaction, {code, name, type}) {
  const id = randomUUID()
  await transaction.$executeRaw`
    INSERT INTO "Zone" (id, code, type, name, coordinates, "createdAt", "updatedAt")
    VALUES (
      CAST(${id} AS uuid),
      ${code},
      CAST(${type} AS "ZoneType"),
      ${name},
      ST_Multi(ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))', 4326)),
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
  `
  return {id, name}
}

async function createPoint(transaction, runId, key, options = {}) {
  return transaction.pointPrelevement.create({
    data: {
      name: `${runId}-${key}`,
      waterBodyType: 'SOUTERRAIN',
      flowType: options.flowType ?? 'PRELEVEMENT',
      deletedAt: options.deletedAt ?? null
    },
    select: {id: true}
  })
}

async function linkPointsToZones(transaction, points, zones) {
  await transaction.pointPrelevementZone.createMany({
    data: points.flatMap(point => zones.map(zone => ({
      pointPrelevementId: point.id,
      zoneId: zone.id
    })))
  })
}

async function createSourceChunk(transaction, {
  code,
  dataSourceType,
  declarationCreatedAt,
  declarationPreleveurId,
  flowType = 'PRELEVEMENT',
  instructionStatus = 'PENDING',
  metricTypeCode = 'volume',
  periodEnd,
  periodStart,
  pointId,
  preleveurUserId,
  sourceStatus = 'COMPLETED',
  sourceType = 'DECLARATION',
  usageId,
  value = '1'
}) {
  let declarationId
  if (sourceType === 'DECLARATION') {
    const declaration = await transaction.declaration.create({
      data: {
        code,
        declarantUserId: declarationPreleveurId,
        type: 'QUICK',
        waterWithdrawalType: 'PRELEVEMENT',
        dataSourceType,
        createdAt: declarationCreatedAt
      },
      select: {id: true}
    })
    declarationId = declaration.id
  }

  const source = await transaction.source.create({
    data: {
      type: sourceType,
      status: sourceStatus,
      declarationId,
      createdAt: declarationCreatedAt
    },
    select: {id: true}
  })
  const chunk = await transaction.chunk.create({
    data: {
      sourceId: source.id,
      pointPrelevementId: pointId,
      preleveurUserId,
      usageId,
      flowType,
      instructionStatus,
      minDate: periodStart,
      maxDate: periodEnd
    },
    select: {id: true}
  })

  await transaction.chunkValue.create({
    data: {
      chunkId: chunk.id,
      metricTypeCode,
      frequency: '1 month',
      periodStart,
      periodEnd,
      unit: 'm3',
      value
    }
  })

  return chunk
}

async function addBenchmarkValues(transaction, chunkId, valueCount) {
  await transaction.$executeRaw`
    INSERT INTO "ChunkValue" (
      id, "chunkId", "metricTypeCode", unit, frequency,
      "periodStart", "periodEnd", "valueKind", value, "createdAt", "updatedAt"
    )
    SELECT
      gen_random_uuid(),
      CAST(${chunkId} AS uuid),
      'volume',
      'm3',
      '1 month',
      TIMESTAMP '2026-08-01 00:00:00',
      TIMESTAMP '2026-09-01 00:00:00',
      'DECLARED'::"ChunkValueKind",
      series::numeric,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM generate_series(1, CAST(${valueCount} AS integer)) AS series
  `
}

async function createAuditEvent(transaction, {
  actionType,
  occurredAt,
  outcome = 'SUCCESS',
  subjectUserId,
  subjectUserRole
}) {
  await transaction.auditEvent.create({
    data: {
      actionType,
      actionCategory: 'AUTHENTICATION',
      occurredAt,
      outcome,
      subjectUserId,
      subjectUserRole,
      requestId: randomUUID(),
      httpMethod: 'POST',
      route: '/auth/test'
    }
  })
}

function expectedProfiles() {
  return [
    {key: 'AGRICULTURE', label: 'Agriculteurs', count: 2},
    {key: 'INDUSTRY', label: 'Industriels', count: 2},
    {key: 'DRINKING_WATER', label: 'Gestionnaires d’eau potable', count: 1},
    {key: 'OTHER', label: 'Autres', count: 2},
    {key: 'UNKNOWN', label: 'Non renseigné', count: 0}
  ]
}

function expectedTerritory(zone) {
  return {
    id: zone.id,
    name: zone.name,
    pointsCount: 6,
    preleveursCount: 7,
    reportingPreleveursCount: 4,
    reportingRate: 57.14,
    profiles: expectedProfiles()
  }
}

defineIntegrationTest('getPublicStats calcule les statistiques réelles sans fuite entre territoires ou statuts', async t => {
  const runId = randomUUID()
  const previousUserCount = await client.user.count()

  await withRolledBackFixtures(async transaction => {
    const usage = await transaction.sandreWaterUse.create({
      data: {
        code: `TEST-${runId.slice(0, 8)}`,
        kind: 'USAGE',
        label: 'Usage test statistiques publiques'
      },
      select: {id: true}
    })

    const agriculture = await createPreleveur(transaction, runId, 'agriculture', 'IRRIGANT')
    const industry = await createPreleveur(transaction, runId, 'industry', 'ICPE')
    const mixed = await createPreleveur(transaction, runId, 'mixed', 'GESTIONNAIRE_AEP')
    const batch = await createPreleveur(transaction, runId, 'batch', 'AUTRE')
    const explicitZone = await createPreleveur(transaction, runId, 'zone', 'IRRIGANT')
    const exploitationOnly = await createPreleveur(transaction, runId, 'exploitation', 'AUTRE')
    const rejectedOnly = await createPreleveur(transaction, runId, 'rejected', 'ICPE')
    const ignoredZoneLink = await createPreleveur(transaction, runId, 'ignored-zone', 'AUTRE')
    const deletedOwner = await createPreleveur(transaction, runId, 'deleted', 'IRRIGANT')
    const collecteur = await createCollecteur(transaction, runId)
    const administrator = await createAgent(transaction, runId, 'ADMIN')
    const instructor = await createAgent(transaction, runId, 'INSTRUCTOR')

    await transaction.user.update({
      where: {id: deletedOwner.id},
      data: {deletedAt: new Date('2026-08-20T12:00:00.000Z')}
    })

    const department = await createZone(transaction, {
      code: `DEP-${runId}`,
      name: 'Département de test',
      type: 'DEPARTEMENT'
    })
    const sage = await createZone(transaction, {
      code: `SAGE-${runId}`,
      name: 'SAGE de test',
      type: 'SAGE'
    })
    const zones = [department, sage]

    const directPoint = await createPoint(transaction, runId, 'direct')
    const apiPoint = await createPoint(transaction, runId, 'api')
    const mixedDirectPoint = await createPoint(transaction, runId, 'mixed-direct')
    const mixedApiPoint = await createPoint(transaction, runId, 'mixed-api')
    const batchPoint = await createPoint(transaction, runId, 'batch')
    const historicalPoint = await createPoint(transaction, runId, 'historical')
    const rejectedPoint = await createPoint(transaction, runId, 'rejet', {flowType: 'REJET'})
    const deletedPoint = await createPoint(transaction, runId, 'deleted', {
      deletedAt: new Date('2026-08-01T00:00:00.000Z')
    })
    const livePoints = [
      directPoint,
      apiPoint,
      mixedDirectPoint,
      mixedApiPoint,
      batchPoint,
      historicalPoint
    ]
    await linkPointsToZones(transaction, [...livePoints, rejectedPoint, deletedPoint], zones)

    await transaction.declarantZone.createMany({
      data: [
        {declarantUserId: explicitZone.id, zoneId: department.id, source: 'MANUAL'},
        {declarantUserId: explicitZone.id, zoneId: sage.id, source: 'MIGRATION'},
        {declarantUserId: ignoredZoneLink.id, zoneId: department.id, source: 'DECLARATION'},
        {declarantUserId: ignoredZoneLink.id, zoneId: sage.id, source: 'DECLARATION'},
        {declarantUserId: collecteur.id, zoneId: department.id, source: 'CREATION'},
        {declarantUserId: collecteur.id, zoneId: sage.id, source: 'CREATION'}
      ]
    })
    await transaction.declarantPointPrelevement.create({
      data: {
        declarantUserId: exploitationOnly.id,
        pointPrelevementId: historicalPoint.id,
        usageId: usage.id,
        status: 'EN_ACTIVITE',
        startDate: new Date('2020-01-01T00:00:00.000Z')
      }
    })

    let declarationNumber = 0
    const addChunk = options => {
      declarationNumber++
      return createSourceChunk(transaction, {
        code: `T${String(declarationNumber).padStart(5, '0')}`,
        usageId: usage.id,
        ...options
      })
    }

    const benchmarkChunk = await addChunk({
      declarationPreleveurId: agriculture.id,
      preleveurUserId: agriculture.id,
      dataSourceType: 'MANUAL',
      declarationCreatedAt: new Date('2026-09-02T12:00:00.000Z'),
      pointId: directPoint.id,
      periodStart: new Date('2026-07-31T00:00:00.000Z'),
      periodEnd: new Date('2026-08-02T00:00:00.000Z'),
      value: '0'
    })
    await addChunk({
      sourceType: 'API',
      preleveurUserId: industry.id,
      declarationCreatedAt: new Date('2026-07-15T12:00:00.000Z'),
      pointId: apiPoint.id,
      metricTypeCode: 'relevé d\'index',
      periodStart: new Date('2026-07-31T12:00:00.000Z'),
      periodEnd: new Date('2026-08-01T12:00:00.000Z')
    })
    await addChunk({
      declarationPreleveurId: mixed.id,
      preleveurUserId: mixed.id,
      dataSourceType: 'SPREADSHEET',
      declarationCreatedAt: new Date('2026-08-20T12:00:00.000Z'),
      pointId: mixedDirectPoint.id,
      periodStart: new Date('2026-08-01T00:00:00.000Z'),
      periodEnd: new Date('2026-09-01T00:00:00.000Z')
    })
    await addChunk({
      declarationPreleveurId: mixed.id,
      preleveurUserId: mixed.id,
      dataSourceType: 'API',
      declarationCreatedAt: new Date('2026-07-20T12:00:00.000Z'),
      pointId: mixedApiPoint.id,
      instructionStatus: 'AUTOMATICALLY_VALIDATED',
      metricTypeCode: 'débit prélevé',
      periodStart: new Date('2026-08-14T00:00:00.000Z'),
      periodEnd: new Date('2026-08-15T00:00:00.000Z')
    })
    await addChunk({
      sourceType: 'BATCH',
      preleveurUserId: batch.id,
      declarationCreatedAt: new Date('2026-08-10T12:00:00.000Z'),
      pointId: batchPoint.id,
      instructionStatus: 'VALIDATED',
      periodStart: new Date('2026-08-01T00:00:00.000Z'),
      periodEnd: new Date('2026-09-01T00:00:00.000Z')
    })
    await addChunk({
      sourceType: 'BATCH',
      declarationCreatedAt: new Date('2026-08-05T12:00:00.000Z'),
      pointId: historicalPoint.id,
      periodStart: new Date('2026-06-01T00:00:00.000Z'),
      periodEnd: new Date('2026-07-01T00:00:00.000Z')
    })

    await addChunk({
      sourceType: 'API',
      sourceStatus: 'FAILED',
      preleveurUserId: agriculture.id,
      declarationCreatedAt: new Date('2026-08-01T12:00:00.000Z'),
      pointId: apiPoint.id,
      periodStart: new Date('2025-01-01T00:00:00.000Z'),
      periodEnd: new Date('2025-02-01T00:00:00.000Z')
    })
    await addChunk({
      declarationPreleveurId: rejectedOnly.id,
      preleveurUserId: rejectedOnly.id,
      dataSourceType: 'MANUAL',
      declarationCreatedAt: new Date('2026-08-02T12:00:00.000Z'),
      pointId: apiPoint.id,
      instructionStatus: 'REJECTED',
      periodStart: new Date('2025-02-01T00:00:00.000Z'),
      periodEnd: new Date('2025-03-01T00:00:00.000Z')
    })
    await addChunk({
      declarationPreleveurId: industry.id,
      preleveurUserId: industry.id,
      dataSourceType: 'MANUAL',
      declarationCreatedAt: new Date('2026-08-03T12:00:00.000Z'),
      pointId: mixedDirectPoint.id,
      flowType: 'REJET',
      periodStart: new Date('2025-03-01T00:00:00.000Z'),
      periodEnd: new Date('2025-04-01T00:00:00.000Z')
    })
    await addChunk({
      declarationPreleveurId: batch.id,
      preleveurUserId: batch.id,
      dataSourceType: 'MANUAL',
      declarationCreatedAt: new Date('2026-08-04T12:00:00.000Z'),
      pointId: rejectedPoint.id,
      periodStart: new Date('2024-01-01T00:00:00.000Z'),
      periodEnd: new Date('2024-02-01T00:00:00.000Z')
    })
    await addChunk({
      declarationPreleveurId: batch.id,
      preleveurUserId: batch.id,
      dataSourceType: 'MANUAL',
      declarationCreatedAt: new Date('2026-08-05T12:00:00.000Z'),
      pointId: deletedPoint.id,
      periodStart: new Date('2023-01-01T00:00:00.000Z'),
      periodEnd: new Date('2023-02-01T00:00:00.000Z')
    })
    await addChunk({
      declarationPreleveurId: deletedOwner.id,
      dataSourceType: 'MANUAL',
      declarationCreatedAt: new Date('2026-08-06T12:00:00.000Z'),
      pointId: historicalPoint.id,
      periodStart: new Date('2026-08-01T00:00:00.000Z'),
      periodEnd: new Date('2026-09-01T00:00:00.000Z')
    })

    await createAuditEvent(transaction, {
      actionType: 'ADMIN.USER_UPDATED',
      occurredAt: new Date('2026-03-10T12:00:00.000Z'),
      subjectUserId: administrator.id,
      subjectUserRole: 'ADMIN'
    })
    await createAuditEvent(transaction, {
      actionType: 'AUTH.LOGIN_LINK_REQUESTED',
      occurredAt: new Date('2026-04-15T12:00:00.000Z')
    })
    await createAuditEvent(transaction, {
      actionType: 'AUTH.LOGIN_VERIFIED',
      occurredAt: new Date('2026-05-02T12:00:00.000Z'),
      subjectUserId: agriculture.id,
      subjectUserRole: 'ADMIN'
    })
    await createAuditEvent(transaction, {
      actionType: 'AUTH.PASSWORD_LOGIN_VERIFIED',
      occurredAt: new Date('2026-05-03T12:00:00.000Z'),
      subjectUserId: agriculture.id,
      subjectUserRole: 'DECLARANT'
    })
    await createAuditEvent(transaction, {
      actionType: 'AUTH.LOGIN_VERIFIED',
      occurredAt: new Date('2026-05-05T12:00:00.000Z'),
      subjectUserId: administrator.id,
      subjectUserRole: 'ADMIN'
    })
    await createAuditEvent(transaction, {
      actionType: 'AUTH.LOGIN_VERIFIED',
      occurredAt: new Date('2026-05-06T12:00:00.000Z'),
      outcome: 'FAILURE',
      subjectUserId: industry.id,
      subjectUserRole: 'DECLARANT'
    })
    await createAuditEvent(transaction, {
      actionType: 'AUTH.LOGIN_VERIFIED',
      occurredAt: new Date('2026-06-06T12:00:00.000Z'),
      subjectUserId: deletedOwner.id,
      subjectUserRole: 'DECLARANT'
    })
    await createAuditEvent(transaction, {
      actionType: 'AUTH.PASSWORD_LOGIN_VERIFIED',
      occurredAt: new Date('2026-07-07T12:00:00.000Z'),
      subjectUserId: instructor.id,
      subjectUserRole: 'INSTRUCTOR'
    })
    await createAuditEvent(transaction, {
      actionType: 'AUTH.PASSWORD_ACTIVATED',
      occurredAt: new Date('2026-08-08T12:00:00.000Z'),
      subjectUserId: agriculture.id,
      subjectUserRole: 'DECLARANT'
    })
    await createAuditEvent(transaction, {
      actionType: 'AUTH.LOGIN_VERIFIED',
      occurredAt: new Date('2026-08-09T12:00:00.000Z'),
      subjectUserId: industry.id,
      subjectUserRole: 'DECLARANT'
    })
    await createAuditEvent(transaction, {
      actionType: 'AUTH.LOGIN_VERIFIED',
      occurredAt: new Date('2026-08-10T12:00:00.000Z'),
      subjectUserId: collecteur.id,
      subjectUserRole: 'SERVICE_ACCOUNT'
    })

    if (BENCHMARK_VALUE_COUNT > 0) {
      await addBenchmarkValues(transaction, benchmarkChunk.id, BENCHMARK_VALUE_COUNT)
    }

    const queryStartedAt = performance.now()
    const result = await getPublicStats({
      month: TEST_MONTH,
      client: transaction,
      now: TEST_NOW
    })
    const queryDurationMs = performance.now() - queryStartedAt

    if (BENCHMARK_VALUE_COUNT > 0) {
      const planRows = await transaction.$queryRaw(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${buildPublicStatsDataQuery(TEST_MONTH)}`
      )
      const plan = planRows[0]['QUERY PLAN'][0]
      t.is(Number(plan.Plan['Actual Rows']), 1)
      console.log('[PUBLIC_STATS_SQL_BENCHMARK]', JSON.stringify({
        values: BENCHMARK_VALUE_COUNT,
        requestDurationMs: Math.round(queryDurationMs * 10) / 10,
        explainPlanningMs: plan['Planning Time'],
        explainExecutionMs: plan['Execution Time'],
        resultRows: plan.Plan['Actual Rows']
      }))
    }

    t.is(result.month, TEST_MONTH)
    t.is(result.generatedAt, TEST_NOW.toISOString())
    t.deepEqual(result.availableMonths, ['2026-06', '2026-07', '2026-08'])
    t.deepEqual(result.totals, {
      pointsCount: 6,
      preleveursCount: 7,
      sageCount: 1,
      departmentCount: 1
    })
    t.deepEqual(result.territories.DEPARTEMENT, [expectedTerritory(department)])
    t.deepEqual(result.territories.SAGE, [expectedTerritory(sage)])
    t.deepEqual(result.channels, [
      {key: 'DIRECT', label: 'Directement dans l’outil', count: 1, percentage: 25},
      {key: 'THIRD_PARTY', label: 'Via un outil tiers', count: 1, percentage: 25},
      {key: 'MIXED', label: 'Les deux canaux à parts égales', count: 1, percentage: 25},
      {key: 'UNKNOWN', label: 'Canal non renseigné', count: 1, percentage: 25}
    ])
    t.deepEqual(result.connections, {
      availableSince: '2026-04-15T12:00:00.000Z',
      months: [
        {month: '2026-03', administration: null, declarants: null, total: null, status: 'unavailable'},
        {month: '2026-04', administration: 0, declarants: 0, total: 0, status: 'partial'},
        {month: '2026-05', administration: 1, declarants: 1, total: 2, status: 'available'},
        {month: '2026-06', administration: 0, declarants: 1, total: 1, status: 'available'},
        {month: '2026-07', administration: 1, declarants: 0, total: 1, status: 'available'},
        {month: '2026-08', administration: 0, declarants: 2, total: 2, status: 'available'}
      ]
    })
  })

  t.is(await client.user.count({where: {firstName: runId}}), 0)
  t.is(await client.user.count(), previousUserCount)
})
