import {createHash} from 'node:crypto'
import path from 'node:path'

import {parse as parseCsv} from 'csv-parse/sync'

export const TERRITORY_CODE = 'DEP-974'
export const MIGRATION_PREFIX = `reunion:${TERRITORY_CODE}`
export const MANIFEST_VERSION = 2
export const TRANSFORMER_VERSION = '1.0.0'
export const EXCLUDED_DOCUMENT_ID = '698ebd5cdf08b37f8d166721'

const COMMANDS = new Set(['snapshot', 'preflight', 'apply', 'verify', 'all'])
export const TARGET_POLICIES = Object.freeze({
  local: Object.freeze({
    appEnv: 'reunion-local',
    database: Object.freeze({
      host: '127.0.0.1',
      port: '5433',
      serverPort: '5432',
      name: 'pe_reunion',
      user: 'pe_reunion',
      tls: false
    }),
    s3: Object.freeze({
      endpoint: 'http://127.0.0.1:9002',
      region: 'fr-par',
      bucket: 'reunion-migration-documents'
    })
  }),
  testing: Object.freeze({
    appEnv: 'testing',
    database: Object.freeze({
      host: 'rw-a94bb20e-1f62-4203-9b60-234c12170876.rdb.fr-par.scw.cloud',
      port: '5826',
      serverPort: '5432',
      name: 'testing-partageons-leau-api',
      user: 'testing-partageons-leau-api',
      tls: true,
      caSha256: 'ad17b661b024ece4e73ffc38072169d92cda7f4128854b42d02cb3ce786d5948'
    }),
    s3: Object.freeze({
      endpoint: 'https://s3.fr-par.scw.cloud',
      region: 'fr-par',
      bucket: 'testing-documents'
    })
  })
})
const OPTIONS_WITH_VALUE = new Set([
  '--backup-id',
  '--confirm-target',
  '--document-exclusions',
  '--manifest',
  '--point-overrides',
  '--report',
  '--source-mongo-db',
  '--source-mongo-uri',
  '--source-s3-env',
  '--target',
  '--target-env',
  '--usage-map'
])

const OPTION_KEYS = new Map([
  ['--backup-id', 'backupId'],
  ['--confirm-target', 'confirmTarget'],
  ['--document-exclusions', 'documentExclusions'],
  ['--manifest', 'manifest'],
  ['--point-overrides', 'pointOverrides'],
  ['--report', 'report'],
  ['--source-mongo-db', 'sourceMongoDb'],
  ['--source-mongo-uri', 'sourceMongoUri'],
  ['--source-s3-env', 'sourceS3Env'],
  ['--target', 'target'],
  ['--target-env', 'targetEnv'],
  ['--usage-map', 'usageMap']
])

export function parseArguments(arguments_, defaults = {}) {
  const options = {
    command: undefined,
    apply: false,
    help: false,
    skipS3: false,
    ...defaults
  }

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]

    if (!options.command && COMMANDS.has(argument)) {
      options.command = argument
      continue
    }

    if (argument === '--apply') {
      options.apply = true
      continue
    }

    if (argument === '--skip-s3') {
      options.skipS3 = true
      continue
    }

    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }

    const [optionName, inlineValue] = argument.split(/=(.*)/s, 2)
    if (OPTIONS_WITH_VALUE.has(optionName)) {
      const value = inlineValue ?? arguments_[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`Option ${optionName} attend une valeur`)
      }

      options[OPTION_KEYS.get(optionName)] = value
      if (inlineValue === undefined) {
        index += 1
      }

      continue
    }

    if (argument.startsWith('--')) {
      throw new Error(`Option inconnue: ${argument}`)
    }

    throw new Error(`Argument inattendu: ${argument}`)
  }

  if (!options.command && !options.help) {
    throw new Error(`Commande attendue: ${[...COMMANDS].join(', ')}`)
  }

  return options
}

