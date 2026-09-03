import test from 'ava'

import {buildGrivaiseDataset} from '../lib/grivaise-dataset.js'
import {
  buildExpectedOwnedContentDigests,
  buildExpectedOwnedContentRecords
} from '../lib/seed-content-digest.js'
import {collectSeedState} from '../lib/seed-state.js'
import {verifySeedState} from '../lib/seed-verifier.js'

const ZONE_PERMISSION_CODES = ['zone.read', 'zone.write']
const READ_ONLY_ZONE_PERMISSIONS = ['zone.read']
const ACCOUNTS = Object.freeze({
  ddt: 'ddt@grivaise.example',
  sage: 'sage@grivaise.example',
  ougc: 'ougc@grivaise.example',
  industrial: 'industrie@grivaise.example',
  aep: 'aep@grivaise.example',
  irrigant: 'irrigant@grivaise.example'
})

function groupBy(items, getKey) {
  const groups = new Map()

  for (const item of items) {
    const key = getKey(item)
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }

  return groups
}

function buildRows(dataset) {
  const contentRecords = buildExpectedOwnedContentRecords(dataset)
  const preleveurIds = new Map(
    dataset.preleveurs.map(item => [item.sourceId, item.id])
  )
  const pointsBySourceId = new Map(
    dataset.points.map(item => [item.sourceId, item])
  )
  const exploitationsByPoint = groupBy(
    dataset.exploitations,
    item => item.pointSourceId
  )
  const exploitationsBySourceId = new Map(
    dataset.exploitations.map(item => [item.sourceId, item])
  )
  const metersByPoint = groupBy(dataset.meters, item => item.pointSourceId)
  const permissionsFor = access => access === 'FULL'
    ? ZONE_PERMISSION_CODES
    : READ_ONLY_ZONE_PERMISSIONS
  const preleveurEmails = new Map([
    [dataset.personas.industriel.preleveurSourceId, ACCOUNTS.industrial],
    [dataset.personas.aep.preleveurSourceId, ACCOUNTS.aep],
    [dataset.personas.irrigant.preleveurSourceId, ACCOUNTS.irrigant]
  ])
  const declarationsById = new Map(
    contentRecords.declarations.map(declaration => [declaration.id, declaration])
  )
  const chunksBySourceId = groupBy(contentRecords.chunks, chunk => chunk.sourceId)
  const valuesByChunkId = groupBy(contentRecords.values, value => value.chunkId)

  return {
    declarants: [
      ...dataset.preleveurs.map(preleveur => ({
        userId: preleveur.id,
        sourceId: preleveur.sourceId,
        declarantRole: 'PRELEVEUR',
        preleveurType: preleveur.type,
        user: {
          email: preleveurEmails.get(preleveur.sourceId) ?? null,
          deletedAt: null
        }
      })),
      {
        userId: dataset.personas.ougc.id,
        sourceId: dataset.personas.ougc.collectorSourceId,
        declarantRole: 'COLLECTEUR',
        preleveurType: null,
        user: {email: ACCOUNTS.ougc, deletedAt: null}
      }
    ],
    declarations: contentRecords.declarations,
    points: dataset.points.map(point => ({
      id: point.id,
      sourceId: point.sourceId,
      coordinates: {
        type: point.coordinates.type,
        coordinates: [...point.coordinates.coordinates]
      },
      waterBodyType: point.waterBodyType,
      deletedAt: null,
      zones: [
        {zone: {code: dataset.zone.code, type: 'SAGE'}},
        {zone: {code: point.departmentCode, type: 'DEPARTEMENT'}}
      ],
      declarants: (exploitationsByPoint.get(point.sourceId) ?? [])
        .map(exploitation => ({
          sourceId: exploitation.sourceId,
          declarantUserId: preleveurIds.get(exploitation.preleveurSourceId),
          usage: {code: exploitation.usageCode, parent: null}
        })),
      compteurs: (metersByPoint.get(point.sourceId) ?? []).map(meter => ({
        compteur: {
          identifier: meter.identifier,
          serialNumber: meter.serialNumber,
          deletedAt: null
        }
      }))
    })),
    exploitations: dataset.exploitations.map(exploitation => ({
      id: exploitation.id,
      sourceId: exploitation.sourceId,
      declarantUserId: preleveurIds.get(exploitation.preleveurSourceId),
      pointPrelevementId: pointsBySourceId.get(exploitation.pointSourceId).id,
      status: 'EN_ACTIVITE',
      usage: {code: exploitation.usageCode, parent: null}
    })),
    meters: dataset.meters.map(meter => ({
      id: meter.id,
      identifier: meter.identifier,
      serialNumber: meter.serialNumber,
      deletedAt: null
    })),
    meterPointLinks: dataset.meters.map(meter => ({
      id: `${meter.id}:link`,
      compteurId: meter.id,
      pointPrelevementId: pointsBySourceId.get(meter.pointSourceId).id,
      startDate: new Date(`${meter.installedAt}T00:00:00.000Z`),
      endDate: meter.removedAt
        ? new Date(`${meter.removedAt}T00:00:00.000Z`)
        : null,
      compteur: {identifier: meter.identifier}
    })),
    collectorLinks: dataset.collectorLinks.flatMap(link =>
      link.exploitationSourceIds.map(sourceId => {
        const exploitation = exploitationsBySourceId.get(sourceId)

        return {
          collecteur: {sourceId: dataset.personas.ougc.collectorSourceId},
          exploitation: {
            sourceId,
            declarantUserId: preleveurIds.get(exploitation.preleveurSourceId)
          }
        }
      })),
    sources: contentRecords.sources.map(source => ({
      ...source,
      declaration: declarationsById.get(source.declarationId),
      chunks: (chunksBySourceId.get(source.id) ?? []).map(chunk => ({
        ...chunk,
        usage: {code: chunk.usageCode, parent: null},
        chunkValues: valuesByChunkId.get(chunk.id) ?? [],
        _count: {chunkValues: valuesByChunkId.get(chunk.id)?.length ?? 0}
      }))
    })),
    chunkValues: [
      {periodStart: new Date('2025-01-01T00:00:00.000Z')},
      {periodStart: new Date('2026-01-01T00:00:00.000Z')}
    ],
    instructors: ['ddt', 'sage'].map(key => {
      const persona = dataset.personas[key]

      return {
        userId: persona.id,
        sourceId: `${dataset.metadata.sourcePrefix}instructor-${key}`,
        user: {
          id: persona.id,
          email: ACCOUNTS[key],
          role: 'INSTRUCTOR',
          deletedAt: null
        },
        instructorZones: persona.permissions.map(permission => ({
          isAdmin: permission.access === 'FULL',
          startDate: new Date('2020-01-01T00:00:00.000Z'),
          endDate: null,
          zone: {
            code: permission.zoneCode,
            type: permission.zoneCode.startsWith('dep-') ? 'DEPARTEMENT' : 'SAGE'
          },
          permissions: permissionsFor(permission.access)
            .map(value => ({permission: value}))
        }))
      }
    })
  }
}

