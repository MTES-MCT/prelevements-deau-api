import {
  buildActualOwnedContentDigests,
  buildExpectedOwnedContentDigests
} from './seed-content-digest.js'

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} doit être un objet.`)
  }
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} doit être une chaîne non vide.`)
  }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0
    || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${label} doit être une liste non vide de chaînes.`)
  }
}

const ACCOUNT_KEYS = Object.freeze([
  'ddt',
  'sage',
  'ougc',
  'industrial',
  'aep',
  'irrigant'
])
const ACTIVE_EMAIL_VERIFICATION_STATUSES = ['PENDING', 'SEND_FAILED']

function assertAccounts(accounts) {
  assertRecord(accounts, 'accounts')

  for (const key of ACCOUNT_KEYS) {
    assertString(accounts[key], `accounts.${key}`)
  }
}

function assertDatabase(database) {
  assertRecord(database, 'database')

  if (typeof database.$queryRawUnsafe !== 'function') {
    throw new TypeError('database.$queryRawUnsafe est requis.')
  }

  const methods = [
    ['zone', 'count'],
    ['user', 'count'],
    ['userEmailAlias', 'count'],
    ['userEmailIdentity', 'count'],
    ['userEmailVerification', 'count'],
    ['passwordCredential', 'count'],
    ['passwordActivation', 'count'],
    ['authToken', 'count'],
    ['sessionToken', 'count'],
    ['declarant', 'findMany'],
    ['declaration', 'findMany'],
    ['declarantPointPrelevement', 'findMany'],
    ['pointPrelevement', 'findMany'],
    ['compteur', 'findMany'],
    ['compteurPointPrelevement', 'findMany'],
    ['declarantCollecteurExploitation', 'findMany'],
    ['source', 'findMany'],
    ['chunkValue', 'findMany'],
    ['instructor', 'findMany']
  ]

  for (const [model, method] of methods) {
    if (typeof database[model]?.[method] !== 'function') {
      throw new TypeError(`database.${model}.${method} est requis.`)
    }
  }
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.length > 0))]
}

function datasetContract(dataset) {
  assertRecord(dataset, 'dataset')
  assertRecord(dataset.metadata, 'dataset.metadata')
  assertString(dataset.metadata.id, 'dataset.metadata.id')
  assertString(dataset.metadata.sourcePrefix, 'dataset.metadata.sourcePrefix')
  assertRecord(dataset.zone, 'dataset.zone')
  assertString(dataset.zone.id, 'dataset.zone.id')
  assertString(dataset.zone.code, 'dataset.zone.code')
  assertRecord(dataset.personas, 'dataset.personas')
  assertRecord(dataset.personas.ddt, 'dataset.personas.ddt')
  assertRecord(dataset.personas.sage, 'dataset.personas.sage')
  assertRecord(dataset.personas.ougc, 'dataset.personas.ougc')
  assertRecord(dataset.personas.industriel, 'dataset.personas.industriel')
  assertRecord(dataset.personas.aep, 'dataset.personas.aep')
  assertRecord(dataset.personas.irrigant, 'dataset.personas.irrigant')
  assertString(dataset.personas.ougc.collectorSourceId, 'dataset.personas.ougc.collectorSourceId')
  assertString(dataset.personas.industriel.preleveurSourceId, 'dataset.personas.industriel.preleveurSourceId')
  assertString(dataset.personas.aep.preleveurSourceId, 'dataset.personas.aep.preleveurSourceId')
  assertString(dataset.personas.irrigant.preleveurSourceId, 'dataset.personas.irrigant.preleveurSourceId')

  for (const property of [
    'preleveurs',
    'points',
    'exploitations',
    'collectorLinks',
    'meters',
    'declarations'
  ]) {
    if (!Array.isArray(dataset[property])) {
      throw new TypeError(`dataset.${property} doit être une liste.`)
    }
  }

  const preleveurSourceIds = uniqueStrings(dataset.preleveurs.map(item => item.sourceId))
  const pointSourceIds = uniqueStrings(dataset.points.map(item => item.sourceId))
  const exploitationSourceIds = uniqueStrings(dataset.exploitations.map(item => item.sourceId))
  const exploitationIds = uniqueStrings(dataset.exploitations.map(item => item.id))
  const declarationIds = uniqueStrings(dataset.declarations.map(item => item.id))
  const declarationSourceIds = uniqueStrings(dataset.declarations.map(item => item.sourceId))
  const declarationImportSourceIds = uniqueStrings(dataset.declarations.map(item => item.importSourceId))
  const meterIdentifiers = uniqueStrings(
    dataset.meters.map(item => item.identifier ?? item.sourceId)
  )
  const meterIds = uniqueStrings(dataset.meters.map(item => item.id))
  const meterSerialNumbers = uniqueStrings(dataset.meters.map(item => item.serialNumber))
  const collectorExploitationSourceIds = uniqueStrings(
    dataset.collectorLinks.flatMap(item => item.exploitationSourceIds ?? [])
  )
  const preleveursBySourceId = new Map(dataset.preleveurs.map(item => [item.sourceId, item]))
  const pointsBySourceId = new Map(dataset.points.map(item => [item.sourceId, item]))
  const personaPreleveurSourceIds = {
    industrial: dataset.personas.industriel.preleveurSourceId,
    aep: dataset.personas.aep.preleveurSourceId,
    irrigant: dataset.personas.irrigant.preleveurSourceId
  }
  const personaUserIds = uniqueStrings([
    dataset.personas.ddt.id,
    dataset.personas.sage.id,
    dataset.personas.ougc.id,
    ...Object.values(personaPreleveurSourceIds)
      .map(sourceId => preleveursBySourceId.get(sourceId)?.id)
  ])
  const expectedMatchedPointYears = new Set(dataset.declarations.flatMap(declaration =>
    declaration.chunks
      .filter(chunk => chunk.pointSourceId !== null)
      .map(chunk => `${declaration.year}:${pointsBySourceId.get(chunk.pointSourceId)?.id}`)))

  return {
    datasetId: dataset.metadata.id,
    sourcePrefix: dataset.metadata.sourcePrefix,
    zoneId: dataset.zone.id,
    zoneCode: dataset.zone.code,
    preleveurSourceIds,
    pointSourceIds,
    exploitationIds,
    exploitationSourceIds,
    declarationIds,
    declarationSourceIds,
    declarationImportSourceIds,
    declarationsByImportSourceId: new Map(
      dataset.declarations.map(item => [item.importSourceId, item])
    ),
    meterIds,
    meterIdentifiers,
    meterSerialNumbers,
    expectedMatchedPointYears,
    exploitationsBySourceId: new Map(dataset.exploitations.map(item => [item.sourceId, item])),
    preleveursBySourceId,
    pointsBySourceId,
    metersByIdentifier: new Map(dataset.meters.map(item => [
      item.identifier ?? item.sourceId,
      item
    ])),
    collectorSourceId: dataset.personas.ougc.collectorSourceId,
    collectorExploitationSourceIds,
    ddtPersona: dataset.personas.ddt,
    sagePersona: dataset.personas.sage,
    instructorUserIds: [dataset.personas.ddt.id, dataset.personas.sage.id],
    personaPreleveurSourceIds,
    personaUserIds,
    expectedIntegrity: {
      ...buildExpectedIntegrity(dataset),
      contentDigests: buildExpectedOwnedContentDigests(dataset)
    }
  }
}

function buildExpectedIntegrity(dataset) {
  const chunks = dataset.declarations.flatMap(declaration =>
    declaration.chunks.map(chunk => ({declaration, chunk})))
  const matchedPointYears = new Set(chunks
    .filter(({chunk}) => chunk.pointSourceId !== null)
    .map(({declaration, chunk}) => `${declaration.year}:${chunk.pointSourceId}`))
  const gidafUnassociated = chunks.filter(({declaration, chunk}) =>
    declaration.type === 'gidaf' && chunk.pointSourceId === null).length

  return {
    declarations: dataset.declarations.length,
    sources: dataset.declarations.length,
    chunks: chunks.length,
    values: chunks.reduce((sum, {chunk}) => sum + chunk.values.length, 0),
    exploitations: dataset.exploitations.length,
    meters: dataset.meters.length,
    meterPointLinks: dataset.meters.length,
    matchingMeterPointLinks: dataset.meters.length,
    matchingPointCoordinates: dataset.points.length,
    matchedPointYears: matchedPointYears.size,
    unexpectedMatchedPointYears: 0,
    gidafUnassociated,
    gidafUnassociatedWithValues: gidafUnassociated,
    gidafUnassociatedPendingWithValues: gidafUnassociated
  }
}

async function countMatchingPointCoordinates(database, dataset) {
  const expectedPoints = dataset.points.map(point => ({
    id: point.id,
    sourceId: point.sourceId,
    coordinates: point.coordinates
  }))
  const rows = await database.$queryRawUnsafe(`
    WITH expected_points AS (
      SELECT
        (item->>'id')::uuid AS id,
        item->>'sourceId' AS source_id,
        ST_SetSRID(
          ST_GeomFromGeoJSON((item->'coordinates')::text),
          4326
        )::geometry(Point, 4326) AS coordinates
      FROM jsonb_array_elements($1::jsonb) input(item)
    )
    SELECT count(*) FILTER (
      WHERE point.id IS NOT NULL
        AND point."sourceId" = expected.source_id
        AND point."deletedAt" IS NULL
        AND point.coordinates IS NOT NULL
        AND ST_Equals(point.coordinates, expected.coordinates)
    )::integer AS "matchingPointCoordinates"
    FROM expected_points expected
    LEFT JOIN "PointPrelevement" point ON point.id = expected.id
  `, JSON.stringify(expectedPoints))

  const count = Number(rows[0]?.matchingPointCoordinates ?? 0)
  return Number.isInteger(count) && count >= 0 ? count : 0
}

function countBy(items, getKey, expectedKeys) {
  const counts = Object.fromEntries(expectedKeys.map(key => [key, 0]))

  for (const item of items) {
    const key = getKey(item)

    if (Object.hasOwn(counts, key)) {
      counts[key] += 1
    }
  }

  return counts
}

function rootUsageCode(exploitation) {
  return exploitation.usage?.parent?.code ?? exploitation.usage?.code
}

function isNotDeleted(value) {
  return value?.deletedAt === null || value?.deletedAt === undefined
}

function ownedMeterCount(point, meterIdentifiers, meterSerialNumbers) {
  return new Set((point.compteurs ?? [])
    .map(link => link.compteur)
    .filter(compteur => compteur && isNotDeleted(compteur))
    .filter(compteur => meterIdentifiers.has(compteur.identifier)
      || meterSerialNumbers.has(compteur.serialNumber))
    .map(compteur => compteur.identifier ?? compteur.serialNumber))
    .size
}

function pointState(points, contract, preleveurUserIds) {
  const ownedPointSourceIds = new Set(contract.pointSourceIds)
  const ownedExploitationSourceIds = new Set(contract.exploitationSourceIds)
  const meterIdentifiers = new Set(contract.meterIdentifiers)
  const meterSerialNumbers = new Set(contract.meterSerialNumbers)
  const ownedPoints = points.filter(point => ownedPointSourceIds.has(point.sourceId) && isNotDeleted(point))

  const pointDetails = ownedPoints.map(point => {
    const exploitations = (point.declarants ?? [])
      .filter(exploitation => ownedExploitationSourceIds.has(exploitation.sourceId))
    const preleveurs = new Set(exploitations
      .map(exploitation => exploitation.declarantUserId)
      .filter(userId => preleveurUserIds.has(userId)))
    const usageCodes = uniqueStrings(exploitations.map(rootUsageCode)).sort()
    const departmentCodes = new Set((point.zones ?? [])
      .map(link => link.zone?.code)
      .filter(Boolean))

    return {
      point,
      usageCode: usageCodes.length === 1 ? usageCodes[0] : undefined,
      departmentCodes,
      preleveurs,
      meterCount: ownedMeterCount(point, meterIdentifiers, meterSerialNumbers)
    }
  })

  const usageCounts = countBy(pointDetails, item => item.usageCode, ['2', '4', '5'])
  const waterBodyCounts = countBy(
    pointDetails,
    item => item.point.waterBodyType,
    ['SUPERFICIELLE', 'SOUTERRAIN']
  )
  const sharedPoints = pointDetails.filter(item => item.preleveurs.size > 1)
  const multiMeterPoints = pointDetails.filter(item => item.meterCount > 1)

  return {
    ownedPoints,
    normalized: {
      total: ownedPoints.length,
      byUsageCode: usageCounts,
      byDepartmentCode: {
        'dep-38': pointDetails.filter(item => item.departmentCodes.has('dep-38')).length,
        'dep-26': pointDetails.filter(item => item.departmentCodes.has('dep-26')).length
      },
      byWaterBodyType: waterBodyCounts,
      shared: {
        total: sharedPoints.length,
        preleveurs: sharedPoints.length === 1 ? sharedPoints[0].preleveurs.size : 0
      },
      multiMeter: {
        total: multiMeterPoints.length,
        meters: multiMeterPoints.length === 1 ? multiMeterPoints[0].meterCount : 0
      }
    }
  }
}

function exploitationState(exploitations, contract) {
  const ownedSourceIds = new Set(contract.exploitationSourceIds)
  const matching = exploitations.filter(exploitation => {
    const expected = contract.exploitationsBySourceId.get(exploitation.sourceId)
    const expectedPreleveur = contract.preleveursBySourceId.get(expected?.preleveurSourceId)
    const expectedPoint = contract.pointsBySourceId.get(expected?.pointSourceId)

    return ownedSourceIds.has(exploitation.sourceId)
      && exploitation.id === expected?.id
      && exploitation.declarantUserId === expectedPreleveur?.id
      && exploitation.pointPrelevementId === expectedPoint?.id
      && exploitation.status === 'EN_ACTIVITE'
      && rootUsageCode(exploitation) === expected?.usageCode
  })

  return {total: matching.length}
}

function declarationRecordState(declarations, contract) {
  return {
    total: declarations.filter(declaration => {
      const expected = contract.declarationsByImportSourceId.get(declaration.importSourceId)
      return declaration.id === expected?.id
        && declaration.processingStatus === 'COMPLETED'
    }).length
  }
}

function sameInstant(left, right) {
  const leftDate = left ? new Date(left) : null
  const rightDate = right ? new Date(right) : null

  return leftDate?.getTime() === rightDate?.getTime()
}

function meterState(meters, meterPointLinks, contract) {
  const expectedIdentifiers = new Set(contract.meterIdentifiers)
  const matchingMeters = meters.filter(meter => {
    const expected = contract.metersByIdentifier.get(meter.identifier)
    return expectedIdentifiers.has(meter.identifier)
      && meter.id === expected?.id
      && meter.serialNumber === expected?.serialNumber
      && isNotDeleted(meter)
  })
  const matchingMeterIds = new Set(matchingMeters.map(item => item.id))
  const matchingLinks = meterPointLinks.filter(link => {
    const expected = contract.metersByIdentifier.get(link.compteur?.identifier)
    const expectedPoint = contract.pointsBySourceId.get(expected?.pointSourceId)
    const expectedEndDate = expected?.removedAt ? new Date(expected.removedAt) : null

    return matchingMeterIds.has(link.compteurId)
      && link.compteurId === expected?.id
      && link.pointPrelevementId === expectedPoint?.id
      && sameInstant(link.startDate, new Date(expected?.installedAt))
      && sameInstant(link.endDate, expectedEndDate)
  })

  return {
    meters: matchingMeters.length,
    meterPointLinks: meterPointLinks.length,
    matchingMeterPointLinks: matchingLinks.length
  }
}

function metadataDatasetId(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined
  }

  if (typeof metadata.dataset === 'string') {
    return metadata.dataset
  }

  return metadata.dataset?.id
    ?? metadata.datasetId
    ?? metadata.fixture?.datasetId
    ?? metadata.seed?.dataset
    ?? metadata.seedDataset
}

function metadataCadence(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined
  }

  const value = metadata.cadence
    ?? metadata.fixture?.cadence
    ?? metadata.reporting?.cadence
    ?? metadata.seed?.cadence
  const normalized = String(value ?? '').trim().toUpperCase()

  const aliases = {
    MONTH: 'MONTHLY',
    MONTHLY: 'MONTHLY',
    '1 MONTH': 'MONTHLY',
    WEEK: 'WEEKLY',
    WEEKLY: 'WEEKLY',
    '1 WEEK': 'WEEKLY',
    DAY: 'DAILY',
    DAILY: 'DAILY',
    '1 DAY': 'DAILY'
  }

  return aliases[normalized]
}

function metadataSourceId(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined
  }

  return metadata.fixture?.sourceId
    ?? metadata.sourceId
    ?? metadata.seed?.sourceId
}

function isOwnedSource(source, contract, importSourceIds, sourceIds) {
  return importSourceIds.has(source.declaration?.importSourceId)
    || (metadataDatasetId(source.metadata) === contract.datasetId
      && sourceIds.has(metadataSourceId(source.metadata)))
}

function chunkHasValues(chunk) {
  if (typeof chunk?._count?.chunkValues === 'number') {
    return chunk._count.chunkValues > 0
  }

  return Array.isArray(chunk?.chunkValues) && chunk.chunkValues.length > 0
}

function declarationState(sources, contract, preleveurUserIds, pointIds) {
  const importSourceIds = new Set(contract.declarationImportSourceIds)
  const sourceIds = new Set(contract.declarationSourceIds)
  const ownedSources = sources.filter(source =>
    isOwnedSource(source, contract, importSourceIds, sourceIds))
  const completedSources = ownedSources.filter(source => source.status === 'COMPLETED')
  const activePreleveurIds = new Set()
  const declaredPointIds = new Set()
  const matchedPointYears = new Set()
  const cohortUserIds = new Map([
    ['MONTHLY', new Set()],
    ['WEEKLY', new Set()],
    ['DAILY', new Set()]
  ])
  let chunks = 0
  let values = 0
  let gidafUnassociated = 0
  let gidafUnassociatedWithValues = 0
  let gidafUnassociatedPendingWithValues = 0

  for (const source of ownedSources) {
    const cadence = metadataCadence(source.metadata)
    const year = source.metadata?.fixture?.year
    const isGidaf = source.declaration?.type === 'gidaf'
    const completed = source.status === 'COMPLETED'

    for (const chunk of source.chunks ?? []) {
      const hasValues = chunkHasValues(chunk)
      const valueCount = chunk._count?.chunkValues ?? chunk.chunkValues?.length ?? 0
      chunks += 1
      values += valueCount

      if (completed && hasValues && preleveurUserIds.has(chunk.preleveurUserId)) {
        activePreleveurIds.add(chunk.preleveurUserId)
        cohortUserIds.get(cadence)?.add(chunk.preleveurUserId)
      }

      if (completed && hasValues && pointIds.has(chunk.pointPrelevementId)) {
        declaredPointIds.add(chunk.pointPrelevementId)
      }

      if (hasValues && pointIds.has(chunk.pointPrelevementId)
        && Number.isInteger(year)) {
        matchedPointYears.add(`${year}:${chunk.pointPrelevementId}`)
      }

      if (isGidaf && chunk.pointPrelevementId === null) {
        gidafUnassociated += 1
        if (hasValues) {
          gidafUnassociatedWithValues += 1
          if (chunk.instructionStatus === 'PENDING') {
            gidafUnassociatedPendingWithValues += 1
          }
        }
      }
    }
  }

  return {
    sourceIds: ownedSources.map(source => source.id),
    sources: ownedSources.length,
    completedSources: completedSources.length,
    chunks,
    values,
    matchedPointYears: [...matchedPointYears]
      .filter(key => contract.expectedMatchedPointYears.has(key)).length,
    unexpectedMatchedPointYears: [...matchedPointYears]
      .filter(key => !contract.expectedMatchedPointYears.has(key)).length,
    activePreleveurs: activePreleveurIds.size,
    declaredPoints: declaredPointIds.size,
    cohorts: Object.fromEntries(
      [...cohortUserIds].map(([cadence, userIds]) => [cadence, userIds.size])
    ),
    gidafUnassociated,
    gidafUnassociatedWithValues,
    gidafUnassociatedPendingWithValues,
    contentDigests: buildActualOwnedContentDigests(ownedSources)
  }
}

function sameStringSet(actual, expected) {
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)

  return actualSet.size === expectedSet.size
    && [...expectedSet].every(value => actualSet.has(value))
}

function permissionAccess(assignment, zonePermissionCodes, readOnlyZonePermissions) {
  if (!assignment) {
    return 'MISSING'
  }

  const permissions = uniqueStrings((assignment.permissions ?? [])
    .map(item => item.permission ?? item))

  if (sameStringSet(permissions, zonePermissionCodes)) {
    return 'FULL'
  }

  if (sameStringSet(permissions, readOnlyZonePermissions)) {
    return 'READ_ONLY'
  }

  return 'CUSTOM'
}

function isActiveAssignment(assignment, now) {
  const start = assignment.startDate ? new Date(assignment.startDate) : null
  const end = assignment.endDate ? new Date(assignment.endDate) : null

  return (!start || start <= now) && (!end || end >= now)
}

function personaMatches(instructor, persona) {
  return instructor.userId === persona.id
    || instructor.user?.id === persona.id
    || instructor.user?.email === persona.email
}

function personaPermissionCodes(persona, access) {
  return (persona.permissions ?? [])
    .filter(item => item.access === access)
    .map(item => item.zoneCode)
}

function findAssignment(instructor, zoneCodes, now) {
  const expectedCodes = new Set(zoneCodes)

  return (instructor?.instructorZones ?? []).find(assignment =>
    expectedCodes.has(assignment.zone?.code)
    && isActiveAssignment(assignment, now))
}

function expectedPermissions(access, zonePermissionCodes, readOnlyZonePermissions) {
  return access === 'FULL' ? zonePermissionCodes : readOnlyZonePermissions
}

function personaAssignmentState(
  instructor,
  persona,
  zonePermissionCodes,
  readOnlyZonePermissions
) {
  const assignments = instructor?.instructorZones ?? []
  const expectedByZoneCode = new Map((persona.permissions ?? []).map(permission => [
    permission.zoneCode,
    {
      isAdmin: permission.access === 'FULL',
      permissions: expectedPermissions(
        permission.access,
        zonePermissionCodes,
        readOnlyZonePermissions
      )
    }
  ]))
  const expectedAssignments = assignments.filter(assignment =>
    expectedByZoneCode.has(assignment.zone?.code))

  return {
    role: instructor?.user?.role ?? 'MISSING',
    assignments: assignments.length,
    unexpectedAssignments: assignments.length - expectedAssignments.length,
    zonesExact: assignments.length === expectedByZoneCode.size
      && sameStringSet(
        assignments.map(assignment => assignment.zone?.code),
        [...expectedByZoneCode.keys()]
      ),
    isAdminExact: expectedAssignments.every(assignment =>
      assignment.isAdmin === expectedByZoneCode.get(assignment.zone.code).isAdmin),
    permissionsExact: expectedAssignments.every(assignment =>
      sameStringSet(
        uniqueStrings((assignment.permissions ?? []).map(item => item.permission ?? item)),
        expectedByZoneCode.get(assignment.zone.code).permissions
      ))
  }
}

function agentState(instructors, contract, zonePermissionCodes, readOnlyZonePermissions) {
  const ownedInstructors = instructors
    .filter(instructor => instructor.sourceId?.startsWith(contract.sourcePrefix))
    .filter(instructor => isNotDeleted(instructor.user))
    .filter(instructor => personaMatches(instructor, contract.ddtPersona)
      || personaMatches(instructor, contract.sagePersona))
  const ddtInstructors = ownedInstructors.filter(instructor =>
    personaMatches(instructor, contract.ddtPersona))
  const sageInstructors = ownedInstructors.filter(instructor =>
    personaMatches(instructor, contract.sagePersona))
  const now = new Date()
  const ddtDepartmentCodes = personaPermissionCodes(contract.ddtPersona, 'FULL')
    .filter(code => code !== contract.zoneCode)
  const ddtSageCodes = personaPermissionCodes(contract.ddtPersona, 'READ_ONLY')
  const sageCodes = personaPermissionCodes(contract.sagePersona, 'FULL')
  const ddtState = personaAssignmentState(
    ddtInstructors[0],
    contract.ddtPersona,
    zonePermissionCodes,
    readOnlyZonePermissions
  )
  const sageState = personaAssignmentState(
    sageInstructors[0],
    contract.sagePersona,
    zonePermissionCodes,
    readOnlyZonePermissions
  )

  return {
    total: ownedInstructors.length,
    ddt: {
      ...ddtState,
      total: ddtInstructors.length,
      departmentAccess: permissionAccess(
        findAssignment(ddtInstructors[0], ddtDepartmentCodes, now),
        zonePermissionCodes,
        readOnlyZonePermissions
      ),
      sageAccess: permissionAccess(
        findAssignment(ddtInstructors[0], ddtSageCodes, now),
        zonePermissionCodes,
        readOnlyZonePermissions
      )
    },
    sage: {
      ...sageState,
      total: sageInstructors.length,
      sageAccess: permissionAccess(
        findAssignment(sageInstructors[0], sageCodes, now),
        zonePermissionCodes,
        readOnlyZonePermissions
      )
    }
  }
}

function accountState(declarants, instructors, contract, accounts) {
  const declarantBySourceId = new Map(declarants.map(item => [item.sourceId, item]))
  const instructorByUserId = new Map(instructors.map(item => [item.userId, item]))
  const expectedPairs = [
    [accounts.ddt, instructorByUserId.get(contract.ddtPersona.id)?.user?.email],
    [accounts.sage, instructorByUserId.get(contract.sagePersona.id)?.user?.email],
    [accounts.ougc, declarantBySourceId.get(contract.collectorSourceId)?.user?.email],
    [
      accounts.industrial,
      declarantBySourceId.get(contract.personaPreleveurSourceIds.industrial)?.user?.email
    ],
    [accounts.aep, declarantBySourceId.get(contract.personaPreleveurSourceIds.aep)?.user?.email],
    [
      accounts.irrigant,
      declarantBySourceId.get(contract.personaPreleveurSourceIds.irrigant)?.user?.email
    ]
  ]

  return {
    matching: expectedPairs.filter(([expected, actual]) => actual === expected).length
  }
}

async function authenticationState(database, contract) {
  const userWhere = {userId: {in: contract.personaUserIds}}
  const personaUsers = await database.user.count({
    where: {id: {in: contract.personaUserIds}}
  })
  const emailAliases = await database.userEmailAlias.count({where: userWhere})
  const emailIdentityClaims = await database.userEmailIdentity.count({
    where: {
      OR: [
        {aliasUserId: {in: contract.personaUserIds}},
        {verificationUserId: {in: contract.personaUserIds}}
      ]
    }
  })
  const activeEmailVerifications = await database.userEmailVerification.count({
    where: {
      ...userWhere,
      status: {in: ACTIVE_EMAIL_VERIFICATION_STATUSES}
    }
  })
  const emailVerificationTokens = await database.userEmailVerification.count({
    where: {
      ...userWhere,
      tokenHash: {not: null}
    }
  })
  const passwordCredentials = await database.passwordCredential.count({where: userWhere})
  const passwordActivations = await database.passwordActivation.count({where: userWhere})
  const authTokens = await database.authToken.count({where: userWhere})
  const sessionTokens = await database.sessionToken.count({
    where: {
      OR: [
        userWhere,
        {impersonatedByUserId: {in: contract.personaUserIds}}
      ]
    }
  })

  return {
    personaUsers,
    emailAliases,
    emailIdentityClaims,
    activeEmailVerifications,
    emailVerificationTokens,
    passwordCredentials,
    passwordActivations,
    authTokens,
    sessionTokens
  }
}

function sourceQuery(contract) {
  return {
    where: {
      OR: [
        {
          declaration: {
            importSourceId: {in: contract.declarationImportSourceIds}
          }
        },
        {
          metadata: {
            path: ['dataset'],
            equals: contract.datasetId
          }
        },
        {
          metadata: {
            path: ['datasetId'],
            equals: contract.datasetId
          }
        },
        {
          metadata: {
            path: ['fixture', 'datasetId'],
            equals: contract.datasetId
          }
        }
      ]
    },
    select: {
      id: true,
      type: true,
      status: true,
      globalInstructionStatus: true,
      metadata: true,
      declarationId: true,
      declaration: {
        select: {
          id: true,
          code: true,
          declarantUserId: true,
          createdByDeclarantUserId: true,
          autoValidationEnabled: true,
          importSourceId: true,
          type: true,
          comment: true,
          dataSourceType: true,
          waterWithdrawalType: true,
          consolidatedAt: true,
          processingStatus: true,
          processingJobId: true,
          processingAttemptCount: true,
          processingQueuedAt: true,
          processingStartedAt: true,
          processingCompletedAt: true,
          processingFailedAt: true,
          processingError: true,
          createdAt: true
        }
      },
      chunks: {
        select: {
          id: true,
          sourceId: true,
          pointPrelevementName: true,
          pointPrelevementId: true,
          flowType: true,
          preleveurUserId: true,
          submittedByDeclarantUserId: true,
          collecteurUserId: true,
          instructionStatus: true,
          instructedAt: true,
          instructedByInstructorUserId: true,
          instructionComment: true,
          parsingInfo: true,
          minDate: true,
          maxDate: true,
          metadata: true,
          usage: {
            select: {
              code: true,
              parent: {select: {code: true}}
            }
          },
          chunkValues: {
            select: {
              id: true,
              chunkId: true,
              metricTypeCode: true,
              unit: true,
              frequency: true,
              periodStart: true,
              periodEnd: true,
              valueKind: true,
              value: true
            }
          },
          _count: {
            select: {chunkValues: true}
          }
        }
      }
    }
  }
}

export async function collectSeedState({
  database,
  dataset,
  accounts,
  zonePermissionCodes,
  readOnlyZonePermissions
}) {
  assertDatabase(database)
  assertAccounts(accounts)
  assertStringArray(zonePermissionCodes, 'zonePermissionCodes')
  assertStringArray(readOnlyZonePermissions, 'readOnlyZonePermissions')

  const contract = datasetContract(dataset)
  const zonesTotal = await database.zone.count({
    where: {
      id: contract.zoneId,
      code: contract.zoneCode,
      type: 'SAGE'
    }
  })
  const authentication = await authenticationState(database, contract)
  const declarants = await database.declarant.findMany({
    where: {
      sourceId: {
        in: [...contract.preleveurSourceIds, contract.collectorSourceId]
      },
      user: {deletedAt: null}
    },
    select: {
      userId: true,
      sourceId: true,
      declarantRole: true,
      preleveurType: true,
      user: {select: {email: true, deletedAt: true}}
    }
  })
  const declarations = await database.declaration.findMany({
    where: {
      OR: [
        {id: {in: contract.declarationIds}},
        {importSourceId: {in: contract.declarationImportSourceIds}}
      ]
    },
    select: {
      id: true,
      importSourceId: true,
      processingStatus: true
    }
  })
  const points = await database.pointPrelevement.findMany({
    where: {
      sourceId: {in: contract.pointSourceIds},
      deletedAt: null
    },
    select: {
      id: true,
      sourceId: true,
      waterBodyType: true,
      deletedAt: true,
      zones: {
        select: {
          zone: {
            select: {
              code: true,
              type: true
            }
          }
        }
      },
      declarants: {
        where: {sourceId: {in: contract.exploitationSourceIds}},
        select: {
          sourceId: true,
          declarantUserId: true,
          usage: {
            select: {
              code: true,
              parent: {select: {code: true}}
            }
          }
        }
      },
      compteurs: {
        select: {
          compteur: {
            select: {
              identifier: true,
              serialNumber: true,
              deletedAt: true
            }
          }
        }
      }
    }
  })
  const matchingPointCoordinates = await countMatchingPointCoordinates(database, dataset)
  const exploitations = await database.declarantPointPrelevement.findMany({
    where: {
      OR: [
        {id: {in: contract.exploitationIds}},
        {sourceId: {in: contract.exploitationSourceIds}}
      ]
    },
    select: {
      id: true,
      sourceId: true,
      declarantUserId: true,
      pointPrelevementId: true,
      status: true,
      usage: {
        select: {
          code: true,
          parent: {select: {code: true}}
        }
      }
    }
  })
  const meters = await database.compteur.findMany({
    where: {
      OR: [
        {id: {in: contract.meterIds}},
        {identifier: {in: contract.meterIdentifiers}}
      ]
    },
    select: {
      id: true,
      identifier: true,
      serialNumber: true,
      deletedAt: true
    }
  })
  const meterPointLinks = await database.compteurPointPrelevement.findMany({
    where: {
      OR: [
        {compteurId: {in: contract.meterIds}},
        {compteur: {identifier: {in: contract.meterIdentifiers}}}
      ]
    },
    select: {
      id: true,
      compteurId: true,
      pointPrelevementId: true,
      startDate: true,
      endDate: true,
      compteur: {
        select: {
          identifier: true
        }
      }
    }
  })
  const collectorLinks = await database.declarantCollecteurExploitation.findMany({
    where: {
      collecteur: {sourceId: contract.collectorSourceId},
      exploitation: {
        sourceId: {in: contract.collectorExploitationSourceIds}
      }
    },
    select: {
      collecteur: {select: {sourceId: true}},
      exploitation: {
        select: {
          sourceId: true,
          declarantUserId: true
        }
      }
    }
  })
  const sources = await database.source.findMany(sourceQuery(contract))
  const instructors = await database.instructor.findMany({
    where: {
      userId: {in: contract.instructorUserIds},
      user: {deletedAt: null}
    },
    select: {
      userId: true,
      sourceId: true,
      user: {
        select: {
          id: true,
          email: true,
          role: true,
          deletedAt: true
        }
      },
      instructorZones: {
        select: {
          isAdmin: true,
          startDate: true,
          endDate: true,
          zone: {
            select: {
              code: true,
              type: true
            }
          },
          permissions: {
            select: {permission: true}
          }
        }
      }
    }
  })

  const preleveurSourceIds = new Set(contract.preleveurSourceIds)
  const preleveurs = declarants.filter(declarant =>
    preleveurSourceIds.has(declarant.sourceId)
    && declarant.declarantRole === 'PRELEVEUR'
    && isNotDeleted(declarant.user))
  const preleveurUserIds = new Set(preleveurs.map(item => item.userId))
  const preleveursByType = countBy(
    preleveurs,
    item => item.preleveurType,
    ['IRRIGANT', 'ICPE', 'GESTIONNAIRE_AEP']
  )
  const pointsResult = pointState(points, contract, preleveurUserIds)
  const exploitationResult = exploitationState(exploitations, contract)
  const declarationRecordResult = declarationRecordState(declarations, contract)
  const meterResult = meterState(meters, meterPointLinks, contract)
  const pointIds = new Set(pointsResult.ownedPoints.map(point => point.id))
  const declarationsResult = declarationState(
    sources,
    contract,
    preleveurUserIds,
    pointIds
  )
  const ownedSourceIds = new Set(declarationsResult.sourceIds)
  const valuePeriods = ownedSourceIds.size === 0
    ? []
    : await database.chunkValue.findMany({
      where: {
        chunk: {
          sourceId: {in: [...ownedSourceIds]}
        }
      },
      select: {periodStart: true},
      distinct: ['periodStart']
    })
  const years = [...new Set(valuePeriods
    .map(item => new Date(item.periodStart))
    .filter(date => !Number.isNaN(date.getTime()))
    .map(date => date.getUTCFullYear()))]
    .sort((left, right) => left - right)
  const ownedCollectorExploitationSourceIds = new Set(contract.collectorExploitationSourceIds)
  const managedPreleveurIds = new Set(collectorLinks
    .filter(link => link.collecteur?.sourceId === contract.collectorSourceId)
    .filter(link => ownedCollectorExploitationSourceIds.has(link.exploitation?.sourceId))
    .map(link => link.exploitation?.declarantUserId)
    .filter(userId => preleveurUserIds.has(userId)))

  return {
    accounts: accountState(declarants, instructors, contract, accounts),
    authentication,
    zones: {total: zonesTotal},
    preleveurs: {
      total: preleveurs.length,
      byType: preleveursByType,
      active: declarationsResult.activePreleveurs
    },
    points: {
      ...pointsResult.normalized,
      declared: declarationsResult.declaredPoints
    },
    ougc: {managedPreleveurs: managedPreleveurIds.size},
    cohorts: declarationsResult.cohorts,
    years,
    integrity: {
      expected: contract.expectedIntegrity,
      actual: {
        declarations: declarationRecordResult.total,
        sources: declarationsResult.sources,
        completedSources: declarationsResult.completedSources,
        chunks: declarationsResult.chunks,
        values: declarationsResult.values,
        exploitations: exploitationResult.total,
        meters: meterResult.meters,
        meterPointLinks: meterResult.meterPointLinks,
        matchingMeterPointLinks: meterResult.matchingMeterPointLinks,
        matchingPointCoordinates,
        matchedPointYears: declarationsResult.matchedPointYears,
        unexpectedMatchedPointYears: declarationsResult.unexpectedMatchedPointYears,
        gidafUnassociated: declarationsResult.gidafUnassociated,
        gidafUnassociatedWithValues: declarationsResult.gidafUnassociatedWithValues,
        gidafUnassociatedPendingWithValues:
          declarationsResult.gidafUnassociatedPendingWithValues,
        contentDigests: declarationsResult.contentDigests
      }
    },
    gidaf: {
      unassociated: declarationsResult.gidafUnassociated,
      unassociatedWithValues: declarationsResult.gidafUnassociatedWithValues,
      unassociatedPendingWithValues:
        declarationsResult.gidafUnassociatedPendingWithValues
    },
    agents: agentState(
      instructors,
      contract,
      zonePermissionCodes,
      readOnlyZonePermissions
    )
  }
}