function parseTargetIdentity(target, targetEnvironment) {
  const policy = TARGET_POLICIES[target]
  if (targetEnvironment.APP_ENV !== policy.appEnv) {
    throw new Error(`Cible ${target}: APP_ENV doit valoir exactement ${policy.appEnv}`)
  }

  let databaseUrl
  let s3Endpoint
  try {
    databaseUrl = new URL(targetEnvironment.DATABASE_URL)
    s3Endpoint = new URL(targetEnvironment.S3_ENDPOINT)
  } catch {
    throw new Error(`Cible ${target}: DATABASE_URL ou S3_ENDPOINT invalide`)
  }

  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
    throw new Error(`Cible ${target}: DATABASE_URL doit utiliser PostgreSQL`)
  }

  const allowedDatabaseParameters = policy.database.tls
    ? new Set(['sslmode', 'sslrootcert'])
    : new Set()
  for (const key of new Set(databaseUrl.searchParams.keys())) {
    if (!allowedDatabaseParameters.has(key)) {
      throw new Error(`Cible ${target}: paramètre DATABASE_URL interdit (${key})`)
    }
  }

  for (const key of allowedDatabaseParameters) {
    if (databaseUrl.searchParams.getAll(key).length !== 1) {
      throw new Error(`Cible ${target}: paramètre DATABASE_URL absent ou dupliqué (${key})`)
    }
  }

  const database = {
    host: databaseUrl.hostname.toLowerCase(),
    port: databaseUrl.port,
    name: decodeURIComponent(databaseUrl.pathname.replace(/^\//, '')),
    user: decodeURIComponent(databaseUrl.username),
    tls: databaseUrl.searchParams.get('sslmode') === 'verify-full'
  }
  if (!databaseUrl.password) {
    throw new Error(`Cible ${target}: DATABASE_URL doit contenir le mot de passe PostgreSQL`)
  }

  for (const key of ['host', 'port', 'name', 'user', 'tls']) {
    if (database[key] !== policy.database[key]) {
      throw new Error(`Cible ${target}: identité PostgreSQL non autorisée (${key})`)
    }
  }

  const sslRootCert = databaseUrl.searchParams.get('sslrootcert')
  if (policy.database.tls && !sslRootCert) {
    throw new Error(`Cible ${target}: sslrootcert est requis avec sslmode=verify-full`)
  }

  if (s3Endpoint.username || s3Endpoint.password || s3Endpoint.search || s3Endpoint.hash) {
    throw new Error(`Cible ${target}: S3_ENDPOINT ne doit contenir ni identifiant ni paramètre`)
  }

  const normalizedS3Endpoint = s3Endpoint.href.replace(/\/$/, '')
  const s3 = {
    endpoint: normalizedS3Endpoint,
    region: targetEnvironment.S3_REGION,
    bucket: `${targetEnvironment.S3_BUCKET_PREFIX ?? ''}documents`
  }
  for (const key of ['endpoint', 'region', 'bucket']) {
    if (s3[key] !== policy.s3[key]) {
      throw new Error(`Cible ${target}: identité S3 non autorisée (${key})`)
    }
  }

  return {target, appEnv: targetEnvironment.APP_ENV, database, s3, sslRootCert}
}

export function buildTargetAttestation({target, targetEnvironment, manifestSha256}) {
  const identity = parseTargetIdentity(target, targetEnvironment)
  const safeIdentity = {
    target: identity.target,
    appEnv: identity.appEnv,
    database: identity.database,
    s3: identity.s3,
    manifestSha256
  }
  const fingerprint = sha256(stableStringify(safeIdentity)).slice(0, 12)
  return {
    ...safeIdentity,
    fingerprint,
    confirmation: target === 'testing' ? `${target}:${fingerprint}` : target,
    sslRootCert: identity.sslRootCert
  }
}

export function assertSafeTarget({
  target,
  confirmTarget,
  apply,
  targetEnv,
  targetEnvironment = {},
  manifestSha256
}) {
  if (!['local', 'testing'].includes(target)) {
    throw new Error('La cible doit être explicitement local ou testing; production est interdite')
  }

  const productionClues = [
    targetEnv && path.basename(targetEnv),
    targetEnvironment.APP_ENV,
    targetEnvironment.SCALINGO_APP_NAME,
    targetEnvironment.SCW_CONTAINER_NAME,
    targetEnvironment.DATABASE_URL
  ].filter(Boolean)

  if (productionClues.some(value => /(^|[^a-z])prod(?:uction)?([^a-z]|$)/i.test(String(value)))) {
    throw new Error('Cible production détectée: cette migration la refuse sans exception')
  }

  const attestation = buildTargetAttestation({target, targetEnvironment, manifestSha256})
  if (apply && confirmTarget !== attestation.confirmation) {
    throw new Error(`Écriture refusée: ajouter --confirm-target ${attestation.confirmation}`)
  }

  return attestation
}

export function stableSourceId(entity, legacyId, ownerId) {
  if (!entity || legacyId === undefined || legacyId === null || legacyId === '') {
    throw new Error('Entity et legacyId sont requis pour construire un sourceId')
  }

  const base = `${MIGRATION_PREFIX}:${entity}:${String(legacyId)}`
  return ownerId === undefined || ownerId === null
    ? base
    : `${base}:owner:${String(ownerId)}`
}

export function rootUsageCode(value) {
  const match = String(value ?? '').trim().toUpperCase().match(/^(\d+)/)
  if (!match) {
    throw new Error(`Code usage SANDRE invalide: ${value}`)
  }

  return match[1]
}

export function normalizeUsageCodes(value) {
  const roots = String(value ?? '')
    .split(/[;,|]/)
    .map(item => item.trim())
    .filter(Boolean)
    .map(rootUsageCode)

  return [...new Set(roots)]
}

export function parseUsageMap(content) {
  const rows = parseCsv(content, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    trim: true
  })

  const result = new Map()
  for (const row of rows) {
    const legacyId = String(row.legacy_exploitation_id ?? '').trim()
    if (!legacyId) {
      throw new Error('usage-map.csv contient une ligne sans legacy_exploitation_id')
    }

    if (result.has(legacyId)) {
      throw new Error(`usage-map.csv contient un doublon pour l’exploitation ${legacyId}`)
    }

    const primary = rootUsageCode(row.primary_usage_code)
    const secondary = normalizeUsageCodes(row.secondary_usage_codes)
      .filter(code => code !== primary)

    result.set(legacyId, {
      legacyId,
      sourceUsageCodes: String(row.source_usage_codes ?? '').trim(),
      primary,
      secondary,
      provenance: String(row.provenance ?? '').trim()
    })
  }

  return result
}