function buildDatabase(rows, zonesTotal = 1, authentication = {}) {
  const calls = {}
  const mock = (name, value) => async query => {
    calls[name] ??= []
    calls[name].push(query)
    return value
  }

  const authenticationCount = (key, fallback = 0) => authentication[key] ?? fallback
  const countEmailVerifications = async query => {
    calls['userEmailVerification.count'] ??= []
    calls['userEmailVerification.count'].push(query)

    return query.where.status
      ? authenticationCount('activeEmailVerifications')
      : authenticationCount('emailVerificationTokens')
  }

  const queryRawUnsafe = async (sql, serializedExpectedPoints) => {
    calls.$queryRawUnsafe ??= []
    calls.$queryRawUnsafe.push([sql, serializedExpectedPoints])

    const pointsById = new Map(rows.points.map(point => [point.id, point]))
    const matchingPointCoordinates = JSON.parse(serializedExpectedPoints)
      .filter(expected => {
        const actual = pointsById.get(expected.id)
        return actual?.sourceId === expected.sourceId
          && actual.deletedAt === null
          && JSON.stringify(actual.coordinates) === JSON.stringify(expected.coordinates)
      })
      .length

    return [{matchingPointCoordinates}]
  }

  return {
    calls,
    database: {
      $queryRawUnsafe: queryRawUnsafe,
      zone: {count: mock('zone.count', zonesTotal)},
      user: {count: mock('user.count', authenticationCount('personaUsers', 6))},
      userEmailAlias: {
        count: mock('userEmailAlias.count', authenticationCount('emailAliases'))
      },
      userEmailIdentity: {
        count: mock(
          'userEmailIdentity.count',
          authenticationCount('emailIdentityClaims')
        )
      },
      userEmailVerification: {count: countEmailVerifications},
      passwordCredential: {
        count: mock(
          'passwordCredential.count',
          authenticationCount('passwordCredentials')
        )
      },
      passwordActivation: {
        count: mock(
          'passwordActivation.count',
          authenticationCount('passwordActivations')
        )
      },
      authToken: {count: mock('authToken.count', authenticationCount('authTokens'))},
      sessionToken: {
        count: mock('sessionToken.count', authenticationCount('sessionTokens'))
      },
      declarant: {findMany: mock('declarant.findMany', rows.declarants)},
      declaration: {findMany: mock('declaration.findMany', rows.declarations)},
      pointPrelevement: {findMany: mock('pointPrelevement.findMany', rows.points)},
      declarantPointPrelevement: {
        findMany: mock('declarantPointPrelevement.findMany', rows.exploitations)
      },
      compteur: {findMany: mock('compteur.findMany', rows.meters)},
      compteurPointPrelevement: {
        findMany: mock('compteurPointPrelevement.findMany', rows.meterPointLinks)
      },
      declarantCollecteurExploitation: {
        findMany: mock(
          'declarantCollecteurExploitation.findMany',
          rows.collectorLinks
        )
      },
      source: {findMany: mock('source.findMany', rows.sources)},
      chunkValue: {findMany: mock('chunkValue.findMany', rows.chunkValues)},
      instructor: {findMany: mock('instructor.findMany', rows.instructors)}
    }
  }
}

