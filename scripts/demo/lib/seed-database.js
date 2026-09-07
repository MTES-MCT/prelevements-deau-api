import {createHash} from 'node:crypto'
import pgPkg from 'pg'

import {
  READ_ONLY_ZONE_PERMISSIONS,
  ZONE_PERMISSION_CODES
} from '../../../lib/constants/zone-permissions.js'
import {resetPersonaAuthentication} from './seed-authentication.js'

const SEED_LOCK_NAME = 'partageonsleau:demo-seed:grivaise-v1'
const TRANSACTION_TIMEOUT_MS = 15 * 60_000
const REPEATABLE_READ = 'RepeatableRead'
const TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 30_000,
  timeout: TRANSACTION_TIMEOUT_MS
})
const VALUE_COLLISION_BATCH_SIZE = 5000
const CREATE_MANY_BATCH_SIZE = 5000
const DAY_IN_MILLISECONDS = 86_400_000
const PREFLIGHT_ZONE_GEOMETRY = Symbol('preflightZoneGeometry')
const {Client} = pgPkg

const FREQUENCIES = Object.freeze({
  MONTHLY: '1 month',
  WEEKLY: '1 week',
  DAILY: '1 day'
})

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} doit être un objet`)
  }
}

function assertFunction(value, label) {
  if (typeof value !== 'function') {
    throw new TypeError(`${label} est requis`)
  }
}

function assertDatabase(database, {transaction = false} = {}) {
  assertRecord(database, 'database')
  assertFunction(database.$queryRawUnsafe, 'database.$queryRawUnsafe')

  if (transaction) {
    assertFunction(database.$transaction, 'database.$transaction')
    assertFunction(database.$executeRawUnsafe, 'database.$executeRawUnsafe')
  }
}

async function runSeedLockedTransaction({database, operation}) {
  assertDatabase(database, {transaction: true})
  assertFunction(operation, 'operation')

  return database.$transaction(async transaction => {
    await transaction.$executeRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',
      SEED_LOCK_NAME
    )

    return operation(transaction)
  }, TRANSACTION_OPTIONS)
}

function defaultLockClientFactory(options) {
  return new Client(options)
}

function assertLockClient(client) {
  assertRecord(client, 'lockClient')
  assertFunction(client.connect, 'lockClient.connect')
  assertFunction(client.query, 'lockClient.query')
  assertFunction(client.end, 'lockClient.end')
}

export async function withSeedStateSnapshot({
  database,
  databaseUrl,
  collect,
  createLockClient = defaultLockClientFactory
}) {
  assertDatabase(database, {transaction: true})
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) {
    throw new TypeError('databaseUrl est requis')
  }

  assertFunction(collect, 'collect')
  assertFunction(createLockClient, 'createLockClient')

  const lockClient = await createLockClient({connectionString: databaseUrl})
  assertLockClient(lockClient)
  let lockAcquired = false
  let state
  let operationError

  try {
    await lockClient.connect()
    await lockClient.query(
      'SELECT pg_advisory_lock(hashtext($1)::bigint)',
      [SEED_LOCK_NAME]
    )
    lockAcquired = true
    state = await database.$transaction(
      transaction => collect(transaction),
      {...TRANSACTION_OPTIONS, isolationLevel: REPEATABLE_READ}
    )
  } catch (error) {
    operationError = error
  }

  let cleanupError
  if (lockAcquired) {
    try {
      await lockClient.query(
        'SELECT pg_advisory_unlock(hashtext($1)::bigint)',
        [SEED_LOCK_NAME]
      )
    } catch (error) {
      cleanupError = error
    }
  }

  try {
    await lockClient.end()
  } catch (error) {
    cleanupError ??= error
  }

  if (operationError) {
    throw operationError
  }

  if (cleanupError) {
    throw cleanupError
  }

  return state
}

function assertDataset(dataset) {
  assertRecord(dataset, 'dataset')
  assertRecord(dataset.metadata, 'dataset.metadata')
  assertRecord(dataset.zone, 'dataset.zone')
  assertRecord(dataset.personas, 'dataset.personas')

  if (!dataset.metadata.id || !dataset.metadata.sourcePrefix) {
    throw new Error('Le jeu doit définir metadata.id et metadata.sourcePrefix')
  }

  for (const property of [
    'preleveurs',
    'points',
    'exploitations',
    'collectorLinks',
    'meters',
    'declarations'
  ]) {
    if (!Array.isArray(dataset[property])) {
      throw new TypeError(`dataset.${property} doit être une liste`)
    }
  }
}

function assertAccounts(accounts) {
  assertRecord(accounts, 'accounts')

  for (const key of ['ddt', 'sage', 'ougc', 'industrial', 'aep', 'irrigant']) {
    if (typeof accounts[key] !== 'string' || !accounts[key].trim()) {
      throw new Error(`accounts.${key} est requis`)
    }
  }
}

function normalizeJson(value) {
  if (value instanceof Date) {
    return value.toISOString()
  }

  if (value && typeof value === 'object' && typeof value.toJSON === 'function') {
    return value.toJSON()
  }

  if (Array.isArray(value)) {
    return value.map(normalizeJson)
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeJson(item)])
    )
  }

  return value
}

function stableStringify(value) {
  return JSON.stringify(normalizeJson(value))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function datasetSha256(dataset) {
  return sha256(stableStringify(dataset))
}

export function deterministicUuid(datasetId, key) {
  const hex = sha256(`${datasetId}:${key}`)
  const variant = (Number.parseInt(hex[16], 16) % 4 + 8).toString(16)

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32)
  ].join('-')
}

function dateOnly(value) {
  return new Date(`${value}T00:00:00.000Z`)
}

function addUtcDay(date) {
  return new Date(date.getTime() + DAY_IN_MILLISECONDS)
}

function asNumber(value) {
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0)
}

function parseJsonColumn(value) {
  return typeof value === 'string' ? JSON.parse(value) : value
}

function chunkArray(items, size) {
  const chunks = []

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }

  return chunks
}

function equalValue(left, right) {
  return stableStringify(left) === stableStringify(right)
}

function buildDescriptors(dataset, accounts) {
  const preleveurBySourceId = new Map(
    dataset.preleveurs.map(preleveur => [preleveur.sourceId, preleveur])
  )
  const pointBySourceId = new Map(dataset.points.map(point => [point.sourceId, point]))
  const exploitationBySourceId = new Map(
    dataset.exploitations.map(exploitation => [exploitation.sourceId, exploitation])
  )
  const personaAccountKeys = {
    ddt: 'ddt',
    sage: 'sage',
    ougc: 'ougc',
    industriel: 'industrial',
    aep: 'aep',
    irrigant: 'irrigant'
  }
  const userDescriptors = dataset.preleveurs.map(preleveur => {
    const persona = preleveur.personaKey
      ? dataset.personas[preleveur.personaKey]
      : null

    return {
      id: preleveur.id,
      kind: 'declarant',
      sourceId: preleveur.sourceId,
      email: persona ? accounts[personaAccountKeys[persona.key]] : null,
      role: 'DECLARANT',
      firstName: persona?.firstName ?? null,
      lastName: persona?.lastName ?? null,
      declarantRole: 'PRELEVEUR',
      preleveurType: preleveur.type,
      socialReason: preleveur.name,
      reporting: preleveur.reporting
    }
  })
  const collectorPersona = dataset.personas.ougc
  userDescriptors.push({
    id: collectorPersona.id,
    kind: 'declarant',
    sourceId: collectorPersona.collectorSourceId,
    email: accounts.ougc,
    role: 'DECLARANT',
    firstName: collectorPersona.firstName ?? 'Olivia',
    lastName: collectorPersona.lastName ?? 'OUGC Grivaise',
    declarantRole: 'COLLECTEUR',
    preleveurType: null,
    socialReason: 'OUGC Grivaise fictif'
  })

  for (const key of ['ddt', 'sage']) {
    const persona = dataset.personas[key]
    userDescriptors.push({
      id: persona.id,
      kind: 'instructor',
      sourceId: `${dataset.metadata.sourcePrefix}instructor-${key}`,
      email: accounts[key],
      role: 'INSTRUCTOR',
      firstName: persona.firstName,
      lastName: persona.lastName
    })
  }

  const sourceDescriptors = dataset.declarations.map(declaration => ({
    id: deterministicUuid(dataset.metadata.id, `${declaration.sourceId}:source`),
    declarationId: declaration.id,
    declarationSourceId: declaration.sourceId
  }))
  const sourceByDeclarationSourceId = new Map(
    sourceDescriptors.map(source => [source.declarationSourceId, source])
  )
  const chunkDescriptors = dataset.declarations.flatMap(declaration => {
    const source = sourceByDeclarationSourceId.get(declaration.sourceId)
    return declaration.chunks.map(chunk => ({
      ...chunk,
      sourceDatabaseId: source.id,
      declarationId: declaration.id
    }))
  })
  const valueDescriptors = chunkDescriptors.flatMap(chunk =>
    chunk.values.map(value => ({
      id: deterministicUuid(
        dataset.metadata.id,
        `${chunk.sourceId}:value:${value.periodStart}`
      ),
      chunkId: chunk.id
    })))

  return {
    preleveurBySourceId,
    pointBySourceId,
    exploitationBySourceId,
    userDescriptors,
    sourceDescriptors,
    sourceByDeclarationSourceId,
    chunkDescriptors,
    valueDescriptors
  }
}

function addCollision(collisions, code, detail) {
  collisions.push({code, detail})
}

function throwCollisions(collisions) {
  if (collisions.length === 0) {
    return
  }

  const preview = collisions
    .slice(0, 20)
    .map(collision => `${collision.code}: ${collision.detail}`)
    .join('; ')
  const suffix = collisions.length > 20
    ? `; ${collisions.length - 20} autre(s) collision(s)`
    : ''
  throw new Error(`Préflight refusé (${collisions.length} collision(s)) : ${preview}${suffix}`)
}

export async function assertConnectedDatabaseIdentity({database, attestation}) {
  assertDatabase(database)
  assertRecord(attestation, 'attestation')
  assertRecord(attestation.database, 'attestation.database')

  const rows = await database.$queryRawUnsafe(`
    SELECT
      current_database()::text AS "databaseName",
      current_user::text AS "databaseUser",
      inet_server_addr()::text AS "serverAddress",
      inet_server_port()::integer AS "serverPort",
      current_setting('server_version_num')::integer AS "serverVersionNumber",
      COALESCE(
        (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()),
        false
      ) AS "tls"
  `)
  const identity = rows[0]

  if (!identity) {
    throw new Error('Impossible de lire l’identité PostgreSQL après connexion')
  }

  const comparisons = {
    name: identity.databaseName === attestation.database.name,
    user: identity.databaseUser === attestation.database.user,
    tls: Boolean(identity.tls) === attestation.database.tls
  }
  const mismatch = Object.entries(comparisons).find(([, matches]) => !matches)
  if (mismatch) {
    throw new Error(
      `Identité PostgreSQL connectée différente de l’attestation (${mismatch[0]})`
    )
  }

  return {
    verified: true,
    databaseName: identity.databaseName,
    databaseUser: identity.databaseUser,
    tls: Boolean(identity.tls),
    serverAddress: identity.serverAddress ?? null,
    serverPort: identity.serverPort ?? null,
    serverVersionNumber: identity.serverVersionNumber
  }
}

async function resolveReferences(database, dataset) {
  const departmentCodes = [...new Set(dataset.points.map(point => point.departmentCode))]
    .sort()
  const usageCodes = [...new Set(dataset.exploitations.map(item => item.usageCode))]
    .sort()
  const departments = await database.zone.findMany({
    where: {type: 'DEPARTEMENT', code: {in: departmentCodes}},
    select: {id: true, code: true, name: true}
  })
  const usages = await database.sandreWaterUse.findMany({
    where: {code: {in: usageCodes}},
    select: {id: true, code: true, kind: true, parentId: true}
  })
  const departmentByCode = new Map(departments.map(zone => [zone.code, zone]))
  const usageByCode = new Map(usages.map(usage => [usage.code, usage]))
  const missingDepartments = departmentCodes.filter(code => !departmentByCode.has(code))
  const invalidUsages = usageCodes.filter(code => {
    const usage = usageByCode.get(code)
    return !usage || usage.kind !== 'USAGE' || usage.parentId !== null
  })

  if (missingDepartments.length > 0) {
    throw new Error(`Zone(s) départementale(s) absente(s) : ${missingDepartments.join(', ')}`)
  }

  if (invalidUsages.length > 0) {
    throw new Error(`Usage(s) SANDRE racine absent(s) : ${invalidUsages.join(', ')}`)
  }

  return {
    departments: Object.fromEntries(
      departmentCodes.map(code => [code, departmentByCode.get(code)])
    ),
    usages: Object.fromEntries(usageCodes.map(code => [code, usageByCode.get(code)]))
  }
}

async function assessGeometry(database, dataset, references) {
  const points = dataset.points.map(point => ({
    sourceId: point.sourceId,
    departmentCode: point.departmentCode,
    coordinates: point.coordinates
  }))
  const departmentCodes = Object.keys(references.departments)
  const rows = await database.$queryRawUnsafe(`
    WITH requested_departments AS (
      SELECT value::text AS code
      FROM jsonb_array_elements_text($2::jsonb)
    ), departments AS MATERIALIZED (
      SELECT zone.code, zone.coordinates
      FROM "Zone" zone
      JOIN requested_departments requested ON requested.code = zone.code
      WHERE zone.type = 'DEPARTEMENT'::"ZoneType"
    ), department_union AS MATERIALIZED (
      SELECT ST_UnaryUnion(ST_Collect(coordinates)) AS coordinates
      FROM departments
    ), mask AS MATERIALIZED (
      SELECT ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326) AS coordinates
    ), clipped AS MATERIALIZED (
      SELECT ST_Multi(
        ST_CollectionExtract(
          ST_Intersection(mask.coordinates, department_union.coordinates),
          3
        )
      )::geometry(MultiPolygon, 4326) AS coordinates
      FROM mask, department_union
    ), input_points AS MATERIALIZED (
      SELECT
        item->>'sourceId' AS source_id,
        item->>'departmentCode' AS department_code,
        ST_SetSRID(
          ST_GeomFromGeoJSON((item->'coordinates')::text),
          4326
        )::geometry(Point, 4326) AS coordinates
      FROM jsonb_array_elements($3::jsonb) input(item)
    ), assessed_points AS MATERIALIZED (
      SELECT
        point.source_id,
        department.code IS NOT NULL
          AND ST_Covers(department.coordinates, point.coordinates) AS department_covers,
        ST_Covers(clipped.coordinates, point.coordinates) AS sage_covers
      FROM input_points point
      LEFT JOIN departments department ON department.code = point.department_code
      CROSS JOIN clipped
    )
    SELECT
      ST_AsGeoJSON(clipped.coordinates, 15, 0)::jsonb AS geometry,
      ST_IsValid(clipped.coordinates) AS "isValid",
      ST_IsEmpty(clipped.coordinates) AS "isEmpty",
      GeometryType(clipped.coordinates) AS "geometryType",
      (
        SELECT count(*)::integer
        FROM departments department
        WHERE ST_Intersects(clipped.coordinates, department.coordinates)
      ) AS "intersectedDepartments",
      (SELECT count(*)::integer FROM assessed_points) AS "pointCount",
      (
        SELECT count(*)::integer
        FROM assessed_points
        WHERE department_covers
      ) AS "departmentCoveredPointCount",
      (
        SELECT count(*)::integer
        FROM assessed_points
        WHERE sage_covers
      ) AS "sageCoveredPointCount"
    FROM clipped
  `, JSON.stringify(dataset.zone.geojson.geometry), JSON.stringify(departmentCodes), JSON.stringify(points))
  const assessment = rows[0]

  if (!assessment
    || assessment.isEmpty
    || !assessment.isValid
    || assessment.geometryType !== 'MULTIPOLYGON') {
    throw new Error('Le périmètre SAGE synthétique découpé est vide ou invalide')
  }

  if (asNumber(assessment.intersectedDepartments) !== departmentCodes.length) {
    throw new Error('Le périmètre SAGE synthétique ne recoupe pas les deux départements')
  }

  if (asNumber(assessment.pointCount) !== dataset.points.length
    || asNumber(assessment.departmentCoveredPointCount) !== dataset.points.length
    || asNumber(assessment.sageCoveredPointCount) !== dataset.points.length) {
    throw new Error(
      'Au moins un point synthétique est hors de son département ou du SAGE découpé'
    )
  }

  return {
    geometry: parseJsonColumn(assessment.geometry),
    valid: true,
    pointCount: asNumber(assessment.pointCount),
    departmentsCovered: asNumber(assessment.intersectedDepartments)
  }
}

async function detectZoneCollisions(database, dataset, collisions) {
  const zones = await database.zone.findMany({
    where: {
      OR: [
        {id: dataset.zone.id},
        {type: 'SAGE', code: dataset.zone.code}
      ]
    },
    select: {id: true, code: true, type: true}
  })

  for (const zone of zones) {
    if (zone.id !== dataset.zone.id
      || zone.code !== dataset.zone.code
      || zone.type !== 'SAGE') {
      addCollision(collisions, 'zone', 'le code ou l’UUID du SAGE appartient à une autre zone')
    }
  }
}

async function detectUserCollisions(database, descriptors, collisions) {
  const expectedById = new Map(descriptors.userDescriptors.map(item => [item.id, item]))
  const expectedByEmail = new Map(
    descriptors.userDescriptors
      .filter(item => item.email)
      .map(item => [item.email.toLowerCase(), item])
  )
  const declarantDescriptors = descriptors.userDescriptors.filter(item => item.kind === 'declarant')
  const instructorDescriptors = descriptors.userDescriptors.filter(item => item.kind === 'instructor')
  const users = await database.user.findMany({
    where: {
      OR: [
        {id: {in: [...expectedById.keys()]}},
        {email: {in: [...expectedByEmail.keys()]}}
      ]
    },
    select: {
      id: true,
      email: true,
      declarant: {select: {sourceId: true}},
      instructor: {select: {sourceId: true}}
    }
  })
  const emailIdentities = await database.userEmailIdentity.findMany({
    where: {email: {in: [...expectedByEmail.keys()]}},
    select: {
      email: true,
      primaryUserId: true,
      aliasUserId: true,
      verificationUserId: true
    }
  })
  const declarants = await database.declarant.findMany({
    where: {sourceId: {in: declarantDescriptors.map(item => item.sourceId)}},
    select: {userId: true, sourceId: true}
  })
  const instructors = await database.instructor.findMany({
    where: {sourceId: {in: instructorDescriptors.map(item => item.sourceId)}},
    select: {userId: true, sourceId: true}
  })
  const existingDeclarantBySourceId = new Map(
    declarants.map(item => [item.sourceId, item.userId])
  )
  const existingInstructorBySourceId = new Map(
    instructors.map(item => [item.sourceId, item.userId])
  )

  for (const user of users) {
    const expectedByUserId = expectedById.get(user.id)
    const expectedByUserEmail = user.email
      ? expectedByEmail.get(user.email.toLowerCase())
      : null

    if (!expectedByUserId) {
      addCollision(
        collisions,
        'account.email',
        `l’email du persona ${expectedByUserEmail?.sourceId ?? 'inconnu'} appartient à un autre compte`
      )
      continue
    }

    if (expectedByUserEmail && expectedByUserEmail.id !== user.id) {
      addCollision(
        collisions,
        'account.email',
        `un compte du jeu utilise l’email destiné à ${expectedByUserEmail.sourceId}`
      )
    }

    const ownedSourceId = expectedByUserId.kind === 'declarant'
      ? user.declarant?.sourceId
      : user.instructor?.sourceId
    if (ownedSourceId !== expectedByUserId.sourceId) {
      addCollision(
        collisions,
        `${expectedByUserId.kind}.userId`,
        `${expectedByUserId.sourceId} recoupe un compte qui n’appartient pas au jeu`
      )
    }
  }

  for (const identity of emailIdentities) {
    const expected = expectedByEmail.get(identity.email.toLowerCase())
    const incompatiblePrimary = identity.primaryUserId
      && identity.primaryUserId !== expected.id
    const incompatibleAlias = identity.aliasUserId
      && identity.aliasUserId !== expected.id
    const incompatibleVerification = identity.verificationUserId
      && identity.verificationUserId !== expected.id

    if (incompatiblePrimary || incompatibleAlias || incompatibleVerification) {
      addCollision(
        collisions,
        'account.identity',
        `l’identité email du persona ${expected.sourceId} est déjà réservée`
      )
    }
  }

  for (const expected of declarantDescriptors) {
    const existingUserId = existingDeclarantBySourceId.get(expected.sourceId)
    if (existingUserId && existingUserId !== expected.id) {
      addCollision(collisions, 'declarant.sourceId', `${expected.sourceId} appartient à un autre compte`)
    }

    const matchingSource = declarants.find(item => item.userId === expected.id)
    if (matchingSource && matchingSource.sourceId !== expected.sourceId) {
      addCollision(collisions, 'declarant.userId', `${expected.sourceId} recoupe un autre déclarant`)
    }
  }

  for (const expected of instructorDescriptors) {
    const existingUserId = existingInstructorBySourceId.get(expected.sourceId)
    if (existingUserId && existingUserId !== expected.id) {
      addCollision(collisions, 'instructor.sourceId', `${expected.sourceId} appartient à un autre compte`)
    }

    const matchingInstructor = instructors.find(item => item.userId === expected.id)
    if (matchingInstructor && matchingInstructor.sourceId !== expected.sourceId) {
      addCollision(collisions, 'instructor.userId', `${expected.sourceId} recoupe un autre instructeur`)
    }
  }
}

function checkOwnedRows({rows, expectedItems, kind, attributes, collisions}) {
  const expectedById = new Map(expectedItems.map(item => [item.id, item]))
  const expectedByAttribute = Object.fromEntries(attributes.map(attribute => [
    attribute,
    new Map(expectedItems
      .filter(item => item[attribute] !== null && item[attribute] !== undefined)
      .map(item => [String(item[attribute]), item]))
  ]))

  for (const row of rows) {
    const expected = expectedById.get(row.id)
    if (!expected) {
      const claimedAttribute = attributes.find(attribute =>
        row[attribute] !== null
        && row[attribute] !== undefined
        && expectedByAttribute[attribute].has(String(row[attribute])))
      addCollision(
        collisions,
        `${kind}.${claimedAttribute ?? 'id'}`,
        'une valeur réservée du jeu appartient à un autre enregistrement'
      )
      continue
    }

    const ownershipAttribute = attributes[0]
    if (!equalValue(row[ownershipAttribute], expected[ownershipAttribute])) {
      addCollision(
        collisions,
        `${kind}.id`,
        `un UUID déterministe existe sans son marqueur ${ownershipAttribute}`
      )
      continue
    }

    for (const attribute of attributes) {
      const value = row[attribute]
      const otherExpected = value === null || value === undefined
        ? null
        : expectedByAttribute[attribute].get(String(value))
      if (otherExpected && otherExpected.id !== expected.id) {
        addCollision(collisions, `${kind}.${attribute}`, `l’UUID ${expected.id} recoupe un autre objet du jeu`)
      }
    }
  }
}

async function detectBusinessObjectCollisions(database, dataset, descriptors, collisions) {
  const pointExpected = dataset.points.map(point => ({
    id: point.id,
    sourceId: point.sourceId,
    name: point.name
  }))
  const exploitationExpected = dataset.exploitations.map(item => ({
    id: item.id,
    sourceId: item.sourceId
  }))
  const meterExpected = dataset.meters.map(meter => ({
    id: meter.id,
    identifier: meter.identifier ?? meter.sourceId,
    serialNumber: meter.serialNumber
  }))
  const declarationExpected = dataset.declarations.map(item => ({
    id: item.id,
    code: item.code,
    importSourceId: item.importSourceId
  }))
  const points = await database.pointPrelevement.findMany({
    where: {
      OR: [
        {id: {in: pointExpected.map(item => item.id)}},
        {sourceId: {in: pointExpected.map(item => item.sourceId)}},
        {name: {in: pointExpected.map(item => item.name)}}
      ]
    },
    select: {id: true, sourceId: true, name: true}
  })
  const exploitations = await database.declarantPointPrelevement.findMany({
    where: {
      OR: [
        {id: {in: exploitationExpected.map(item => item.id)}},
        {sourceId: {in: exploitationExpected.map(item => item.sourceId)}}
      ]
    },
    select: {id: true, sourceId: true}
  })
  const meters = await database.compteur.findMany({
    where: {
      OR: [
        {id: {in: meterExpected.map(item => item.id)}},
        {identifier: {in: meterExpected.map(item => item.identifier)}},
        {serialNumber: {in: meterExpected.map(item => item.serialNumber)}}
      ]
    },
    select: {id: true, identifier: true, serialNumber: true}
  })
  const declarations = await database.declaration.findMany({
    where: {
      OR: [
        {id: {in: declarationExpected.map(item => item.id)}},
        {code: {in: declarationExpected.map(item => item.code)}},
        {importSourceId: {in: declarationExpected.map(item => item.importSourceId)}}
      ]
    },
    select: {id: true, code: true, importSourceId: true}
  })
  const sources = await database.source.findMany({
    where: {
      OR: [
        {id: {in: descriptors.sourceDescriptors.map(item => item.id)}},
        {declarationId: {in: dataset.declarations.map(item => item.id)}}
      ]
    },
    select: {id: true, declarationId: true}
  })
  const chunks = await database.chunk.findMany({
    where: {id: {in: descriptors.chunkDescriptors.map(item => item.id)}},
    select: {id: true, sourceId: true}
  })

  checkOwnedRows({
    rows: points,
    expectedItems: pointExpected,
    kind: 'point',
    attributes: ['sourceId', 'name'],
    collisions
  })
  checkOwnedRows({
    rows: exploitations,
    expectedItems: exploitationExpected,
    kind: 'exploitation',
    attributes: ['sourceId'],
    collisions
  })
  checkOwnedRows({
    rows: meters,
    expectedItems: meterExpected,
    kind: 'meter',
    attributes: ['identifier', 'serialNumber'],
    collisions
  })
  checkOwnedRows({
    rows: declarations,
    expectedItems: declarationExpected,
    kind: 'declaration',
    attributes: ['importSourceId', 'code'],
    collisions
  })

  const expectedSourceById = new Map(
    descriptors.sourceDescriptors.map(item => [item.id, item])
  )
  const expectedSourceByDeclarationId = new Map(
    descriptors.sourceDescriptors.map(item => [item.declarationId, item])
  )
  for (const source of sources) {
    const expectedById = expectedSourceById.get(source.id)
    const expectedByDeclaration = expectedSourceByDeclarationId.get(source.declarationId)
    if (!expectedById
      || !expectedByDeclaration
      || expectedById.id !== expectedByDeclaration.id) {
      addCollision(collisions, 'source', 'une source déterministe est déjà liée à une autre déclaration')
    }
  }

  const expectedChunkById = new Map(
    descriptors.chunkDescriptors.map(item => [item.id, item])
  )
  for (const chunk of chunks) {
    const expected = expectedChunkById.get(chunk.id)
    if (expected?.sourceDatabaseId !== chunk.sourceId) {
      addCollision(collisions, 'chunk', 'un UUID de ligne déterministe appartient à une autre source')
    }
  }

  for (const batch of chunkArray(descriptors.valueDescriptors, VALUE_COLLISION_BATCH_SIZE)) {
    const expectedById = new Map(batch.map(item => [item.id, item]))
    const values = await database.chunkValue.findMany({
      where: {id: {in: batch.map(item => item.id)}},
      select: {id: true, chunkId: true}
    })
    for (const value of values) {
      if (expectedById.get(value.id)?.chunkId !== value.chunkId) {
        addCollision(collisions, 'chunkValue', 'un UUID de valeur déterministe appartient à une autre ligne')
      }
    }
  }
}

async function detectOverlappingNonSeedValues(database, dataset) {
  const startYear = Math.min(...dataset.metadata.referenceYears)
  const endYear = Math.max(...dataset.metadata.referenceYears) + 1
  const preleveurIds = dataset.preleveurs.map(item => item.id)
  const pointIds = dataset.points.map(item => item.id)
  const importSourceIds = dataset.declarations.map(item => item.importSourceId)
  const rows = await database.$queryRawUnsafe(`
    SELECT count(*)::integer AS count
    FROM "ChunkValue" value
    JOIN "Chunk" chunk ON chunk.id = value."chunkId"
    JOIN "Source" source ON source.id = chunk."sourceId"
    LEFT JOIN "Declaration" declaration ON declaration.id = source."declarationId"
    WHERE value."periodStart" < $1::timestamp
      AND value."periodEnd" > $2::timestamp
      AND (
        chunk."pointPrelevementId" IN (
          SELECT value::uuid FROM jsonb_array_elements_text($3::jsonb)
        )
        OR chunk."preleveurUserId" IN (
          SELECT value::uuid FROM jsonb_array_elements_text($4::jsonb)
        )
      )
      AND NOT (
        COALESCE(declaration."importSourceId" IN (
          SELECT value::text FROM jsonb_array_elements_text($5::jsonb)
        ), false)
        OR (
          source.metadata #>> '{fixture,datasetId}' = $6
          AND COALESCE(source.metadata #>> '{fixture,sourceId}' IN (
            SELECT value::text FROM jsonb_array_elements_text($7::jsonb)
          ), false)
        )
      )
  `,
  `${endYear}-01-01T00:00:00.000Z`,
  `${startYear}-01-01T00:00:00.000Z`,
  JSON.stringify(pointIds),
  JSON.stringify(preleveurIds),
  JSON.stringify(importSourceIds),
  dataset.metadata.id,
  JSON.stringify(dataset.declarations.map(item => item.sourceId)))

  return asNumber(rows[0]?.count)
}

export async function preflightSeed({database, dataset, accounts}) {
  assertDatabase(database)
  assertDataset(dataset)
  assertAccounts(accounts)

  const descriptors = buildDescriptors(dataset, accounts)
  const references = await resolveReferences(database, dataset)
  const geometry = await assessGeometry(database, dataset, references)
  const collisions = []

  await detectZoneCollisions(database, dataset, collisions)
  await detectUserCollisions(database, descriptors, collisions)
  await detectBusinessObjectCollisions(database, dataset, descriptors, collisions)

  const overlappingNonSeedValues = await detectOverlappingNonSeedValues(
    database,
    dataset
  )
  if (overlappingNonSeedValues > 0) {
    addCollision(
      collisions,
      'volume.overlap',
      `${overlappingNonSeedValues} valeur(s) non gérée(s) par le seed recouvrent ses acteurs`
    )
  }

  throwCollisions(collisions)

  const result = {
    success: true,
    datasetId: dataset.metadata.id,
    datasetSha256: datasetSha256(dataset),
    sourcePrefix: dataset.metadata.sourcePrefix,
    references: {
      departments: Object.fromEntries(
        Object.entries(references.departments).map(([code, zone]) => [code, zone.id])
      ),
      usages: Object.fromEntries(
        Object.entries(references.usages).map(([code, usage]) => [code, usage.id])
      )
    },
    geometry: {
      valid: geometry.valid,
      pointCount: geometry.pointCount,
      departmentsCovered: geometry.departmentsCovered,
      sha256: sha256(stableStringify(geometry.geometry))
    },
    collisions: 0,
    overlappingNonSeedValues,
    counts: {
      users: descriptors.userDescriptors.length,
      preleveurs: dataset.preleveurs.length,
      points: dataset.points.length,
      exploitations: dataset.exploitations.length,
      meters: dataset.meters.length,
      declarations: dataset.declarations.length,
      chunks: descriptors.chunkDescriptors.length,
      values: descriptors.valueDescriptors.length
    }
  }

  Object.defineProperty(result, PREFLIGHT_ZONE_GEOMETRY, {
    value: geometry.geometry,
    enumerable: false,
    writable: false
  })

  return result
}

function emptyCounter() {
  return {created: 0, updated: 0, unchanged: 0, deleted: 0}
}

function ensureCounter(summary, key) {
  summary[key] ??= emptyCounter()
  return summary[key]
}

function changedFields(existing, desired, fields) {
  return Object.fromEntries(fields
    .filter(field => !equalValue(existing[field], desired[field]))
    .map(field => [field, desired[field]]))
}

async function syncRecords({
  database,
  model,
  key = 'id',
  records,
  fields,
  summary,
  summaryKey
}) {
  const counter = ensureCounter(summary, summaryKey)
  const keys = records.map(record => record[key])
  const existingRecords = keys.length === 0
    ? []
    : await database[model].findMany({where: {[key]: {in: keys}}})
  const existingByKey = new Map(existingRecords.map(record => [record[key], record]))
  const toCreate = []

  for (const record of records) {
    const existing = existingByKey.get(record[key])
    if (!existing) {
      toCreate.push(record)
      continue
    }

    const changes = changedFields(existing, record, fields)
    if (Object.keys(changes).length === 0) {
      counter.unchanged += 1
      continue
    }

    await database[model].update({
      where: {[key]: record[key]},
      data: changes
    })
    counter.updated += 1
  }

  for (const batch of chunkArray(toCreate, CREATE_MANY_BATCH_SIZE)) {
    const result = await database[model].createMany({data: batch})
    counter.created += result.count
  }

  return {existingByKey}
}

async function upsertZone(database, dataset, geometry, summary) {
  const existing = await database.zone.findUnique({
    where: {id: dataset.zone.id},
    select: {id: true}
  })
  const rows = await database.$queryRawUnsafe(`
    INSERT INTO "Zone" (
      id,
      code,
      type,
      name,
      coordinates,
      "createdAt",
      "updatedAt"
    )
    VALUES (
      $1::uuid,
      $2,
      'SAGE'::"ZoneType",
      $3,
      ST_Multi(
        ST_SetSRID(ST_GeomFromGeoJSON($4::text), 4326)
      )::geometry(MultiPolygon, 4326),
      now(),
      now()
    )
    ON CONFLICT (id) DO UPDATE SET
      code = EXCLUDED.code,
      type = EXCLUDED.type,
      name = EXCLUDED.name,
      coordinates = EXCLUDED.coordinates,
      "updatedAt" = now()
    WHERE "Zone".code IS DISTINCT FROM EXCLUDED.code
      OR "Zone".type IS DISTINCT FROM EXCLUDED.type
      OR "Zone".name IS DISTINCT FROM EXCLUDED.name
      OR NOT ST_Equals("Zone".coordinates, EXCLUDED.coordinates)
    RETURNING id
  `, dataset.zone.id, dataset.zone.code, dataset.zone.name, JSON.stringify(geometry))
  const counter = ensureCounter(summary, 'zones')

  if (rows.length === 0) {
    counter.unchanged += 1
  } else if (existing) {
    counter.updated += 1
  } else {
    counter.created += 1
  }
}

async function upsertPoints(database, dataset, summary) {
  const records = dataset.points.map(point => ({
    id: point.id,
    sourceId: point.sourceId,
    name: point.name,
    usageName: null,
    waterBodyType: point.waterBodyType,
    flowType: point.flowType,
    pointKind: 'FICTIF',
    nature: point.waterBodyType === 'SOUTERRAIN' ? 'NAPPE' : 'COURS_EAU',
    withdrawalType: point.waterBodyType === 'SOUTERRAIN' ? 'SOUTERRAIN' : 'CONTINENTAL',
    coordinates: point.coordinates,
    names: [point.name],
    identifiers: {
      fixtureSourceId: point.sourceId,
      datasetId: dataset.metadata.id
    }
  }))
  const existing = await database.pointPrelevement.findMany({
    where: {id: {in: records.map(record => record.id)}},
    select: {id: true}
  })
  const existingIds = new Set(existing.map(record => record.id))
  const rows = await database.$queryRawUnsafe(`
    WITH input AS (
      SELECT item
      FROM jsonb_array_elements($1::jsonb) data(item)
    ), prepared AS (
      SELECT
        (item->>'id')::uuid AS id,
        item->>'sourceId' AS source_id,
        item->>'name' AS name,
        NULLIF(item->>'usageName', '') AS usage_name,
        (item->>'waterBodyType')::"WaterBodyType" AS water_body_type,
        (item->>'flowType')::"PointFlowType" AS flow_type,
        (item->>'pointKind')::"PointKind" AS point_kind,
        (item->>'nature')::"PointPrelevementNature" AS nature,
        (item->>'withdrawalType')::"PrelevementType" AS withdrawal_type,
        ST_SetSRID(
          ST_GeomFromGeoJSON((item->'coordinates')::text),
          4326
        )::geometry(Point, 4326) AS coordinates,
        item->'names' AS names,
        item->'identifiers' AS identifiers
      FROM input
    )
    INSERT INTO "PointPrelevement" (
      id,
      "sourceId",
      name,
      "usageName",
      "waterBodyType",
      "flowType",
      "pointKind",
      nature,
      "withdrawalType",
      coordinates,
      names,
      identifiers,
      "deletedAt",
      "createdAt",
      "updatedAt"
    )
    SELECT
      id,
      source_id,
      name,
      usage_name,
      water_body_type,
      flow_type,
      point_kind,
      nature,
      withdrawal_type,
      coordinates,
      names,
      identifiers,
      NULL,
      now(),
      now()
    FROM prepared
    ON CONFLICT (id) DO UPDATE SET
      "sourceId" = EXCLUDED."sourceId",
      name = EXCLUDED.name,
      "usageName" = EXCLUDED."usageName",
      "waterBodyType" = EXCLUDED."waterBodyType",
      "flowType" = EXCLUDED."flowType",
      "pointKind" = EXCLUDED."pointKind",
      nature = EXCLUDED.nature,
      "withdrawalType" = EXCLUDED."withdrawalType",
      coordinates = EXCLUDED.coordinates,
      names = EXCLUDED.names,
      identifiers = EXCLUDED.identifiers,
      "deletedAt" = NULL,
      "updatedAt" = now()
    WHERE "PointPrelevement"."sourceId" IS DISTINCT FROM EXCLUDED."sourceId"
      OR "PointPrelevement".name IS DISTINCT FROM EXCLUDED.name
      OR "PointPrelevement"."usageName" IS DISTINCT FROM EXCLUDED."usageName"
      OR "PointPrelevement"."waterBodyType" IS DISTINCT FROM EXCLUDED."waterBodyType"
      OR "PointPrelevement"."flowType" IS DISTINCT FROM EXCLUDED."flowType"
      OR "PointPrelevement"."pointKind" IS DISTINCT FROM EXCLUDED."pointKind"
      OR "PointPrelevement".nature IS DISTINCT FROM EXCLUDED.nature
      OR "PointPrelevement"."withdrawalType" IS DISTINCT FROM EXCLUDED."withdrawalType"
      OR "PointPrelevement".coordinates IS NULL
      OR NOT ST_Equals("PointPrelevement".coordinates, EXCLUDED.coordinates)
      OR "PointPrelevement".names::jsonb IS DISTINCT FROM EXCLUDED.names::jsonb
      OR "PointPrelevement".identifiers::jsonb IS DISTINCT FROM EXCLUDED.identifiers::jsonb
      OR "PointPrelevement"."deletedAt" IS NOT NULL
    RETURNING id
  `, JSON.stringify(records))
  const writtenIds = new Set(rows.map(row => row.id))
  const counter = ensureCounter(summary, 'points')

  for (const record of records) {
    if (!writtenIds.has(record.id)) {
      counter.unchanged += 1
    } else if (existingIds.has(record.id)) {
      counter.updated += 1
    } else {
      counter.created += 1
    }
  }
}

async function syncPairRelations({
  database,
  model,
  ownedWhere,
  records,
  leftField,
  rightField,
  fields = [],
  deleteUnexpectedOwned = false,
  summary,
  summaryKey
}) {
  const counter = ensureCounter(summary, summaryKey)
  const existing = await database[model].findMany({where: ownedWhere})
  const pairKey = record => `${record[leftField]}:${record[rightField]}`
  const expectedByPair = new Map(records.map(record => [pairKey(record), record]))
  const existingByPair = new Map(existing.map(record => [pairKey(record), record]))
  const extraIds = existing
    .filter(record => deleteUnexpectedOwned || records.some(item => item.id === record.id))
    .filter(record => !expectedByPair.has(pairKey(record)))
    .map(record => record.id)

  if (extraIds.length > 0) {
    const result = await database[model].deleteMany({where: {id: {in: extraIds}}})
    counter.deleted += result.count
  }

  const toCreate = []
  for (const record of records) {
    const current = existingByPair.get(pairKey(record))
    if (!current) {
      toCreate.push(record)
      continue
    }

    const changes = changedFields(current, record, fields)
    if (Object.keys(changes).length === 0) {
      counter.unchanged += 1
      continue
    }

    await database[model].update({where: {id: current.id}, data: changes})
    counter.updated += 1
  }

  for (const batch of chunkArray(toCreate, CREATE_MANY_BATCH_SIZE)) {
    const result = await database[model].createMany({data: batch, skipDuplicates: true})
    counter.created += result.count
  }
}

function buildUserRecords(descriptors) {
  return descriptors.userDescriptors.map(item => ({
    id: item.id,
    email: item.email,
    role: item.role,
    firstName: item.firstName,
    lastName: item.lastName,
    deletedAt: null
  }))
}

function declarationTimestamp(year, lastReferenceYear) {
  const day = year === lastReferenceYear ? '09-01' : '12-31'
  return new Date(`${year}-${day}T12:00:00.000Z`)
}

function buildDeclarantRecords(dataset, descriptors) {
  const lastReferenceYear = Math.max(...dataset.metadata.referenceYears)
  const latestDeclarationAt = declarationTimestamp(
    lastReferenceYear,
    lastReferenceYear
  )

  return descriptors.userDescriptors
    .filter(item => item.kind === 'declarant')
    .map(item => ({
      userId: item.id,
      sourceId: item.sourceId,
      declarantType: 'LEGAL_PERSON',
      declarantRole: item.declarantRole,
      preleveurType: item.preleveurType,
      socialReason: item.socialReason,
      quickDeclarationEnabled: true,
      declarationNotificationsEnabled: false,
      lastDeclarationAt: item.reporting?.active || item.declarantRole === 'COLLECTEUR'
        ? latestDeclarationAt
        : null
    }))
}

function buildInstructorRecords(descriptors) {
  return descriptors.userDescriptors
    .filter(item => item.kind === 'instructor')
    .map(item => ({
      userId: item.id,
      sourceId: item.sourceId,
      phoneNumber: null,
      jobTitle: item.sourceId.endsWith('-ddt')
        ? 'Agent DDT de l’Isère'
        : 'Agent du SAGE Grivaise'
    }))
}

function buildPointZoneRecords(dataset, preflight) {
  return dataset.points.flatMap(point => [
    {
      id: deterministicUuid(dataset.metadata.id, `${point.sourceId}:zone:${dataset.zone.code}`),
      pointPrelevementId: point.id,
      zoneId: dataset.zone.id
    },
    {
      id: deterministicUuid(dataset.metadata.id, `${point.sourceId}:zone:${point.departmentCode}`),
      pointPrelevementId: point.id,
      zoneId: preflight.references.departments[point.departmentCode]
    }
  ])
}

function buildExploitationRecords(dataset, descriptors, preflight) {
  const lastReferenceYear = Math.max(...dataset.metadata.referenceYears)

  return dataset.exploitations.map(exploitation => {
    const point = descriptors.pointBySourceId.get(exploitation.pointSourceId)

    return {
      id: exploitation.id,
      sourceId: exploitation.sourceId,
      declarantUserId: descriptors.preleveurBySourceId.get(exploitation.preleveurSourceId).id,
      pointPrelevementId: point.id,
      status: 'EN_ACTIVITE',
      startDate: dateOnly(exploitation.startDate),
      endDate: exploitation.endDate ? dateOnly(exploitation.endDate) : null,
      usageId: preflight.references.usages[exploitation.usageCode],
      pointPrelevementNameAliases: [],
      abandonReason: null,
      comment: null,
      mostRecentAvailableDate: exploitation.isPrimary && point.isCovered
        ? dateOnly(`${lastReferenceYear}-12-31`)
        : null
    }
  })
}

function buildDeclarantZoneRecords(dataset, descriptors, preflight) {
  const records = []

  for (const preleveur of dataset.preleveurs) {
    const zoneCodes = [dataset.zone.code, preleveur.departmentCode]
    for (const zoneCode of zoneCodes) {
      const zoneId = zoneCode === dataset.zone.code
        ? dataset.zone.id
        : preflight.references.departments[zoneCode]
      records.push({
        id: deterministicUuid(dataset.metadata.id, `${preleveur.sourceId}:declarant-zone:${zoneCode}`),
        declarantUserId: preleveur.id,
        zoneId,
        source: 'MIGRATION',
        createdByUserId: null
      })
    }
  }

  const collector = descriptors.userDescriptors.find(item =>
    item.sourceId === dataset.personas.ougc.collectorSourceId)
  for (const zoneCode of [dataset.zone.code, ...Object.keys(preflight.references.departments)]) {
    const zoneId = zoneCode === dataset.zone.code
      ? dataset.zone.id
      : preflight.references.departments[zoneCode]
    records.push({
      id: deterministicUuid(dataset.metadata.id, `${collector.sourceId}:declarant-zone:${zoneCode}`),
      declarantUserId: collector.id,
      zoneId,
      source: 'MIGRATION',
      createdByUserId: null
    })
  }

  return records
}

function buildCollectorExploitationRecords(dataset, descriptors) {
  const collectorUserId = dataset.personas.ougc.id

  return dataset.collectorLinks.flatMap(link =>
    link.exploitationSourceIds.map(exploitationSourceId => ({
      id: deterministicUuid(
        dataset.metadata.id,
        `${link.sourceId}:exploitation:${exploitationSourceId}`
      ),
      collecteurUserId: collectorUserId,
      exploitationId: descriptors.exploitationBySourceId.get(exploitationSourceId).id
    })))
}

function buildMeterRecords(dataset) {
  return dataset.meters.map(meter => ({
    id: meter.id,
    identifier: meter.identifier ?? meter.sourceId,
    serialNumber: meter.serialNumber,
    deletedAt: null
  }))
}

function buildMeterPointRecords(dataset, descriptors) {
  return dataset.meters.map(meter => ({
    id: deterministicUuid(dataset.metadata.id, `${meter.sourceId}:point-link`),
    compteurId: meter.id,
    pointPrelevementId: descriptors.pointBySourceId.get(meter.pointSourceId).id,
    startDate: dateOnly(meter.installedAt),
    endDate: meter.removedAt ? dateOnly(meter.removedAt) : null
  }))
}

function permissionsForAccess(access) {
  if (access === 'FULL') {
    return ZONE_PERMISSION_CODES
  }

  if (access === 'READ_ONLY') {
    return READ_ONLY_ZONE_PERMISSIONS
  }

  throw new Error(`Niveau d’accès de persona inconnu : ${access}`)
}

function buildInstructorZoneRecords(dataset, preflight) {
  return ['ddt', 'sage'].flatMap(key => {
    const persona = dataset.personas[key]
    return persona.permissions.map(permission => {
      const zoneId = permission.zoneCode === dataset.zone.code
        ? dataset.zone.id
        : preflight.references.departments[permission.zoneCode]
      if (!zoneId) {
        throw new Error(`Zone inconnue pour le persona ${key} : ${permission.zoneCode}`)
      }

      return {
        id: deterministicUuid(
          dataset.metadata.id,
          `${dataset.metadata.sourcePrefix}instructor-${key}:zone:${permission.zoneCode}`
        ),
        instructorUserId: persona.id,
        zoneId,
        isAdmin: permission.access === 'FULL',
        startDate: dateOnly('2020-01-01'),
        endDate: null,
        zoneAttachmentMailSentAt: null,
        permissionCodes: [...permissionsForAccess(permission.access)]
      }
    })
  })
}

async function syncInstructorPermissions(database, dataset, instructorZones, summary) {
  const actualAssignments = await database.instructorZone.findMany({
    where: {
      instructorUserId: {
        in: [...new Set(instructorZones.map(item => item.instructorUserId))]
      }
    }
  })
  const actualByPair = new Map(actualAssignments.map(item => [
    `${item.instructorUserId}:${item.zoneId}`,
    item
  ]))
  const resolvedAssignments = instructorZones.map(assignment => ({
    ...assignment,
    id: actualByPair.get(`${assignment.instructorUserId}:${assignment.zoneId}`)?.id
  }))
  if (resolvedAssignments.some(item => !item.id)) {
    throw new Error('Une affectation instructeur n’a pas été matérialisée')
  }

  const instructorZoneIds = resolvedAssignments.map(item => item.id)
  const expected = resolvedAssignments.flatMap(assignment =>
    assignment.permissionCodes.map(permission => ({
      id: deterministicUuid(
        dataset.metadata.id,
        `${assignment.id}:permission:${permission}`
      ),
      instructorZoneId: assignment.id,
      permission
    })))
  const counter = ensureCounter(summary, 'instructorPermissions')
  const existing = await database.instructorZonePermission.findMany({
    where: {instructorZoneId: {in: instructorZoneIds}}
  })
  const expectedByPair = new Map(
    expected.map(item => [`${item.instructorZoneId}:${item.permission}`, item])
  )
  const existingPairs = new Set(
    existing.map(item => `${item.instructorZoneId}:${item.permission}`)
  )
  const extraIds = existing
    .filter(item => !expectedByPair.has(`${item.instructorZoneId}:${item.permission}`))
    .map(item => item.id)

  if (extraIds.length > 0) {
    const result = await database.instructorZonePermission.deleteMany({
      where: {id: {in: extraIds}}
    })
    counter.deleted += result.count
  }

  const toCreate = expected.filter(item =>
    !existingPairs.has(`${item.instructorZoneId}:${item.permission}`))
  for (const batch of chunkArray(toCreate, CREATE_MANY_BATCH_SIZE)) {
    const result = await database.instructorZonePermission.createMany({
      data: batch,
      skipDuplicates: true
    })
    counter.created += result.count
  }

  counter.unchanged += expected.length - toCreate.length
}

function actorMaps(dataset, descriptors) {
  const declarantIdBySourceId = new Map(
    descriptors.userDescriptors
      .filter(item => item.kind === 'declarant')
      .map(item => [item.sourceId, item.id])
  )
  const actorIdByKey = new Map([
    ['ougc', dataset.personas.ougc.id]
  ])

  for (const key of ['irrigant', 'industriel', 'aep']) {
    const sourceId = dataset.personas[key].preleveurSourceId
    actorIdByKey.set(key, declarantIdBySourceId.get(sourceId))
  }

  return {declarantIdBySourceId, actorIdByKey}
}

function sourceMetadata(dataset, declaration) {
  return {
    fixture: {
      datasetId: dataset.metadata.id,
      version: dataset.metadata.version,
      sourceId: declaration.sourceId,
      cadence: declaration.cadence,
      year: declaration.year,
      digest: sha256(stableStringify(declaration))
    },
    sourceCode: declaration.sourceCode
  }
}

function buildDeclarationRecords(dataset, descriptors) {
  const {declarantIdBySourceId, actorIdByKey} = actorMaps(dataset, descriptors)
  const lastReferenceYear = Math.max(...dataset.metadata.referenceYears)

  return dataset.declarations.map(declaration => {
    const declarantUserId = declarantIdBySourceId.get(declaration.targetKey)
    const createdByDeclarantUserId = declaration.authorKey
      ? actorIdByKey.get(declaration.authorKey)
      : null
    const createdAt = declarationTimestamp(declaration.year, lastReferenceYear)

    return {
      id: declaration.id,
      code: declaration.code,
      declarantUserId,
      createdByDeclarantUserId,
      autoValidationEnabled: true,
      importSourceId: declaration.importSourceId,
      type: declaration.type,
      comment: `Jeu de démonstration synthétique ${dataset.metadata.id}`,
      dataSourceType: declaration.dataSourceType,
      waterWithdrawalType: declaration.waterWithdrawalType,
      consolidatedAt: null,
      processingStatus: 'COMPLETED',
      processingJobId: null,
      processingAttemptCount: 0,
      processingQueuedAt: null,
      processingStartedAt: null,
      processingCompletedAt: createdAt,
      processingFailedAt: null,
      processingError: null,
      createdAt
    }
  })
}

function buildSourceTree(dataset, declaration, descriptors, preflight) {
  const sourceDescriptor = descriptors.sourceByDeclarationSourceId.get(declaration.sourceId)
  const {declarantIdBySourceId, actorIdByKey} = actorMaps(dataset, descriptors)
  const targetUserId = declarantIdBySourceId.get(declaration.targetKey)
  const submittedByUserId = declaration.authorKey
    ? actorIdByKey.get(declaration.authorKey)
    : null
  const collecteurUserId = declaration.authorKey === 'ougc'
    ? actorIdByKey.get('ougc')
    : null
  const lastReferenceYear = Math.max(...dataset.metadata.referenceYears)
  const completedAt = declarationTimestamp(declaration.year, lastReferenceYear)
  const source = {
    id: sourceDescriptor.id,
    type: 'DECLARATION',
    status: 'COMPLETED',
    globalInstructionStatus: declaration.chunks.some(chunk => chunk.pointSourceId === null)
      ? 'PARTIALLY_VALIDATED'
      : 'VALIDATED',
    metadata: sourceMetadata(dataset, declaration),
    declarationId: declaration.id
  }
  const chunks = declaration.chunks.map(chunk => {
    const starts = chunk.values.map(value => dateOnly(value.periodStart))
    const inclusiveEnds = chunk.values.map(value => dateOnly(value.periodEnd))
    const point = chunk.pointSourceId
      ? descriptors.pointBySourceId.get(chunk.pointSourceId)
      : null
    const matched = chunk.status === 'MATCHED'

    return {
      id: chunk.id,
      sourceId: source.id,
      pointPrelevementName: chunk.externalPointId,
      pointPrelevementId: point?.id ?? null,
      flowType: 'PRELEVEMENT',
      preleveurUserId: targetUserId,
      submittedByDeclarantUserId: submittedByUserId,
      collecteurUserId,
      usageId: preflight.references.usages[chunk.usageCode],
      instructionStatus: matched ? 'VALIDATED' : 'PENDING',
      instructedAt: matched ? completedAt : null,
      instructedByInstructorUserId: null,
      instructionComment: matched ? 'Validation synthétique du jeu de démonstration' : null,
      parsingInfo: {
        fixtureSourceId: chunk.sourceId,
        externalPointId: chunk.externalPointId,
        matchStatus: chunk.status
      },
      minDate: new Date(Math.min(...starts.map(date => date.getTime()))),
      maxDate: new Date(Math.max(...inclusiveEnds.map(date => date.getTime()))),
      metadata: {
        fixture: {
          datasetId: dataset.metadata.id,
          sourceId: chunk.sourceId,
          cadence: chunk.cadence
        }
      },
      values: chunk.values.map(value => {
        const periodStart = dateOnly(value.periodStart)
        const inclusivePeriodEnd = dateOnly(value.periodEnd)
        return {
          id: deterministicUuid(
            dataset.metadata.id,
            `${chunk.sourceId}:value:${value.periodStart}`
          ),
          chunkId: chunk.id,
          metricTypeCode: 'volume',
          unit: 'm³',
          frequency: FREQUENCIES[chunk.cadence],
          periodStart,
          periodEnd: addUtcDay(inclusivePeriodEnd),
          valueKind: 'DECLARED',
          value: String(value.valueM3)
        }
      })
    }
  })

  return {source, chunks}
}

const DECLARATION_FIELDS = Object.freeze([
  'code',
  'declarantUserId',
  'createdByDeclarantUserId',
  'autoValidationEnabled',
  'importSourceId',
  'type',
  'comment',
  'dataSourceType',
  'waterWithdrawalType',
  'consolidatedAt',
  'processingStatus',
  'processingJobId',
  'processingAttemptCount',
  'processingQueuedAt',
  'processingStartedAt',
  'processingCompletedAt',
  'processingFailedAt',
  'processingError',
  'createdAt'
])

const SOURCE_FIELDS = Object.freeze([
  'id',
  'type',
  'status',
  'globalInstructionStatus',
  'metadata',
  'declarationId'
])

const CHUNK_FIELDS = Object.freeze([
  'id',
  'sourceId',
  'pointPrelevementName',
  'pointPrelevementId',
  'flowType',
  'preleveurUserId',
  'submittedByDeclarantUserId',
  'collecteurUserId',
  'usageId',
  'instructionStatus',
  'instructedAt',
  'instructedByInstructorUserId',
  'instructionComment',
  'parsingInfo',
  'minDate',
  'maxDate',
  'metadata'
])

const VALUE_FIELDS = Object.freeze([
  'id',
  'chunkId',
  'metricTypeCode',
  'unit',
  'frequency',
  'periodStart',
  'periodEnd',
  'valueKind',
  'value'
])

function pickFields(record, fields) {
  return Object.fromEntries(fields.map(field => [field, record[field]]))
}

function comparableSourceTree(source, {expected = false} = {}) {
  if (!source) {
    return null
  }

  const rawChunks = expected ? source.chunks : source.chunks ?? []
  const chunks = rawChunks.map(chunk => {
    const rawValues = expected ? chunk.values : chunk.chunkValues ?? []
    const values = rawValues
      .map(value => pickFields(value, VALUE_FIELDS))
      .sort((left, right) => left.id.localeCompare(right.id))

    return {
      ...pickFields(chunk, CHUNK_FIELDS),
      values
    }
  }).sort((left, right) => left.id.localeCompare(right.id))

  return normalizeJson({
    ...pickFields(source, SOURCE_FIELDS),
    chunks
  })
}

async function syncDeclarations(database, dataset, descriptors, preflight, summary) {
  const declarationRecords = buildDeclarationRecords(dataset, descriptors)
  const existingDeclarations = await database.declaration.findMany({
    where: {id: {in: declarationRecords.map(item => item.id)}},
    include: {
      source: {
        include: {
          chunks: {
            include: {chunkValues: true}
          }
        }
      }
    }
  })
  const existingById = new Map(existingDeclarations.map(item => [item.id, item]))
  const declarationCounter = ensureCounter(summary, 'declarations')
  const toCreate = []

  for (const record of declarationRecords) {
    const current = existingById.get(record.id)
    if (!current) {
      toCreate.push(record)
      continue
    }

    const changes = changedFields(current, record, DECLARATION_FIELDS)
    if (Object.keys(changes).length === 0) {
      declarationCounter.unchanged += 1
    } else {
      await database.declaration.update({where: {id: record.id}, data: changes})
      declarationCounter.updated += 1
    }
  }

  for (const batch of chunkArray(toCreate, CREATE_MANY_BATCH_SIZE)) {
    const result = await database.declaration.createMany({data: batch})
    declarationCounter.created += result.count
  }

  const sourceTrees = dataset.declarations.map(declaration => ({
    declaration,
    tree: buildSourceTree(dataset, declaration, descriptors, preflight),
    current: existingById.get(declaration.id)?.source ?? null
  }))
  const toWrite = []
  const sourceCounter = ensureCounter(summary, 'sources')
  const chunkCounter = ensureCounter(summary, 'chunks')
  const valueCounter = ensureCounter(summary, 'values')

  for (const item of sourceTrees) {
    const expectedComparable = comparableSourceTree({
      ...item.tree.source,
      chunks: item.tree.chunks
    }, {expected: true})
    const currentComparable = comparableSourceTree(item.current)
    const chunkCount = item.tree.chunks.length
    const valueCount = item.tree.chunks.reduce((sum, chunk) => sum + chunk.values.length, 0)

    if (equalValue(currentComparable, expectedComparable)) {
      sourceCounter.unchanged += 1
      chunkCounter.unchanged += chunkCount
      valueCounter.unchanged += valueCount
      continue
    }

    if (item.current) {
      await database.source.delete({where: {id: item.current.id}})
      sourceCounter.updated += 1
      sourceCounter.deleted += 1
      chunkCounter.updated += chunkCount
      valueCounter.updated += valueCount
    } else {
      sourceCounter.created += 1
      chunkCounter.created += chunkCount
      valueCounter.created += valueCount
    }

    toWrite.push(item.tree)
  }

  for (const batch of chunkArray(toWrite.map(item => item.source), CREATE_MANY_BATCH_SIZE)) {
    await database.source.createMany({data: batch})
  }

  const chunksToCreate = toWrite.flatMap(item => item.chunks.map(chunk => {
    const {values, ...record} = chunk
    return record
  }))
  for (const batch of chunkArray(chunksToCreate, CREATE_MANY_BATCH_SIZE)) {
    await database.chunk.createMany({data: batch})
  }

  const valuesToCreate = toWrite.flatMap(item =>
    item.chunks.flatMap(chunk => chunk.values))
  for (const batch of chunkArray(valuesToCreate, CREATE_MANY_BATCH_SIZE)) {
    await database.chunkValue.createMany({data: batch})
  }
}

async function syncMeterPointRelations(database, dataset, records, summary) {
  const counter = ensureCounter(summary, 'meterPointLinks')
  const meterIds = dataset.meters.map(item => item.id)
  const existing = await database.compteurPointPrelevement.findMany({
    where: {compteurId: {in: meterIds}}
  })
  const expectedByMeterId = new Map(records.map(item => [item.compteurId, item]))
  const matchingByMeterId = new Map()
  const extraIds = []

  for (const link of existing) {
    const expected = expectedByMeterId.get(link.compteurId)
    const sameUniqueSlot = expected && equalValue(link.startDate, expected.startDate)
    const matches = expected
      && link.pointPrelevementId === expected.pointPrelevementId
      && sameUniqueSlot

    if (matches && !matchingByMeterId.has(link.compteurId)) {
      matchingByMeterId.set(link.compteurId, link)
    } else if (expected?.id === link.id) {
      extraIds.push(link.id)
    } else if (sameUniqueSlot) {
      throw new Error(
        'Un compteur du jeu possède une association manuelle incompatible à la date attendue'
      )
    }
  }

  if (extraIds.length > 0) {
    const result = await database.compteurPointPrelevement.deleteMany({
      where: {id: {in: extraIds}}
    })
    counter.deleted += result.count
  }

  const toCreate = []
  for (const record of records) {
    const current = matchingByMeterId.get(record.compteurId)
    if (!current) {
      toCreate.push(record)
      continue
    }

    const changes = changedFields(current, record, ['endDate'])
    if (Object.keys(changes).length === 0) {
      counter.unchanged += 1
    } else {
      await database.compteurPointPrelevement.update({
        where: {id: current.id},
        data: changes
      })
      counter.updated += 1
    }
  }

  for (const batch of chunkArray(toCreate, CREATE_MANY_BATCH_SIZE)) {
    const result = await database.compteurPointPrelevement.createMany({data: batch})
    counter.created += result.count
  }
}

async function applySeedInTransaction(database, dataset, accounts, preflight, summary) {
  const descriptors = buildDescriptors(dataset, accounts)
  const userRecords = buildUserRecords(descriptors)
  const zoneGeometry = preflight[PREFLIGHT_ZONE_GEOMETRY]
  if (!zoneGeometry) {
    throw new Error('La géométrie validée manque au préflight courant')
  }

  await upsertZone(database, dataset, zoneGeometry, summary)

  summary.authentication = await resetPersonaAuthentication({
    database,
    userRecords
  })

  await syncRecords({
    database,
    model: 'user',
    records: userRecords,
    fields: ['email', 'role', 'firstName', 'lastName', 'deletedAt'],
    summary,
    summaryKey: 'users'
  })
  await syncRecords({
    database,
    model: 'declarant',
    key: 'userId',
    records: buildDeclarantRecords(dataset, descriptors),
    fields: [
      'sourceId',
      'declarantType',
      'declarantRole',
      'preleveurType',
      'socialReason',
      'quickDeclarationEnabled',
      'declarationNotificationsEnabled',
      'lastDeclarationAt'
    ],
    summary,
    summaryKey: 'declarants'
  })
  await syncRecords({
    database,
    model: 'instructor',
    key: 'userId',
    records: buildInstructorRecords(descriptors),
    fields: ['sourceId', 'phoneNumber', 'jobTitle'],
    summary,
    summaryKey: 'instructors'
  })

  await upsertPoints(database, dataset, summary)

  const pointZoneRecords = buildPointZoneRecords(dataset, preflight)
  await syncPairRelations({
    database,
    model: 'pointPrelevementZone',
    ownedWhere: {pointPrelevementId: {in: dataset.points.map(item => item.id)}},
    records: pointZoneRecords,
    leftField: 'pointPrelevementId',
    rightField: 'zoneId',
    summary,
    summaryKey: 'pointZones'
  })

  const exploitationRecords = buildExploitationRecords(dataset, descriptors, preflight)
  await syncRecords({
    database,
    model: 'declarantPointPrelevement',
    records: exploitationRecords,
    fields: [
      'sourceId',
      'declarantUserId',
      'pointPrelevementId',
      'status',
      'startDate',
      'endDate',
      'usageId',
      'pointPrelevementNameAliases',
      'abandonReason',
      'comment',
      'mostRecentAvailableDate'
    ],
    summary,
    summaryKey: 'exploitations'
  })
  const declarantZoneRecords = buildDeclarantZoneRecords(dataset, descriptors, preflight)
  await syncPairRelations({
    database,
    model: 'declarantZone',
    ownedWhere: {
      declarantUserId: {
        in: descriptors.userDescriptors
          .filter(item => item.kind === 'declarant')
          .map(item => item.id)
      }
    },
    records: declarantZoneRecords,
    leftField: 'declarantUserId',
    rightField: 'zoneId',
    fields: ['source', 'createdByUserId'],
    summary,
    summaryKey: 'declarantZones'
  })

  const collectorRecords = buildCollectorExploitationRecords(dataset, descriptors)
  await syncPairRelations({
    database,
    model: 'declarantCollecteurExploitation',
    ownedWhere: {
      collecteurUserId: dataset.personas.ougc.id,
      exploitationId: {in: exploitationRecords.map(item => item.id)}
    },
    records: collectorRecords,
    leftField: 'collecteurUserId',
    rightField: 'exploitationId',
    summary,
    summaryKey: 'collectorExploitations'
  })

  await syncRecords({
    database,
    model: 'compteur',
    records: buildMeterRecords(dataset),
    fields: ['identifier', 'serialNumber', 'deletedAt'],
    summary,
    summaryKey: 'meters'
  })
  await syncMeterPointRelations(
    database,
    dataset,
    buildMeterPointRecords(dataset, descriptors),
    summary
  )

  const instructorZones = buildInstructorZoneRecords(dataset, preflight)
  await syncPairRelations({
    database,
    model: 'instructorZone',
    ownedWhere: {
      instructorUserId: {in: [dataset.personas.ddt.id, dataset.personas.sage.id]}
    },
    records: instructorZones.map(({permissionCodes, ...record}) => record),
    leftField: 'instructorUserId',
    rightField: 'zoneId',
    fields: [
      'isAdmin',
      'startDate',
      'endDate',
      'zoneAttachmentMailSentAt'
    ],
    deleteUnexpectedOwned: true,
    summary,
    summaryKey: 'instructorZones'
  })
  await syncInstructorPermissions(database, dataset, instructorZones, summary)

  await syncDeclarations(database, dataset, descriptors, preflight, summary)
}

export async function applySeed({database, dataset, accounts, preflight}) {
  assertDatabase(database, {transaction: true})
  assertDataset(dataset)
  assertAccounts(accounts)
  assertRecord(preflight, 'preflight')

  const digest = datasetSha256(dataset)
  if (preflight.success !== true
    || preflight.datasetId !== dataset.metadata.id
    || preflight.sourcePrefix !== dataset.metadata.sourcePrefix
    || preflight.datasetSha256 !== digest) {
    throw new Error('Le préflight ne correspond pas exactement au jeu à appliquer')
  }

  const summary = {}
  const applyTransaction = async transaction => {
    const lockedPreflight = await preflightSeed({
      database: transaction,
      dataset,
      accounts
    })
    if (lockedPreflight.datasetSha256 !== preflight.datasetSha256
      || !equalValue(lockedPreflight.references, preflight.references)
      || !equalValue(lockedPreflight.geometry, preflight.geometry)) {
      throw new Error('La cible a changé depuis le préflight ; relancer le préflight')
    }

    await applySeedInTransaction(
      transaction,
      dataset,
      accounts,
      lockedPreflight,
      summary
    )
  }

  await runSeedLockedTransaction({database, operation: applyTransaction})

  return {
    success: true,
    datasetId: dataset.metadata.id,
    datasetSha256: digest,
    sourcePrefix: dataset.metadata.sourcePrefix,
    summary
  }
}