export function parsePointOverrides(content) {
  const rows = parseCsv(content, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    trim: true
  })

  return new Map(rows.map(row => [String(row.legacy_point_id), {
    waterBodyType: row.water_body_type || undefined,
    forcedZoneCode: row.forced_zone_code || undefined,
    reason: row.reason || undefined
  }]))
}

export function parseDocumentExclusions(content) {
  const rows = parseCsv(content, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    trim: true
  })

  return new Map(rows.map(row => [String(row.legacy_document_id), row.reason]))
}

export function normalizeEmail(value) {
  if (typeof value !== 'string') {
    return undefined
  }

  const normalized = value.normalize('NFC').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return undefined
  }

  return normalized
}

export function getDeclarantEmails(declarant) {
  const raw = [
    declarant.email,
    ...(Array.isArray(declarant.autresEmails) ? declarant.autresEmails : [])
  ]

  const emails = raw.map(normalizeEmail).filter(Boolean)
  return [...new Set(emails)]
}

export function buildDeclarantContactPlan({declarantLegacyId, emails, current}) {
  const expected = [...new Set(emails.map(normalizeEmail).filter(Boolean))].map((email, index) => ({
    email,
    isPrimary: index === 0,
    sourceId: stableSourceId('contact', `${declarantLegacyId}:${sha256(email).slice(0, 20)}`)
  }))
  const expectedByEmail = new Map(expected.map(item => [item.email, item]))
  const staleIds = current
    .filter(item => item.sourceId?.startsWith(`${MIGRATION_PREFIX}:contact:`))
    .filter(item => !expectedByEmail.has(normalizeEmail(item.email)))
    .map(item => item.id)
  const expectedMatches = expected.every(item => current.some(candidate => (
    normalizeEmail(candidate.email) === item.email
    && candidate.sourceId === item.sourceId
    && candidate.isPrimary === item.isPrimary
  )))
  const unexpectedPrimary = expected.length > 0 && current.some(item => (
    item.isPrimary
    && normalizeEmail(item.email) !== expected[0]?.email
  ))

  return {
    expected,
    staleIds,
    unchanged: expectedMatches && staleIds.length === 0 && !unexpectedPrimary
  }
}

export function chooseDeclarantLoginEmail({declarant, sourceEmailOwners, agentEmails, targetEmailOwners, existingUserId}) {
  const [primary] = getDeclarantEmails(declarant)
  if (!primary) {
    return null
  }

  if ((sourceEmailOwners.get(primary)?.size ?? 0) !== 1 || agentEmails.has(primary)) {
    return null
  }

  const targetOwners = targetEmailOwners.get(primary) ?? new Set()
  if (targetOwners.size === 0) {
    return primary
  }

  return targetOwners.size === 1 && existingUserId && targetOwners.has(existingUserId)
    ? primary
    : null
}