async function collect(database, dataset) {
  return collectSeedState({
    database,
    dataset,
    accounts: ACCOUNTS,
    zonePermissionCodes: ZONE_PERMISSION_CODES,
    readOnlyZonePermissions: READ_ONLY_ZONE_PERMISSIONS
  })
}

test('collecte depuis Prisma exactement le contrat vérifié', async t => {
  const dataset = buildGrivaiseDataset()
  const rows = buildRows(dataset)
  const {database, calls} = buildDatabase(rows)
  const state = await collect(database, dataset)

  t.deepEqual(state, {
    accounts: {matching: 6},
    authentication: {
      personaUsers: 6,
      emailAliases: 0,
      emailIdentityClaims: 0,
      activeEmailVerifications: 0,
      emailVerificationTokens: 0,
      passwordCredentials: 0,
      passwordActivations: 0,
      authTokens: 0,
      sessionTokens: 0
    },
    zones: {total: 1},
    preleveurs: {
      total: 300,
      byType: {IRRIGANT: 240, ICPE: 30, GESTIONNAIRE_AEP: 30},
      active: 210
    },
    points: {
      total: 800,
      byUsageCode: {2: 700, 4: 50, 5: 50},
      byDepartmentCode: {'dep-38': 400, 'dep-26': 400},
      byWaterBodyType: {SUPERFICIELLE: 400, SOUTERRAIN: 400},
      shared: {total: 1, preleveurs: 2},
      multiMeter: {total: 1, meters: 2},
      declared: 560
    },
    ougc: {managedPreleveurs: 200},
    cohorts: {MONTHLY: 150, WEEKLY: 40, DAILY: 20},
    years: [2025, 2026],
    integrity: {
      expected: {
        declarations: 420,
        sources: 420,
        chunks: 1124,
        values: 48_288,
        exploitations: 801,
        meters: 801,
        meterPointLinks: 801,
        matchingMeterPointLinks: 801,
        matchingPointCoordinates: 800,
        matchedPointYears: 1120,
        unexpectedMatchedPointYears: 0,
        gidafUnassociated: 4,
        gidafUnassociatedWithValues: 4,
        gidafUnassociatedPendingWithValues: 4,
        contentDigests: buildExpectedOwnedContentDigests(dataset)
      },
      actual: {
        declarations: 420,
        sources: 420,
        completedSources: 420,
        chunks: 1124,
        values: 48_288,
        exploitations: 801,
        meters: 801,
        meterPointLinks: 801,
        matchingMeterPointLinks: 801,
        matchingPointCoordinates: 800,
        matchedPointYears: 1120,
        unexpectedMatchedPointYears: 0,
        gidafUnassociated: 4,
        gidafUnassociatedWithValues: 4,
        gidafUnassociatedPendingWithValues: 4,
        contentDigests: buildExpectedOwnedContentDigests(dataset)
      }
    },
    gidaf: {
      unassociated: 4,
      unassociatedWithValues: 4,
      unassociatedPendingWithValues: 4
    },
    agents: {
      total: 2,
      ddt: {
        total: 1,
        role: 'INSTRUCTOR',
        assignments: 2,
        unexpectedAssignments: 0,
        zonesExact: true,
        isAdminExact: true,
        permissionsExact: true,
        departmentAccess: 'FULL',
        sageAccess: 'READ_ONLY'
      },
      sage: {
        total: 1,
        role: 'INSTRUCTOR',
        assignments: 1,
        unexpectedAssignments: 0,
        zonesExact: true,
        isAdminExact: true,
        permissionsExact: true,
        sageAccess: 'FULL'
      }
    }
  })
  t.true(verifySeedState(state).success)
  t.deepEqual(
    calls['instructor.findMany'][0].where.userId,
    {in: [dataset.personas.ddt.id, dataset.personas.sage.id]}
  )
  t.true(calls['source.findMany'][0].where.OR.some(filter =>
    filter.metadata?.path?.join('.') === 'fixture.datasetId'
    && filter.metadata.equals === dataset.metadata.id))
  t.is(
    calls['chunkValue.findMany'][0].where.chunk.sourceId.in.length,
    dataset.declarations.length
  )
  t.regex(calls.$queryRawUnsafe[0][0], /ST_Equals/)
  t.is(JSON.parse(calls.$queryRawUnsafe[0][1]).length, dataset.points.length)
})