export function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    )
  }

  return value
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value))
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function buildTransformationContract({usageMap, pointOverrides, documentExclusions}) {
  return {
    transformerVersion: TRANSFORMER_VERSION,
    inputs: {
      usageMapSha256: sha256(usageMap),
      pointOverridesSha256: sha256(pointOverrides),
      documentExclusionsSha256: sha256(documentExclusions)
    }
  }
}

export function assertTransformationContract(contract, contents) {
  if (!contract || typeof contract !== 'object') {
    throw new Error('Contrat de transformation absent du manifeste')
  }

  if (contract.transformerVersion !== TRANSFORMER_VERSION) {
    throw new Error(
      `Version de transformateur incompatible: ${contract.transformerVersion ?? 'absente'}`
    )
  }

  const actual = buildTransformationContract(contents)
  const inputNames = [
    ['usageMapSha256', 'usage-map.csv'],
    ['pointOverridesSha256', 'point-overrides.csv'],
    ['documentExclusionsSha256', 'document-exclusions.csv']
  ]
  for (const [key, label] of inputNames) {
    if (contract.inputs?.[key] !== actual.inputs[key]) {
      throw new Error(`Fichier de transformation différent du manifeste: ${label}`)
    }
  }
}

export function manifestLines(header, records) {
  const first = stableStringify({kind: 'header', ...header, manifestVersion: MANIFEST_VERSION})
  const rest = records.map(record => stableStringify(record))
  return `${[first, ...rest].join('\n')}\n`
}

export function readManifestContent(content) {
  const lines = content.split(/\r?\n/).filter(Boolean)
  if (lines.length === 0) {
    throw new Error('Manifeste vide')
  }

  const [header, ...records] = lines.map(line => JSON.parse(line))
  if (header.kind !== 'header' || header.manifestVersion !== MANIFEST_VERSION) {
    throw new Error(`Version de manifeste non supportée: ${header.manifestVersion ?? 'absente'}`)
  }

  if (!header.transformationContract) {
    throw new Error('Contrat de transformation absent du manifeste')
  }

  return {header, records}
}

export function groupManifestRecords(records) {
  const groups = new Map()
  for (const record of records) {
    if (!record.kind || record.kind === 'header') {
      throw new Error('Chaque ligne de données du manifeste doit avoir un kind')
    }

    if (!groups.has(record.kind)) {
      groups.set(record.kind, [])
    }

    groups.get(record.kind).push(record.data)
  }

  return groups
}

export function legacyId(value) {
  if (value && typeof value === 'object' && '$oid' in value) {
    return String(value.$oid)
  }

  return String(value)
}

export function legacyNestedString(value, property) {
  const candidate = value && typeof value === 'object' && !Array.isArray(value)
    ? value[property]
    : value

  if (candidate === undefined || candidate === null || candidate === '') {
    return null
  }

  if (['string', 'number', 'bigint'].includes(typeof candidate)) {
    return String(candidate)
  }

  return null
}

// Les relations legacy N-N et les propriétaires croisés sont volontairement traités ensemble.
// eslint-disable-next-line complexity
export function partitionDocuments({documents, exploitations, rules, excludedDocumentIds = new Set()}) {
  const exploitationById = new Map(exploitations.map(item => [legacyId(item._id), item]))
  const exploitationIdsByDocument = new Map()

  for (const exploitation of exploitations) {
    for (const documentId of exploitation.documents ?? []) {
      const key = legacyId(documentId)
      if (!exploitationIdsByDocument.has(key)) {
        exploitationIdsByDocument.set(key, new Set())
      }

      exploitationIdsByDocument.get(key).add(legacyId(exploitation._id))
    }
  }

  for (const rule of rules) {
    if (!rule.document) {
      continue
    }

    const documentId = legacyId(rule.document)
    if (!exploitationIdsByDocument.has(documentId)) {
      exploitationIdsByDocument.set(documentId, new Set())
    }

    for (const exploitationId of rule.exploitations ?? []) {
      if (exploitationById.has(legacyId(exploitationId))) {
        exploitationIdsByDocument.get(documentId).add(legacyId(exploitationId))
      }
    }
  }

  const plans = []
  for (const document of documents) {
    const documentId = legacyId(document._id)
    if (excludedDocumentIds.has(documentId)) {
      continue
    }

    const exploitationIds = [...(exploitationIdsByDocument.get(documentId) ?? [])]
    const idsByOwner = new Map()
    for (const exploitationId of exploitationIds) {
      const exploitation = exploitationById.get(exploitationId)
      if (!exploitation?.preleveur) {
        continue
      }

      const ownerId = legacyId(exploitation.preleveur)
      if (!idsByOwner.has(ownerId)) {
        idsByOwner.set(ownerId, [])
      }

      idsByOwner.get(ownerId).push(exploitationId)
    }

    if (idsByOwner.size === 0 && document.preleveur) {
      idsByOwner.set(legacyId(document.preleveur), [])
    }

    for (const [ownerId, ownerExploitationIds] of idsByOwner) {
      plans.push({
        document,
        documentId,
        ownerId,
        exploitationIds: [...new Set(ownerExploitationIds)].sort()
      })
    }
  }

  return plans.sort((left, right) => (
    left.documentId.localeCompare(right.documentId) || left.ownerId.localeCompare(right.ownerId)
  ))
}