test('signale une coordonnée de point dérivée à cardinalité constante', async t => {
  const dataset = buildGrivaiseDataset()
  const rows = buildRows(dataset)
  rows.points[0].coordinates.coordinates[0] += 0.000_001

  const state = await collect(buildDatabase(rows).database, dataset)
  const verification = verifySeedState(state)

  t.is(state.integrity.actual.matchingPointCoordinates, 799)
  t.false(verification.success)
  t.true(verification.errors.some(error =>
    error.code === 'integrity.matching_point_coordinates'))
})

test('réapplique le bornage du dataset aux résultats Prisma', async t => {
  const dataset = buildGrivaiseDataset()
  const rows = buildRows(dataset)
  rows.declarants.push({
    userId: 'foreign-user',
    sourceId: 'foreign:preleveur',
    declarantRole: 'PRELEVEUR',
    preleveurType: 'IRRIGANT',
    user: {deletedAt: null}
  })
  rows.points.push({
    id: 'foreign-point',
    sourceId: 'foreign:point',
    waterBodyType: 'SUPERFICIELLE',
    deletedAt: null,
    zones: [],
    declarants: [],
    compteurs: []
  })
  rows.collectorLinks.push({
    collecteur: {sourceId: 'foreign:collector'},
    exploitation: {
      sourceId: dataset.collectorLinks[0].exploitationSourceIds[0],
      declarantUserId: dataset.preleveurs[0].id
    }
  })
  rows.sources.push({
    id: 'foreign-source',
    status: 'COMPLETED',
    metadata: {
      fixture: {
        datasetId: dataset.metadata.id,
        sourceId: 'foreign:declaration',
        cadence: 'DAILY'
      }
    },
    declaration: {importSourceId: 'foreign:declaration', type: 'gidaf'},
    chunks: [{
      pointPrelevementId: null,
      preleveurUserId: dataset.preleveurs[0].id,
      _count: {chunkValues: 1}
    }]
  })
  rows.instructors.push({
    userId: 'foreign-instructor',
    sourceId: `${dataset.metadata.sourcePrefix}instructor-foreign`,
    user: {id: 'foreign-instructor', email: 'foreign@demo.invalid', deletedAt: null},
    instructorZones: []
  })

  const state = await collect(buildDatabase(rows).database, dataset)

  t.true(verifySeedState(state).success)
  t.is(state.gidaf.unassociated, 4)
  t.is(state.agents.total, 2)
})

test('signale un droit SAGE DDT personnalisé au vérificateur', async t => {
  const dataset = buildGrivaiseDataset()
  const rows = buildRows(dataset)
  const ddt = rows.instructors.find(item => item.userId === dataset.personas.ddt.id)
  const sageAssignment = ddt.instructorZones.find(item =>
    item.zone.code === dataset.zone.code)
  sageAssignment.permissions = [{permission: 'zone.unexpected'}]

  const state = await collect(buildDatabase(rows).database, dataset)
  const verification = verifySeedState(state)

  t.is(state.agents.ddt.sageAccess, 'CUSTOM')
  t.false(verification.success)
  t.true(verification.errors.some(error =>
    error.code === 'agents.ddt.sage_access'))
})

test('signale une affectation hors contrat du persona DDT', async t => {
  const dataset = buildGrivaiseDataset()
  const rows = buildRows(dataset)
  const ddt = rows.instructors.find(item => item.userId === dataset.personas.ddt.id)
  ddt.instructorZones.push({
    isAdmin: false,
    startDate: new Date('2020-01-01T00:00:00.000Z'),
    endDate: null,
    zone: {code: 'dep-26', type: 'DEPARTEMENT'},
    permissions: [{permission: 'zone.read'}]
  })

  const state = await collect(buildDatabase(rows).database, dataset)
  const verification = verifySeedState(state)

  t.is(state.agents.ddt.assignments, 3)
  t.is(state.agents.ddt.unexpectedAssignments, 1)
  t.false(state.agents.ddt.zonesExact)
  t.false(verification.success)
  t.true(verification.errors.some(error =>
    error.code === 'agents.ddt.unexpected_assignments'))
})

test('signale un rôle ou un indicateur administrateur incorrect', async t => {
  const dataset = buildGrivaiseDataset()
  const rows = buildRows(dataset)
  const sage = rows.instructors.find(item => item.userId === dataset.personas.sage.id)
  sage.user.role = 'ADMIN'
  sage.instructorZones[0].isAdmin = false

  const state = await collect(buildDatabase(rows).database, dataset)
  const verification = verifySeedState(state)

  t.is(state.agents.sage.role, 'ADMIN')
  t.false(state.agents.sage.isAdminExact)
  t.false(verification.success)
  t.true(verification.errors.some(error => error.code === 'agents.sage.role'))
  t.true(verification.errors.some(error => error.code === 'agents.sage.is_admin_exact'))
})

test('signale un mapping de compte incorrect sans exposer les emails', async t => {
  const dataset = buildGrivaiseDataset()
  const rows = buildRows(dataset)
  const industrial = rows.declarants.find(item =>
    item.sourceId === dataset.personas.industriel.preleveurSourceId)
  industrial.user.email = 'ancienne-adresse@grivaise.example'

  const state = await collect(buildDatabase(rows).database, dataset)
  const verification = verifySeedState(state)

  t.deepEqual(state.accounts, {matching: 5})
  t.false(verification.success)
  t.is(verification.errors[0].code, 'accounts.matching')
  t.false(JSON.stringify(state).includes(industrial.user.email))
  t.false(JSON.stringify(verification).includes(industrial.user.email))
})