export function partitionRules({rules, exploitations, excludedDocumentIds = new Set()}) {
  const exploitationById = new Map(exploitations.map(item => [legacyId(item._id), item]))
  const plans = []

  for (const rule of rules) {
    const ruleId = legacyId(rule._id)
    const idsByOwner = new Map()

    for (const rawExploitationId of rule.exploitations ?? []) {
      const exploitationId = legacyId(rawExploitationId)
      const exploitation = exploitationById.get(exploitationId)
      if (!exploitation?.preleveur) {
        continue
      }

      const ownerId = legacyId(exploitation.preleveur)
      if (!idsByOwner.has(ownerId)) {
        idsByOwner.set(ownerId, [])
      }

      idsByOwner.get(ownerId).push(exploitationId)
    }

    for (const [ownerId, exploitationIds] of idsByOwner) {
      const documentId = rule.document && legacyId(rule.document)
      plans.push({
        rule,
        ruleId,
        ownerId,
        exploitationIds: [...new Set(exploitationIds)].sort(),
        documentId: documentId && !excludedDocumentIds.has(documentId) ? documentId : null
      })
    }
  }

  return plans.sort((left, right) => (
    left.ruleId.localeCompare(right.ruleId) || left.ownerId.localeCompare(right.ownerId)
  ))
}

export function getWaterBodyType(point, override) {
  if (override?.waterBodyType) {
    return override.waterBodyType
  }

  const values = new Map([
    ['Eau de surface', 'SUPERFICIELLE'],
    ['Eau souterraine', 'SOUTERRAIN'],
    ['Eau de transition', 'TRANSITION']
  ])

  return values.get(point.type_milieu)
}

export function getExploitationStatus(value) {
  return new Map([
    ['En activité', 'EN_ACTIVITE'],
    ['Terminée', 'TERMINEE'],
    ['Abandonnée', 'ABANDONNEE'],
    ['Non renseigné', 'NON_RENSEIGNE']
  ]).get(value)
}

export function toDate(value) {
  if (!value) {
    return null
  }

  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) {
    return null
  }

  return date
}