test('signale tout artefact d’authentification durable restant sur les personas', async t => {
  const dataset = buildGrivaiseDataset()
  const rows = buildRows(dataset)
  const authentication = {
    emailAliases: 1,
    emailIdentityClaims: 1,
    activeEmailVerifications: 1,
    emailVerificationTokens: 1,
    passwordCredentials: 1,
    passwordActivations: 1,
    authTokens: 1,
    sessionTokens: 1
  }

  const state = await collect(buildDatabase(rows, 1, authentication).database, dataset)
  const verification = verifySeedState(state)
  const serialized = JSON.stringify({state, verification})

  t.false(verification.success)
  t.deepEqual(
    verification.errors.map(error => error.code),
    [
      'authentication.email_aliases',
      'authentication.email_identity_claims',
      'authentication.active_email_verifications',
      'authentication.email_verification_tokens',
      'authentication.password_credentials',
      'authentication.password_activations'
    ]
  )
  t.is(state.authentication.authTokens, 1)
  t.is(state.authentication.sessionTokens, 1)
  t.false(serialized.includes(ACCOUNTS.ddt))
  t.false(serialized.includes('tokenHash'))
})

test('signale les déclarations, sources et valeurs manquantes', async t => {
  const dataset = buildGrivaiseDataset()
  const rows = buildRows(dataset)
  rows.declarations.pop()
  rows.sources[0].status = 'PENDING'
  rows.sources[1].chunks[0]._count.chunkValues -= 1

  const state = await collect(buildDatabase(rows).database, dataset)
  const errorCodes = new Set(verifySeedState(state).errors.map(error => error.code))

  t.true(errorCodes.has('integrity.declarations'))
  t.true(errorCodes.has('integrity.completed_sources'))
  t.true(errorCodes.has('integrity.values'))
})

const constantCardinalityContentDrifts = [
  {
    label: 'un volume',
    expectedCode: 'integrity.content_digest.values',
    mutate(rows) {
      const value = rows.sources[0].chunks[0].chunkValues[0]
      value.value = String(Number(value.value) + 1)
    }
  },
  {
    label: 'une période et sa fréquence',
    expectedCode: 'integrity.content_digest.values',
    mutate(rows) {
      const value = rows.sources[0].chunks[0].chunkValues[0]
      value.periodStart = new Date('2025-01-02T00:00:00.000Z')
      value.frequency = '1 day'
    }
  },
  {
    label: 'le type et l’auteur d’une déclaration',
    expectedCode: 'integrity.content_digest.declarations',
    mutate(rows) {
      rows.sources[0].declaration.type = 'api'
      rows.sources[0].declaration.createdByDeclarantUserId = null
    }
  },
  {
    label: 'le type de source de données',
    expectedCode: 'integrity.content_digest.declarations',
    mutate(rows) {
      rows.sources[0].declaration.dataSourceType = 'API'
    }
  },
  {
    label: 'les métadonnées de source et la cadence',
    expectedCode: 'integrity.content_digest.sources',
    mutate(rows) {
      rows.sources[0].metadata.sourceCode = 'ALTERED'
      rows.sources[0].metadata.fixture.cadence = 'DAILY'
    }
  },
  {
    label: 'les métadonnées d’une ligne',
    expectedCode: 'integrity.content_digest.chunks',
    mutate(rows) {
      rows.sources[0].chunks[0].metadata.fixture.cadence = 'DAILY'
    }
  }
]

for (const drift of constantCardinalityContentDrifts) {
  test(`signale à cardinalité constante ${drift.label}`, async t => {
    const dataset = buildGrivaiseDataset()
    const rows = buildRows(dataset)
    drift.mutate(rows)

    const state = await collect(buildDatabase(rows).database, dataset)
    const verification = verifySeedState(state)
    const errorCodes = verification.errors.map(error => error.code)

    t.false(verification.success)
    t.true(errorCodes.includes(drift.expectedCode))
    t.is(state.integrity.actual.declarations, 420)
    t.is(state.integrity.actual.sources, 420)
    t.is(state.integrity.actual.chunks, 1124)
    t.is(state.integrity.actual.values, 48_288)
    t.regex(state.integrity.actual.contentDigests[drift.expectedCode.split('.').at(-1)], /^[a-f\d]{64}$/)
  })
}

test('signale un rapprochement point-année hors dataset', async t => {
  const dataset = buildGrivaiseDataset()
  const rows = buildRows(dataset)
  const declaredPointSourceIds = new Set(dataset.declarations.flatMap(declaration =>
    declaration.chunks.map(chunk => chunk.pointSourceId).filter(Boolean)))
  const undeclaredPoint = dataset.points.find(point =>
    !declaredPointSourceIds.has(point.sourceId))
  const source = rows.sources.find(item =>
    item.chunks.some(chunk => chunk.pointPrelevementId !== null))
  const chunk = source.chunks.find(item => item.pointPrelevementId !== null)
  chunk.pointPrelevementId = undeclaredPoint.id

  const state = await collect(buildDatabase(rows).database, dataset)
  const errorCodes = new Set(verifySeedState(state).errors.map(error => error.code))

  t.is(state.integrity.actual.matchedPointYears, 1119)
  t.is(state.integrity.actual.unexpectedMatchedPointYears, 1)
  t.true(errorCodes.has('integrity.matched_point_years'))
  t.true(errorCodes.has('integrity.unexpected_matched_point_years'))
})

test('signale un GIDAF non rapproché qui n’est plus en attente', async t => {
  const dataset = buildGrivaiseDataset()
  const rows = buildRows(dataset)
  const gidafSource = rows.sources.find(source =>
    source.declaration.type === 'gidaf'
    && source.chunks.some(chunk => chunk.pointPrelevementId === null))
  const chunk = gidafSource.chunks.find(item => item.pointPrelevementId === null)
  chunk.instructionStatus = 'VALIDATED'

  const state = await collect(buildDatabase(rows).database, dataset)
  const verification = verifySeedState(state)

  t.is(state.gidaf.unassociated, 4)
  t.is(state.gidaf.unassociatedWithValues, 4)
  t.is(state.gidaf.unassociatedPendingWithValues, 3)
  t.deepEqual(
    verification.errors.map(error => error.code),
    [
      'gidaf.unassociated_pending_with_values',
      'integrity.content_digest.chunks'
    ]
  )
})

test('signale un lien compteur-point détourné', async t => {
  const dataset = buildGrivaiseDataset()
  const rows = buildRows(dataset)
  const link = rows.meterPointLinks[0]
  link.pointPrelevementId = dataset.points.find(point =>
    point.id !== link.pointPrelevementId).id

  const state = await collect(buildDatabase(rows).database, dataset)
  const verification = verifySeedState(state)

  t.is(state.integrity.actual.meterPointLinks, 801)
  t.is(state.integrity.actual.matchingMeterPointLinks, 800)
  t.true(verification.errors.some(error =>
    error.code === 'integrity.matching_meter_point_links'))
})

test('ne consulte pas les valeurs sans source possédée', async t => {
  const dataset = buildGrivaiseDataset()
  const rows = buildRows(dataset)
  rows.sources = []
  const {database, calls} = buildDatabase(rows)

  const state = await collect(database, dataset)

  t.is(state.preleveurs.active, 0)
  t.is(state.points.declared, 0)
  t.deepEqual(state.cohorts, {MONTHLY: 0, WEEKLY: 0, DAILY: 0})
  t.deepEqual(state.years, [])
  t.is(calls['chunkValue.findMany'], undefined)
})

test('refuse un client Prisma ou des permissions incomplets', async t => {
  const dataset = buildGrivaiseDataset()
  const rows = buildRows(dataset)
  const {database} = buildDatabase(rows)
  delete database.chunkValue

  await t.throwsAsync(
    collectSeedState({
      database,
      dataset,
      accounts: ACCOUNTS,
      zonePermissionCodes: ZONE_PERMISSION_CODES,
      readOnlyZonePermissions: READ_ONLY_ZONE_PERMISSIONS
    }),
    {message: 'database.chunkValue.findMany est requis.'}
  )
  await t.throwsAsync(
    collectSeedState({
      database: buildDatabase(rows).database,
      dataset,
      accounts: ACCOUNTS,
      zonePermissionCodes: [],
      readOnlyZonePermissions: READ_ONLY_ZONE_PERMISSIONS
    }),
    {message: 'zonePermissionCodes doit être une liste non vide de chaînes.'}
  )
})