export function toDateOnly(value) {
  const date = toDate(value)
  return date ? new Date(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`) : null
}

export function safeFilename(value) {
  const filename = path.basename(String(value || 'document')).normalize('NFC')
  // eslint-disable-next-line no-control-regex
  return filename.replaceAll(/[\u0000-\u001F\u007F]/g, '_')
}

export function deterministicStorageKey({ownerLegacyId, documentLegacyId, filename}) {
  return [
    'reunion',
    TERRITORY_CODE,
    String(ownerLegacyId),
    String(documentLegacyId),
    safeFilename(filename)
  ].join('/')
}

export function compareData(current, expected) {
  for (const [key, value] of Object.entries(expected)) {
    const currentValue = current[key]
    if (value instanceof Date || currentValue instanceof Date) {
      if ((value && new Date(value).toISOString()) !== (currentValue && new Date(currentValue).toISOString())) {
        return false
      }

      continue
    }

    if (stableStringify(currentValue) !== stableStringify(value)) {
      return false
    }
  }

  return true
}

// Le préflight agrège toutes les erreurs pour éviter les cycles correction/relance unitaire.
// eslint-disable-next-line complexity
export function buildPreflight({groups, usageMap, pointOverrides, excludedDocumentIds}) {
  const issues = []
  const warnings = []
  const declarants = groups.get('declarant') ?? []
  const points = groups.get('point') ?? []
  const exploitations = groups.get('exploitation') ?? []
  const agents = groups.get('agent') ?? []
  const documents = groups.get('document') ?? []
  const rules = groups.get('rule') ?? []

  const declarantIds = new Set(declarants.map(item => legacyId(item._id)))
  const pointIds = new Set(points.map(item => legacyId(item._id)))
  const exploitationIds = new Set(exploitations.map(item => legacyId(item._id)))
  const documentIds = new Set(documents.map(item => legacyId(item._id)))

  for (const agent of agents) {
    const role = (agent.roles ?? []).find(item => item.territoire === TERRITORY_CODE)?.role
    if (!['reader', 'editor'].includes(role)) {
      issues.push({code: 'INVALID_AGENT_ROLE', entity: 'agent', legacyId: legacyId(agent._id)})
    }

    if (!normalizeEmail(agent.email)) {
      issues.push({code: 'INVALID_AGENT_EMAIL', entity: 'agent', legacyId: legacyId(agent._id)})
    }
  }

  for (const exploitation of exploitations) {
    const id = String(exploitation.id_exploitation)
    if (!usageMap.has(id)) {
      issues.push({code: 'MISSING_USAGE_MAPPING', entity: 'exploitation', legacyId: id})
    }

    if (!declarantIds.has(legacyId(exploitation.preleveur))) {
      issues.push({code: 'MISSING_DECLARANT_REFERENCE', entity: 'exploitation', legacyId: id})
    }

    if (!pointIds.has(legacyId(exploitation.point))) {
      issues.push({code: 'MISSING_POINT_REFERENCE', entity: 'exploitation', legacyId: id})
    }

    if (!getExploitationStatus(exploitation.statut)) {
      issues.push({code: 'INVALID_STATUS', entity: 'exploitation', legacyId: id})
    }

    for (const rawDocumentId of exploitation.documents ?? []) {
      const documentId = legacyId(rawDocumentId)
      if (!documentIds.has(documentId) && !excludedDocumentIds.has(documentId)) {
        issues.push({
          code: 'MISSING_EXPLOITATION_DOCUMENT_REFERENCE',
          entity: 'exploitation',
          legacyId: id
        })
      }
    }
  }

  for (const point of points) {
    const id = String(point.id_point)
    const override = pointOverrides.get(id)
    if (override?.forcedZoneCode && override.forcedZoneCode !== 'reg-04') {
      issues.push({code: 'UNSUPPORTED_FORCED_ZONE', entity: 'point', legacyId: id})
    }

    if (!getWaterBodyType(point, override)) {
      issues.push({code: 'MISSING_WATER_BODY_TYPE', entity: 'point', legacyId: id})
    }

    const coordinates = point.geom?.coordinates
    if (!Array.isArray(coordinates) || coordinates.length !== 2 || coordinates.some(value => !Number.isFinite(Number(value)))) {
      issues.push({code: 'INVALID_COORDINATES', entity: 'point', legacyId: id})
    }
  }

  for (const document of documents) {
    const id = legacyId(document._id)
    if (excludedDocumentIds.has(id)) {
      continue
    }

    if (!document.objectKey) {
      issues.push({code: 'MISSING_OBJECT_KEY', entity: 'document', legacyId: id})
    } else if (!document.s3?.sha256) {
      issues.push({code: 'MISSING_OBJECT_CHECKSUM', entity: 'document', legacyId: id})
    }

    if (document.s3?.missing) {
      issues.push({code: 'MISSING_SOURCE_OBJECT', entity: 'document', legacyId: id})
    }
  }

  for (const rule of rules) {
    const id = legacyId(rule._id)
    const linked = (rule.exploitations ?? []).map(legacyId).filter(item => exploitationIds.has(item))
    if (linked.length === 0) {
      issues.push({code: 'RULE_WITHOUT_ACTIVE_EXPLOITATION', entity: 'rule', legacyId: id})
    }

    if (rule.document && !excludedDocumentIds.has(legacyId(rule.document)) && !documentIds.has(legacyId(rule.document))) {
      warnings.push({code: 'RULE_DOCUMENT_NOT_MIGRATED', entity: 'rule', legacyId: id})
    }
  }

  if (!excludedDocumentIds.has(EXCLUDED_DOCUMENT_ID)) {
    issues.push({code: 'REQUIRED_DOCUMENT_EXCLUSION_MISSING', entity: 'document', legacyId: EXCLUDED_DOCUMENT_ID})
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    counts: {
      declarants: declarants.length,
      points: points.length,
      exploitations: exploitations.length,
      agents: agents.length,
      documents: documents.length,
      rules: rules.length
    }
  }
}
