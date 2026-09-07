#!/usr/bin/env node
import process from 'node:process'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {
  EXCLUDED_DOCUMENT_ID,
  MANIFEST_VERSION,
  MIGRATION_PREFIX,
  TERRITORY_CODE,
  assertSafeTarget,
  assertTransformationContract,
  buildDeclarantContactPlan,
  buildPreflight,
  buildTransformationContract,
  chooseDeclarantLoginEmail,
  compareData,
  deterministicStorageKey,
  getDeclarantEmails,
  getExploitationStatus,
  getWaterBodyType,
  groupManifestRecords,
  legacyId,
  legacyNestedString,
  manifestLines,
  normalizeEmail,
  parseArguments,
  parseDocumentExclusions,
  parsePointOverrides,
  parseUsageMap,
  partitionDocuments,
  partitionRules,
  readManifestContent,
  safeFilename,
  stableSourceId,
  toDate,
  toDateOnly
} from './lib/core.js'
import {
  assertDistinctS3Locations,
  assertManifestOutputsAbsent,
  assertTargetCertificate,
  assertVersionedS3Bucket,
  attestTargetDatabase,
  copyS3Object,
  createS3Context,
  createTargetPrisma,
  hashS3Object,
  loadEnv,
  normalizeMongoReferences,
  requireEnv,
  verifyManifestChecksum,
  withMongoDatabase,
  writeJsonReport,
  writeManifestAndChecksum
} from './lib/runtime.js'
import {
  READ_ONLY_ZONE_PERMISSIONS,
  ZONE_PERMISSION_CODES
} from '../../lib/constants/zone-permissions.js'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const SCRIPT_DIRECTORY = path.dirname(SCRIPT_PATH)
const DEFAULTS = {
  usageMap: path.join(SCRIPT_DIRECTORY, 'data/usage-map.csv'),
  pointOverrides: path.join(SCRIPT_DIRECTORY, 'data/point-overrides.csv'),
  documentExclusions: path.join(SCRIPT_DIRECTORY, 'data/document-exclusions.csv')
}

function printUsage() {
  console.log(`Migration Réunion vers PE (hors données de volumes)

Usage:
  node scripts/reunion/migrate-reunion.js <snapshot|preflight|apply|verify|all> [options]

Options communes:
  --manifest <fichier.jsonl>        Manifeste sécurisé à créer ou lire
  --usage-map <fichier.csv>         Correspondance par id_exploitation
  --point-overrides <fichier.csv>   Exceptions explicites des PP
  --document-exclusions <csv>       Exclusions documentaires explicites
  --report <fichier.json>           Rapport anonymisé (0600)
  --target <local|testing>           Cible; production est toujours refusée
  --target-env <fichier.env>         DATABASE_URL et configuration S3 cible
  --apply                            Autorise les écritures pour apply/all
  --confirm-target <confirmation>   local, ou testing:<empreinte du préflight>

Snapshot/all:
  --source-mongo-uri <uri>           URI locale sans secret; sinon REUNION_MONGO_URL
  --source-mongo-db <nom>            Base Mongo source
  --source-s3-env <fichier.env>      Configuration S3 documents en lecture
  --backup-id <id>                   Identifiant du backup inscrit au manifeste
  --skip-s3                          Diagnostic snapshot seulement; apply le refuse

Exemple local sans écriture:
  node scripts/reunion/migrate-reunion.js all \
    --source-mongo-db preservons-leau \
    --source-s3-env /run/secrets/reunion-s3.env \
    --manifest /var/tmp/pe-reunion/snapshot.jsonl \
    --target local --target-env .env

Application locale explicite:
  node scripts/reunion/migrate-reunion.js apply \
    --manifest /var/tmp/pe-reunion/snapshot.jsonl \
    --source-s3-env /run/secrets/reunion-s3.env \
    --target local --target-env .env \
    --apply --confirm-target local
`)
}

function asPlainObject(value) {
  // JSON étendu Mongo: ObjectId.toJSON() et Date.toJSON() donnent un manifeste portable.
  // eslint-disable-next-line unicorn/prefer-structured-clone
  return JSON.parse(JSON.stringify(value))
}

function activeFilter() {
  return {deletedAt: {$exists: false}}
}

function asObjectIdStringSet(values) {
  return new Set(values.filter(Boolean).map(legacyId))
}

async function readSourceSnapshot(database) {
  const points = await database.collection('points_prelevement').find({
    territoire: TERRITORY_CODE,
    ...activeFilter()
  }, {
    projection: {
      _id: 1,
      id_point: 1,
      nom: 1,
      autresNoms: 1,
      code_aiot: 1,
      type_milieu: 1,
      profondeur: 1,
      zre: 1,
      reservoir_biologique: 1,
      cours_eau: 1,
      detail_localisation: 1,
      geom: 1,
      precision_geom: 1,
      remarque: 1,
      remarque_interne: 1,
      bss: 1,
      bnpe: 1,
      meso: 1,
      meContinentalesBv: 1,
      bvBdCarthage: 1,
      commune: 1,
      createdAt: 1,
      updatedAt: 1
    }
  }).sort({id_point: 1}).toArray()

  const declarants = await database.collection('preleveurs').find({
    territoire: TERRITORY_CODE,
    ...activeFilter()
  }, {
    projection: {
      _id: 1,
      id_preleveur: 1,
      raison_sociale: 1,
      sigle: 1,
      civilite: 1,
      nom: 1,
      prenom: 1,
      email: 1,
      autresEmails: 1,
      adresse_1: 1,
      adresse_2: 1,
      bp: 1,
      code_postal: 1,
      commune: 1,
      numero_telephone: 1,
      siret: 1,
      createdAt: 1,
      updatedAt: 1
    }
  }).sort({id_preleveur: 1}).toArray()

  const exploitations = await database.collection('exploitations').find({
    territoire: TERRITORY_CODE,
    ...activeFilter()
  }, {
    projection: {
      _id: 1,
      id_exploitation: 1,
      point: 1,
      preleveur: 1,
      date_debut: 1,
      date_fin: 1,
      statut: 1,
      raison_abandon: 1,
      remarque: 1,
      usages: 1,
      documents: 1,
      createdAt: 1,
      updatedAt: 1
    }
  }).sort({id_exploitation: 1}).toArray()

  const rules = await database.collection('regles').find({
    territoire: TERRITORY_CODE,
    ...activeFilter()
  }, {
    projection: {
      _id: 1,
      preleveur: 1,
      exploitations: 1,
      document: 1,
      parametre: 1,
      frequence: 1,
      unite: 1,
      valeur: 1,
      contrainte: 1,
      debut_validite: 1,
      fin_validite: 1,
      debut_periode: 1,
      fin_periode: 1,
      remarque: 1,
      createdAt: 1,
      updatedAt: 1
    }
  }).sort({_id: 1}).toArray()

  const agents = await database.collection('users').find({
    roles: {$elemMatch: {territoire: TERRITORY_CODE}},
    ...activeFilter()
  }, {
    projection: {
      _id: 1,
      email: 1,
      nom: 1,
      prenom: 1,
      structure: 1,
      fonction: 1,
      telephone: 1,
      roles: 1,
      createdAt: 1,
      updatedAt: 1
    }
  }).sort({_id: 1}).toArray()

  const rawReferencedDocumentIds = [
    ...exploitations.flatMap(item => item.documents ?? []),
    ...rules.map(item => item.document).filter(Boolean)
  ]
  const referencedDocumentIdSet = asObjectIdStringSet(rawReferencedDocumentIds)
  const referencedDocumentIds = await normalizeMongoReferences(rawReferencedDocumentIds)
  const documents = await database.collection('documents').find({
    $and: [
      {$or: [
        {territoire: TERRITORY_CODE},
        {_id: {$in: referencedDocumentIds}}
      ]},
      {$or: [
        {deletedAt: {$exists: false}},
        {_id: {$in: referencedDocumentIds}}
      ]}
    ]
  }, {
    projection: {
      _id: 1,
      preleveur: 1,
      nom_fichier: 1,
      taille: 1,
      objectKey: 1,
      reference: 1,
      nature: 1,
      date_signature: 1,
      date_fin_validite: 1,
      date_ajout: 1,
      remarque: 1,
      deletedAt: 1,
      createdAt: 1,
      updatedAt: 1
    }
  }).sort({_id: 1}).toArray()

  return {
    declarants,
    points,
    exploitations,
    agents,
    documents: documents.filter(item => !item.deletedAt || referencedDocumentIdSet.has(legacyId(item._id))),
    rules
  }
}

async function createSnapshot(options) {
  const sourceMongoUri = options.sourceMongoUri ?? process.env.REUNION_MONGO_URL
  if (!options.manifest || !sourceMongoUri || !options.sourceMongoDb) {
    throw new Error('snapshot exige --manifest, --source-mongo-db et REUNION_MONGO_URL (ou --source-mongo-uri)')
  }

  if (!options.skipS3 && !options.sourceS3Env) {
    throw new Error('snapshot exige --source-s3-env pour checksummer les documents')
  }

  // Refuser immédiatement un chemin déjà publié, avant toute lecture Mongo/S3
  // potentiellement longue. writeManifestAndChecksum refait ce contrôle pour
  // fermer la fenêtre de concurrence lors de la publication atomique.
  await assertManifestOutputsAbsent(options.manifest)
  const [usageMapContent, pointOverridesContent, documentExclusionsContent] = await Promise.all([
    readFile(options.usageMap),
    readFile(options.pointOverrides),
    readFile(options.documentExclusions)
  ])
  parseUsageMap(usageMapContent.toString('utf8'))
  parsePointOverrides(pointOverridesContent.toString('utf8'))
  parseDocumentExclusions(documentExclusionsContent.toString('utf8'))
  const transformationContract = buildTransformationContract({
    usageMap: usageMapContent,
    pointOverrides: pointOverridesContent,
    documentExclusions: documentExclusionsContent
  })

  const sourceS3 = options.skipS3
    ? null
    : createS3Context(await loadEnv(options.sourceS3Env), 'S3 source')

  const snapshot = await withMongoDatabase({
    uri: sourceMongoUri,
    databaseName: options.sourceMongoDb
  }, readSourceSnapshot)

  try {
    if (sourceS3) {
      let count = 0
      const checksumsByObjectKey = new Map()
      for (const document of snapshot.documents) {
        if (legacyId(document._id) === EXCLUDED_DOCUMENT_ID) {
          document.s3 = {missing: true, excluded: true}
          continue
        }

        if (!document.objectKey) {
          document.s3 = {missing: true}
        } else if (checksumsByObjectKey.has(document.objectKey)) {
          document.s3 = checksumsByObjectKey.get(document.objectKey)
        } else {
          document.s3 = await hashS3Object(sourceS3, document.objectKey)
          checksumsByObjectKey.set(document.objectKey, document.s3)
        }

        count += 1
        if (count % 100 === 0) {
          console.log(`[reunion:snapshot] documents contrôlés=${count}`)
        }
      }
    }
  } finally {
    sourceS3?.client.destroy()
  }

  const records = [
    ...snapshot.declarants.map(data => ({kind: 'declarant', data: asPlainObject(data)})),
    ...snapshot.points.map(data => ({kind: 'point', data: asPlainObject(data)})),
    ...snapshot.exploitations.map(data => ({kind: 'exploitation', data: asPlainObject(data)})),
    ...snapshot.agents.map(data => ({kind: 'agent', data: asPlainObject(data)})),
    ...snapshot.documents.map(data => ({kind: 'document', data: asPlainObject(data)})),
    ...snapshot.rules.map(data => ({kind: 'rule', data: asPlainObject(data)}))
  ]
  const header = {
    territory: TERRITORY_CODE,
    backupId: options.backupId ?? null,
    capturedAt: new Date().toISOString(),
    sourceDatabase: options.sourceMongoDb,
    includesS3Checksums: Boolean(sourceS3),
    transformationContract,
    excludedDomains: [
      'series',
      'series_values',
      'integrations_journalieres',
      'dossiers',
      'dossier_attachments',
      'declarations',
      'chunks',
      'chunk_values',
      'compteurs',
      'auth_tokens',
      'session_tokens'
    ]
  }
  const content = manifestLines(header, records)
  const digest = await writeManifestAndChecksum(options.manifest, content)

  console.log(`[reunion:snapshot] manifeste=${options.manifest} sha256=${digest}`)
  console.log(`[reunion:snapshot] lignes=${records.length} version=${MANIFEST_VERSION}`)
  return {manifestSha256: digest, counts: Object.fromEntries(
    Object.entries(snapshot).map(([key, value]) => [key, value.length])
  )}
}

async function loadInputs(options) {
  if (!options.manifest) {
    throw new Error('--manifest est requis')
  }

  const [manifest, usageMapContent, pointOverridesContent, documentExclusionsContent] = await Promise.all([
    verifyManifestChecksum(options.manifest),
    readFile(options.usageMap),
    readFile(options.pointOverrides),
    readFile(options.documentExclusions)
  ])
  const parsed = readManifestContent(manifest.content)

  if (parsed.header.territory !== TERRITORY_CODE) {
    throw new Error(`Territoire inattendu dans le manifeste: ${parsed.header.territory}`)
  }

  assertTransformationContract(parsed.header.transformationContract, {
    usageMap: usageMapContent,
    pointOverrides: pointOverridesContent,
    documentExclusions: documentExclusionsContent
  })

  return {
    manifestSha256: manifest.sha256,
    header: parsed.header,
    groups: groupManifestRecords(parsed.records),
    usageMap: parseUsageMap(usageMapContent.toString('utf8')),
    pointOverrides: parsePointOverrides(pointOverridesContent.toString('utf8')),
    documentExclusions: parseDocumentExclusions(documentExclusionsContent.toString('utf8'))
  }
}

function createCounters() {
  return {created: 0, updated: 0, unchanged: 0, skipped: 0}
}

function increment(counters, result) {
  counters[result] += 1
}

const VERIFICATION_BATCH_SIZE = 500
const VERIFICATION_DETAIL_LIMIT = 100

function splitIntoBatches(items, size = VERIFICATION_BATCH_SIZE) {
  const batches = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }

  return batches
}

function dateOnlyKey(value) {
  const date = toDate(value)
  return date ? date.toISOString().slice(0, 10) : null
}

function dateTimeKey(value) {
  const date = toDate(value)
  return date ? date.toISOString() : null
}

function normalizedEmailOrNull(value) {
  return normalizeEmail(value) ?? null
}

function selectDataFields(data, fieldNames) {
  return Object.fromEntries(fieldNames.map(fieldName => [fieldName, data[fieldName]]))
}

function prefixDataFields(prefix, data) {
  return Object.fromEntries(
    Object.entries(data).map(([fieldName, value]) => [`${prefix}.${fieldName}`, value])
  )
}

export function semanticMismatchedFields(expected, actual) {
  return Object.keys(expected).filter(fieldName => !compareData(
    {[fieldName]: actual[fieldName]},
    {[fieldName]: expected[fieldName]}
  ))
}

function semanticFailure(entity, sourceId, code, fields = []) {
  return {
    entity,
    sourceId,
    code,
    ...(fields.length > 0 ? {fields: [...fields].sort()} : {})
  }
}

export function summarizeSemanticFailures(failures, detailLimit = VERIFICATION_DETAIL_LIMIT) {
  const byEntity = {}
  const byCode = {}
  for (const failure of failures) {
    byEntity[failure.entity] = (byEntity[failure.entity] ?? 0) + 1
    byCode[failure.code] = (byCode[failure.code] ?? 0) + 1
  }

  return {
    ok: failures.length === 0,
    total: failures.length,
    byEntity,
    byCode,
    details: failures.slice(0, detailLimit),
    detailsTruncated: Math.max(0, failures.length - detailLimit)
  }
}

export function assertVerificationOptions(options) {
  if (options.skipS3) {
    throw new Error('--skip-s3 est interdit avec verify: le contenu S3 cible doit être contrôlé')
  }
}

export async function verifyTargetDocumentContent(context, key, expectedSha256, expectedSize) {
  const actual = await hashS3Object(context, key)
  return !actual.missing
    && actual.sha256 === expectedSha256
    && (expectedSize === undefined
      || expectedSize === null
      || Number(actual.size) === Number(expectedSize))
}

async function findManyBySourceIds(delegate, sourceIds, select) {
  const result = []
  for (const batch of splitIntoBatches(sourceIds)) {
    result.push(...await delegate.findMany({
      where: {sourceId: {in: batch}},
      select
    }))
  }

  return result
}

async function loadPointCoordinatesBySourceId(prisma, sourceIds) {
  const result = new Map()
  for (const batch of splitIntoBatches(sourceIds)) {
    const placeholders = batch.map((_, index) => `$${index + 1}`).join(', ')
    const rows = await prisma.$queryRawUnsafe(
      `SELECT "sourceId", ST_X(coordinates) AS longitude, ST_Y(coordinates) AS latitude
       FROM "PointPrelevement"
       WHERE "sourceId" IN (${placeholders})`,
      ...batch
    )
    for (const row of rows) {
      result.set(row.sourceId, [
        row.longitude === null ? null : Number(row.longitude),
        row.latitude === null ? null : Number(row.latitude)
      ])
    }
  }

  return result
}

function indexBySourceId(items) {
  return new Map(items.map(item => [item.sourceId, item]))
}

// eslint-disable-next-line max-params
function appendSemanticComparison(failures, entity, sourceId, expected, actual) {
  if (!actual) {
    failures.push(semanticFailure(entity, sourceId, 'MISSING_TARGET_ENTITY'))
    return
  }

  const fields = semanticMismatchedFields(expected, actual)
  if (fields.length > 0) {
    failures.push(semanticFailure(entity, sourceId, 'SEMANTIC_MISMATCH', fields))
  }
}

// Agrège les collisions cible afin que l'opérateur corrige tout avant une écriture.
// eslint-disable-next-line complexity
async function targetPreflight(prisma, inputs) {
  const issues = []
  const warnings = []
  const points = inputs.groups.get('point') ?? []
  const exploitations = inputs.groups.get('exploitation') ?? []
  const agents = inputs.groups.get('agent') ?? []

  const zone = await prisma.zone.findUnique({
    where: {type_code: {type: 'REGION', code: 'reg-04'}},
    select: {id: true, code: true}
  })
  if (!zone) {
    issues.push({code: 'TARGET_ZONE_MISSING', entity: 'zone', legacyId: 'reg-04'})
  }

  const expectedUsageCodes = new Set()
  for (const exploitation of exploitations) {
    const mapping = inputs.usageMap.get(String(exploitation.id_exploitation))
    if (mapping) {
      expectedUsageCodes.add(mapping.primary)
      for (const code of mapping.secondary) {
        expectedUsageCodes.add(code)
      }
    }
  }

  const targetUsages = await prisma.sandreWaterUse.findMany({
    where: {code: {in: [...expectedUsageCodes]}},
    select: {code: true, kind: true}
  })
  const validRootCodes = new Set(targetUsages.filter(item => item.kind === 'USAGE').map(item => item.code))
  for (const code of expectedUsageCodes) {
    if (!validRootCodes.has(code)) {
      issues.push({code: 'TARGET_ROOT_USAGE_MISSING', entity: 'usage', legacyId: code})
    }
  }

  const sourceIds = points.map(point => stableSourceId('point', point.id_point))
  const names = points.map(point => point.nom)
  const targetPoints = await prisma.pointPrelevement.findMany({
    where: {OR: [{sourceId: {in: sourceIds}}, {name: {in: names}}]},
    select: {sourceId: true, name: true}
  })
  const sourceIdByName = new Map(points.map(point => [point.nom, stableSourceId('point', point.id_point)]))
  for (const targetPoint of targetPoints) {
    if (sourceIdByName.get(targetPoint.name) !== targetPoint.sourceId) {
      issues.push({code: 'TARGET_POINT_NAME_COLLISION', entity: 'point', legacyId: targetPoint.sourceId ?? 'existing'})
    }
  }

  const agentEmails = new Map()
  for (const agent of agents) {
    const email = normalizeEmail(agent.email)
    if (email) {
      agentEmails.set(email, stableSourceId('agent', legacyId(agent._id)))
    }
  }

  const sourceAgentEmails = [...agentEmails.keys()]
  const targetUsers = await prisma.user.findMany({
    where: {OR: [
      {email: {in: sourceAgentEmails}},
      {emailAliases: {some: {email: {in: sourceAgentEmails}}}}
    ]},
    select: {
      id: true,
      email: true,
      role: true,
      emailAliases: {select: {email: true}},
      instructor: {select: {sourceId: true}}
    }
  })
  for (const user of targetUsers) {
    const matchedSourceIds = new Set(
      [user.email, ...user.emailAliases.map(alias => alias.email)]
        .map(normalizeEmail)
        .map(email => agentEmails.get(email))
        .filter(Boolean)
    )
    if (matchedSourceIds.size > 1) {
      issues.push({code: 'TARGET_AGENT_ACCOUNT_MULTI_MATCH', entity: 'agent', legacyId: user.id})
      continue
    }

    const [expectedSourceId] = matchedSourceIds
    if (user.role !== 'ADMIN' && user.instructor?.sourceId !== expectedSourceId) {
      issues.push({code: 'TARGET_AGENT_EMAIL_COLLISION', entity: 'agent', legacyId: expectedSourceId})
    } else if (
      user.role === 'ADMIN'
      && user.instructor?.sourceId
      && user.instructor.sourceId !== expectedSourceId
    ) {
      issues.push({
        code: 'TARGET_GLOBAL_ADMIN_SOURCE_COLLISION',
        entity: 'agent',
        legacyId: expectedSourceId
      })
    } else if (user.role === 'ADMIN') {
      warnings.push({code: 'GLOBAL_ADMIN_PRESERVED', entity: 'agent', legacyId: expectedSourceId})
    }
  }

  return {zone, issues, warnings}
}

async function runPreflight(options, inputs, targetContext, targetIdentity) {
  const excludedDocumentIds = new Set(inputs.documentExclusions.keys())
  const base = buildPreflight({
    groups: inputs.groups,
    usageMap: inputs.usageMap,
    pointOverrides: inputs.pointOverrides,
    excludedDocumentIds
  })
  const target = targetContext
    ? await targetPreflight(targetContext.prisma, inputs)
    : {issues: [], warnings: []}

  const result = {
    ok: base.ok && target.issues.length === 0,
    manifestSha256: inputs.manifestSha256,
    counts: base.counts,
    targetIdentity,
    issues: [...base.issues, ...target.issues],
    warnings: [...base.warnings, ...target.warnings]
  }

  console.log(`[reunion:preflight] ok=${result.ok} issues=${result.issues.length} warnings=${result.warnings.length}`)
  for (const issue of result.issues) {
    console.error(`[reunion:preflight] ${issue.code} ${issue.entity}:${issue.legacyId}`)
  }

  return result
}

function declarantData(item) {
  return {
    sourceId: stableSourceId('declarant', item.id_preleveur),
    declarantType: item.raison_sociale ? 'LEGAL_PERSON' : 'NATURAL_PERSON',
    declarantRole: 'PRELEVEUR',
    preleveurType: 'AUTRE',
    socialReason: item.raison_sociale || item.sigle || null,
    civility: item.civilite === 'M.' ? 'MR' : (item.civilite === 'Mme' ? 'MRS' : null),
    addressLine1: item.adresse_1 || null,
    addressLine2: item.adresse_2 || null,
    poBox: item.bp || null,
    postalCode: item.code_postal || null,
    city: item.commune || null,
    siret: item.siret || null,
    phoneNumber: item.numero_telephone || null,
    quickDeclarationEnabled: true,
    declarationNotificationsEnabled: false
  }
}

async function syncDeclarantContacts(transaction, userId, declarantLegacyId, emails) {
  const current = await transaction.declarantContactEmail.findMany({
    where: {declarantUserId: userId},
    select: {id: true, email: true, isPrimary: true, sourceId: true}
  })
  const plan = buildDeclarantContactPlan({declarantLegacyId, emails, current})
  if (plan.unchanged) {
    return 'unchanged'
  }

  if (plan.expected.length > 0) {
    await transaction.declarantContactEmail.updateMany({
      where: {declarantUserId: userId, isPrimary: true},
      data: {isPrimary: false}
    })
  }

  if (plan.staleIds.length > 0) {
    await transaction.declarantContactEmail.deleteMany({where: {id: {in: plan.staleIds}}})
  }

  for (const item of plan.expected) {
    await transaction.declarantContactEmail.upsert({
      where: {declarantUserId_email: {declarantUserId: userId, email: item.email}},
      update: {isPrimary: item.isPrimary, sourceId: item.sourceId},
      create: {declarantUserId: userId, ...item}
    })
  }

  return 'updated'
}

async function importDeclarants(prisma, inputs, maps, report) {
  const items = inputs.groups.get('declarant') ?? []
  const agents = inputs.groups.get('agent') ?? []
  const sourceEmailOwners = new Map()
  for (const item of items) {
    for (const email of getDeclarantEmails(item)) {
      if (!sourceEmailOwners.has(email)) {
        sourceEmailOwners.set(email, new Set())
      }

      sourceEmailOwners.get(email).add(legacyId(item._id))
    }
  }

  const agentEmails = new Set(agents.map(item => normalizeEmail(item.email)).filter(Boolean))
  const targetUsers = await prisma.user.findMany({
    where: {OR: [{email: {not: null}}, {emailAliases: {some: {}}}]},
    select: {id: true, email: true, emailAliases: {select: {email: true}}}
  })
  const targetEmailOwners = new Map()
  for (const user of targetUsers) {
    for (const email of [user.email, ...user.emailAliases.map(alias => alias.email)].map(normalizeEmail).filter(Boolean)) {
      if (!targetEmailOwners.has(email)) {
        targetEmailOwners.set(email, new Set())
      }

      targetEmailOwners.get(email).add(user.id)
    }
  }

  for (const item of items) {
    const sourceId = stableSourceId('declarant', item.id_preleveur)
    const outcome = await prisma.$transaction(async transaction => {
      const existing = await transaction.declarant.findUnique({
        where: {sourceId},
        include: {user: true}
      })
      const loginEmail = chooseDeclarantLoginEmail({
        declarant: item,
        sourceEmailOwners,
        agentEmails,
        targetEmailOwners,
        existingUserId: existing?.userId
      })
      const expectedUser = {
        email: loginEmail,
        role: 'DECLARANT',
        firstName: item.prenom || null,
        lastName: item.nom || null
      }
      const expectedDeclarant = declarantData(item)
      let userId
      let changed = false
      let created = false

      if (existing) {
        userId = existing.userId
        if (!compareData(existing.user, expectedUser)) {
          await transaction.user.update({where: {id: userId}, data: expectedUser})
          changed = true
        }

        if (!compareData(existing, expectedDeclarant)) {
          await transaction.declarant.update({where: {userId}, data: expectedDeclarant})
          changed = true
        }
      } else {
        const user = await transaction.user.create({
          data: {
            ...expectedUser,
            declarant: {create: expectedDeclarant}
          }
        })
        userId = user.id
        created = true
      }

      const contacts = await syncDeclarantContacts(
        transaction,
        userId,
        item.id_preleveur,
        getDeclarantEmails(item)
      )
      changed ||= contacts === 'updated'
      maps.declarants.set(legacyId(item._id), userId)
      return created ? 'created' : (changed ? 'updated' : 'unchanged')
    })
    increment(report.declarants, outcome)
  }
}

function pointData(item, override) {
  return {
    sourceId: stableSourceId('point', item.id_point),
    name: item.nom,
    waterBodyType: getWaterBodyType(item, override),
    flowType: 'PRELEVEMENT',
    pointKind: 'PHYSIQUE',
    otherNames: item.autresNoms || null,
    depth: item.profondeur ?? null,
    isZre: item.zre ?? null,
    isBiologicalReservoir: item.reservoir_biologique ?? null,
    streamName: item.cours_eau || null,
    locationDescription: item.detail_localisation || null,
    geometryPrecision: item.precision_geom || null,
    comment: item.remarque || null,
    internalComment: item.remarque_interne || null,
    communeName: legacyNestedString(item.commune, 'nom'),
    communeCode: legacyNestedString(item.commune, 'code'),
    codeAIOT: item.code_aiot || null,
    codeBSS: legacyNestedString(item.bss, 'id_bss'),
    codeBNPE: legacyNestedString(item.bnpe, 'point'),
    codeMESO: legacyNestedString(item.meso, 'code'),
    codeMEContinentalesBV: legacyNestedString(item.meContinentalesBv, 'code'),
    codeBDCarthage: legacyNestedString(item.bvBdCarthage, 'code')
  }
}

async function syncPointCoordinates(transaction, pointId, coordinates) {
  const [current] = await transaction.$queryRawUnsafe(
    'SELECT ST_X(coordinates) AS longitude, ST_Y(coordinates) AS latitude FROM "PointPrelevement" WHERE id = $1',
    pointId
  )
  const [longitude, latitude] = coordinates.map(Number)
  if (Number(current?.longitude) === longitude && Number(current?.latitude) === latitude) {
    return false
  }

  await transaction.$executeRawUnsafe(
    'UPDATE "PointPrelevement" SET coordinates = ST_SetSRID(ST_MakePoint($2, $3), 4326), "updatedAt" = now() WHERE id = $1',
    pointId,
    longitude,
    latitude
  )
  return true
}

async function importPoints({prisma, inputs, maps, report, zone}) {
  for (const item of inputs.groups.get('point') ?? []) {
    const override = inputs.pointOverrides.get(String(item.id_point))
    if (override?.forcedZoneCode && override.forcedZoneCode !== zone.code) {
      throw new Error(
        `Zone forcée non prise en charge pour le point ${item.id_point}: ${override.forcedZoneCode}`
      )
    }

    const expected = pointData(item, override)
    const outcome = await prisma.$transaction(async transaction => {
      const existing = await transaction.pointPrelevement.findUnique({where: {sourceId: expected.sourceId}})
      let point
      let changed = false
      let created = false
      if (existing) {
        point = existing
        if (!compareData(existing, expected)) {
          point = await transaction.pointPrelevement.update({where: {id: existing.id}, data: expected})
          changed = true
        }
      } else {
        point = await transaction.pointPrelevement.create({data: expected})
        created = true
      }

      changed ||= await syncPointCoordinates(transaction, point.id, item.geom.coordinates)
      const zoneLink = await transaction.pointPrelevementZone.findUnique({
        where: {pointPrelevementId_zoneId: {pointPrelevementId: point.id, zoneId: zone.id}}
      })
      if (!zoneLink) {
        await transaction.pointPrelevementZone.create({
          data: {pointPrelevementId: point.id, zoneId: zone.id}
        })
        changed = true
      }

      maps.points.set(legacyId(item._id), point.id)
      return created ? 'created' : (changed ? 'updated' : 'unchanged')
    })
    increment(report.points, outcome)
  }
}

function exploitationData(item, usageId, declarantUserId, pointPrelevementId) {
  return {
    sourceId: stableSourceId('exploitation', item.id_exploitation),
    declarantUserId,
    pointPrelevementId,
    status: getExploitationStatus(item.statut),
    startDate: toDate(item.date_debut),
    endDate: toDate(item.date_fin),
    usageId,
    abandonReason: item.raison_abandon || null,
    comment: item.remarque || null
  }
}

async function syncSecondaryUsages(transaction, exploitationId, expectedUsageIds) {
  const current = await transaction.declarantPointPrelevementSecondaryUsage.findMany({
    where: {exploitationId},
    select: {usageId: true}
  })
  const left = current.map(item => item.usageId).sort()
  const right = [...expectedUsageIds].sort()
  if (JSON.stringify(left) === JSON.stringify(right)) {
    return false
  }

  await transaction.declarantPointPrelevementSecondaryUsage.deleteMany({where: {exploitationId}})
  if (right.length > 0) {
    await transaction.declarantPointPrelevementSecondaryUsage.createMany({
      data: right.map(usageId => ({exploitationId, usageId}))
    })
  }

  return true
}

async function importExploitations({prisma, inputs, maps, report, zone, usagesByCode}) {
  for (const item of inputs.groups.get('exploitation') ?? []) {
    const mapping = inputs.usageMap.get(String(item.id_exploitation))
    const declarantUserId = maps.declarants.get(legacyId(item.preleveur))
    const pointPrelevementId = maps.points.get(legacyId(item.point))
    const expected = exploitationData(item, usagesByCode.get(mapping.primary), declarantUserId, pointPrelevementId)
    const secondaryUsageIds = mapping.secondary.map(code => usagesByCode.get(code))

    const outcome = await prisma.$transaction(async transaction => {
      const existing = await transaction.declarantPointPrelevement.findUnique({where: {sourceId: expected.sourceId}})
      let exploitation
      let changed = false
      let created = false
      if (existing) {
        exploitation = existing
        if (!compareData(existing, expected)) {
          exploitation = await transaction.declarantPointPrelevement.update({where: {id: existing.id}, data: expected})
          changed = true
        }
      } else {
        exploitation = await transaction.declarantPointPrelevement.create({data: expected})
        created = true
      }

      changed ||= await syncSecondaryUsages(transaction, exploitation.id, secondaryUsageIds)
      const declarantZone = await transaction.declarantZone.findUnique({
        where: {declarantUserId_zoneId: {declarantUserId, zoneId: zone.id}}
      })
      if (!declarantZone) {
        await transaction.declarantZone.create({
          data: {declarantUserId, zoneId: zone.id, source: 'MIGRATION'}
        })
        changed = true
      }

      maps.exploitations.set(legacyId(item._id), exploitation.id)
      return created ? 'created' : (changed ? 'updated' : 'unchanged')
    })
    increment(report.exploitations, outcome)
  }
}

async function syncInstructorZone({transaction, instructorUserId, zoneId, role, startDate}) {
  const permissions = role === 'editor' ? ZONE_PERMISSION_CODES : READ_ONLY_ZONE_PERMISSIONS
  const isAdmin = role === 'editor'
  let instructorZone = await transaction.instructorZone.findUnique({
    where: {instructorUserId_zoneId: {instructorUserId, zoneId}},
    include: {permissions: {select: {permission: true}}}
  })
  const currentPermissions = instructorZone?.permissions.map(item => item.permission).sort() ?? []
  const expectedPermissions = [...permissions].sort()
  const metadataChanged = instructorZone && (
    instructorZone.isAdmin !== isAdmin
    || new Date(instructorZone.startDate).toISOString() !== startDate.toISOString()
    || instructorZone.endDate !== null
  )
  const permissionsChanged = JSON.stringify(currentPermissions) !== JSON.stringify(expectedPermissions)

  if (instructorZone && !metadataChanged && !permissionsChanged) {
    return false
  }

  const before = instructorZone
    ? {isAdmin: instructorZone.isAdmin, permissions: currentPermissions}
    : null
  if (!instructorZone) {
    instructorZone = await transaction.instructorZone.create({
      data: {instructorUserId, zoneId, isAdmin, startDate}
    })
  } else if (metadataChanged) {
    instructorZone = await transaction.instructorZone.update({
      where: {id: instructorZone.id},
      data: {isAdmin, startDate, endDate: null}
    })
  }

  if (permissionsChanged) {
    await transaction.instructorZonePermission.deleteMany({where: {instructorZoneId: instructorZone.id}})
    await transaction.instructorZonePermission.createMany({
      data: permissions.map(permission => ({instructorZoneId: instructorZone.id, permission}))
    })
  }

  await transaction.instructorZonePermissionAudit.create({
    data: {
      instructorZoneId: instructorZone.id,
      zoneId,
      instructorUserId,
      action: 'MIGRATED',
      before,
      after: {isAdmin, permissions: expectedPermissions}
    }
  })
  return true
}

async function importAgents({prisma, inputs, maps, report, zone}) {
  for (const item of inputs.groups.get('agent') ?? []) {
    const mongoId = legacyId(item._id)
    const sourceId = stableSourceId('agent', mongoId)
    const email = normalizeEmail(item.email)
    const sourceRole = (item.roles ?? []).find(role => role.territoire === TERRITORY_CODE)?.role
    // La branche ADMIN préserve le rôle global; la branche INSTRUCTOR synchronise la zone.
    // eslint-disable-next-line complexity
    const outcome = await prisma.$transaction(async transaction => {
      const bySource = await transaction.instructor.findUnique({
        where: {sourceId},
        include: {user: true}
      })
      const byEmail = email
        ? await transaction.user.findFirst({
          where: {OR: [{email}, {emailAliases: {some: {email}}}]},
          include: {instructor: true}
        })
        : null
      const existingUser = bySource?.user ?? byEmail
      let user
      let created = false
      let changed = false

      if (existingUser?.role === 'ADMIN') {
        const existingInstructor = bySource ?? byEmail?.instructor
        if (existingInstructor?.sourceId && existingInstructor.sourceId !== sourceId) {
          throw new Error(`Collision de sourceId pour un administrateur global (${sourceId})`)
        }

        const expectedInstructor = {
          sourceId,
          jobTitle: item.fonction || item.structure || null,
          phoneNumber: item.telephone || null
        }
        if (!existingInstructor) {
          await transaction.instructor.create({
            data: {userId: existingUser.id, ...expectedInstructor}
          })
          changed = true
        } else if (!compareData(existingInstructor, expectedInstructor)) {
          await transaction.instructor.update({where: {userId: existingUser.id}, data: expectedInstructor})
          changed = true
        }

        maps.agents.set(mongoId, existingUser.id)
        return changed ? 'updated' : 'unchanged'
      }

      const expectedUser = {
        email,
        role: 'INSTRUCTOR',
        firstName: item.prenom || null,
        lastName: item.nom || null
      }
      const expectedInstructor = {
        sourceId,
        jobTitle: item.fonction || item.structure || null,
        phoneNumber: item.telephone || null
      }
      if (bySource) {
        user = bySource.user
        if (!compareData(user, expectedUser)) {
          await transaction.user.update({where: {id: user.id}, data: expectedUser})
          changed = true
        }

        if (!compareData(bySource, expectedInstructor)) {
          await transaction.instructor.update({where: {userId: user.id}, data: expectedInstructor})
          changed = true
        }
      } else if (byEmail) {
        throw new Error(`Collision email agent non administrateur (${sourceId})`)
      } else {
        user = await transaction.user.create({
          data: {
            ...expectedUser,
            instructor: {create: expectedInstructor}
          }
        })
        created = true
      }

      changed ||= await syncInstructorZone({
        transaction,
        instructorUserId: user.id,
        zoneId: zone.id,
        role: sourceRole,
        startDate: toDateOnly(item.createdAt) ?? new Date('1970-01-01T00:00:00.000Z')
      })
      maps.agents.set(mongoId, user.id)
      return created ? 'created' : (changed ? 'updated' : 'unchanged')
    })
    increment(report.agents, outcome)
  }
}

function documentData(plan, ownerUserId, storageKey, firstExploitationId) {
  const item = plan.document
  return {
    sourceId: stableSourceId('document', plan.documentId, plan.ownerId),
    contentSha256: item.s3.sha256,
    declarantUserId: ownerUserId,
    declarantPointPrelevementId: firstExploitationId ?? null,
    title: item.reference || item.nature || safeFilename(item.nom_fichier),
    reference: item.reference || null,
    nature: item.nature || null,
    comment: item.remarque || null,
    signatureDate: toDate(item.date_signature),
    validityEndDate: toDate(item.date_fin_validite),
    filename: safeFilename(item.nom_fichier),
    mimeType: item.s3.mimeType || null,
    size: item.s3.size ?? item.taille ?? null,
    storageKey,
    deletedAt: toDate(item.deletedAt)
  }
}

async function syncDocumentLinks(transaction, documentId, exploitationIds) {
  const current = await transaction.resourceDocumentExploitation.findMany({
    where: {resourceDocumentId: documentId},
    select: {declarantPointPrelevementId: true}
  })
  const left = current.map(item => item.declarantPointPrelevementId).sort()
  const right = [...exploitationIds].sort()
  if (JSON.stringify(left) === JSON.stringify(right)) {
    return false
  }

  await transaction.resourceDocumentExploitation.deleteMany({where: {resourceDocumentId: documentId}})
  if (right.length > 0) {
    await transaction.resourceDocumentExploitation.createMany({
      data: right.map(declarantPointPrelevementId => ({resourceDocumentId: documentId, declarantPointPrelevementId}))
    })
  }

  return true
}

async function importDocuments({prisma, inputs, maps, report, s3}) {
  const plans = partitionDocuments({
    documents: inputs.groups.get('document') ?? [],
    exploitations: inputs.groups.get('exploitation') ?? [],
    rules: inputs.groups.get('rule') ?? [],
    excludedDocumentIds: new Set(inputs.documentExclusions.keys())
  })

  let processed = 0
  for (const plan of plans) {
    const ownerUserId = maps.declarants.get(plan.ownerId)
    const exploitationIds = plan.exploitationIds.map(id => maps.exploitations.get(id)).filter(Boolean)
    const storageKey = deterministicStorageKey({
      ownerLegacyId: plan.ownerId,
      documentLegacyId: plan.documentId,
      filename: plan.document.nom_fichier
    })
    const s3Outcome = await copyS3Object({
      source: s3.source,
      target: s3.target,
      sourceKey: plan.document.objectKey,
      targetKey: storageKey,
      expectedSha256: plan.document.s3.sha256,
      expectedETag: plan.document.s3.eTag,
      expectedSize: plan.document.s3.size,
      filename: plan.document.nom_fichier,
      mimeType: plan.document.s3.mimeType
    })
    increment(report.s3, s3Outcome)

    const expected = documentData(plan, ownerUserId, storageKey, exploitationIds[0])
    const outcome = await prisma.$transaction(async transaction => {
      const existing = await transaction.resourceDocument.findUnique({where: {sourceId: expected.sourceId}})
      let document
      let changed = false
      let created = false
      if (existing) {
        document = existing
        if (!compareData(existing, expected)) {
          document = await transaction.resourceDocument.update({where: {id: existing.id}, data: expected})
          changed = true
        }
      } else {
        document = await transaction.resourceDocument.create({data: expected})
        created = true
      }

      changed ||= await syncDocumentLinks(transaction, document.id, exploitationIds)
      maps.documents.set(`${plan.documentId}:${plan.ownerId}`, document.id)
      return created ? 'created' : (changed ? 'updated' : 'unchanged')
    })
    increment(report.documents, outcome)
    processed += 1
    if (processed % 100 === 0 || processed === plans.length) {
      console.log(`[reunion:apply] documents=${processed}/${plans.length}`)
    }
  }
}

function ruleData(plan, ownerUserId, documentId) {
  const item = plan.rule
  return {
    sourceId: stableSourceId('rule', plan.ruleId, plan.ownerId),
    declarantUserId: ownerUserId,
    documentId,
    parameter: item.parametre,
    frequency: item.frequence || null,
    unit: item.unite,
    value: Number(item.valeur),
    constraint: String(item.contrainte).toLowerCase() === 'min' ? 'MIN' : 'MAX',
    validityStartDate: toDate(item.debut_validite),
    validityEndDate: toDate(item.fin_validite),
    annualPeriodStartDate: toDate(item.debut_periode),
    annualPeriodEndDate: toDate(item.fin_periode),
    comment: item.remarque || null,
    deletedAt: null
  }
}

async function syncRuleLinks(transaction, resourceRuleId, exploitationIds) {
  const current = await transaction.resourceRuleExploitation.findMany({
    where: {resourceRuleId},
    select: {declarantPointPrelevementId: true}
  })
  const left = current.map(item => item.declarantPointPrelevementId).sort()
  const right = [...exploitationIds].sort()
  if (JSON.stringify(left) === JSON.stringify(right)) {
    return false
  }

  await transaction.resourceRuleExploitation.deleteMany({where: {resourceRuleId}})
  await transaction.resourceRuleExploitation.createMany({
    data: right.map(declarantPointPrelevementId => ({resourceRuleId, declarantPointPrelevementId}))
  })
  return true
}

async function importRules(prisma, inputs, maps, report) {
  const plans = partitionRules({
    rules: inputs.groups.get('rule') ?? [],
    exploitations: inputs.groups.get('exploitation') ?? [],
    excludedDocumentIds: new Set(inputs.documentExclusions.keys())
  })
  let processed = 0
  for (const plan of plans) {
    const exploitationIds = plan.exploitationIds.map(id => maps.exploitations.get(id)).filter(Boolean)
    const documentId = plan.documentId
      ? maps.documents.get(`${plan.documentId}:${plan.ownerId}`) ?? null
      : null
    const expected = ruleData(plan, maps.declarants.get(plan.ownerId), documentId)
    const outcome = await prisma.$transaction(async transaction => {
      const existing = await transaction.resourceRule.findUnique({where: {sourceId: expected.sourceId}})
      let rule
      let changed = false
      let created = false
      if (existing) {
        rule = existing
        if (!compareData(existing, expected)) {
          rule = await transaction.resourceRule.update({where: {id: existing.id}, data: expected})
          changed = true
        }
      } else {
        rule = await transaction.resourceRule.create({data: expected})
        created = true
      }

      changed ||= await syncRuleLinks(transaction, rule.id, exploitationIds)
      return created ? 'created' : (changed ? 'updated' : 'unchanged')
    })
    increment(report.rules, outcome)
    processed += 1
    if (processed % 500 === 0 || processed === plans.length) {
      console.log(`[reunion:apply] règles=${processed}/${plans.length}`)
    }
  }
}

async function applyMigration({options, inputs, targetContext, targetEnvironment, preflight}) {
  if (!options.apply) {
    console.log('[reunion:apply] dry-run: aucune écriture; ajouter --apply et --confirm-target')
    return {
      dryRun: true,
      planned: preflight.counts
    }
  }

  if (options.skipS3) {
    throw new Error('--skip-s3 est incompatible avec --apply')
  }

  if (!preflight.ok) {
    throw new Error(`Application refusée: ${preflight.issues.length} erreur(s) de préflight`)
  }

  if (!options.sourceS3Env) {
    throw new Error('--source-s3-env est requis pour appliquer les documents')
  }

  const sourceS3 = createS3Context(await loadEnv(options.sourceS3Env), 'S3 source')
  const targetS3 = createS3Context(targetEnvironment, 'S3 cible')
  const {prisma} = targetContext
  assertDistinctS3Locations(sourceS3, targetS3)
  await assertVersionedS3Bucket(
    targetS3,
    'S3 cible',
    options.target === 'testing' ? 'fr-par' : undefined
  )
  await attestTargetDatabase(prisma, options.target)
  const zone = await prisma.zone.findUniqueOrThrow({
    where: {type_code: {type: 'REGION', code: 'reg-04'}},
    select: {id: true, code: true}
  })
  const mappings = [...inputs.usageMap.values()]
  const usageCodes = [...new Set(mappings.flatMap(item => [item.primary, ...item.secondary]))]
  const usages = await prisma.sandreWaterUse.findMany({
    where: {code: {in: usageCodes}, kind: 'USAGE'},
    select: {id: true, code: true}
  })
  const usagesByCode = new Map(usages.map(item => [item.code, item.id]))
  const maps = {
    declarants: new Map(),
    points: new Map(),
    exploitations: new Map(),
    agents: new Map(),
    documents: new Map()
  }
  const report = {
    dryRun: false,
    target: options.target,
    manifestSha256: inputs.manifestSha256,
    declarants: createCounters(),
    points: createCounters(),
    exploitations: createCounters(),
    agents: createCounters(),
    documents: createCounters(),
    rules: createCounters(),
    s3: createCounters()
  }

  try {
    await importDeclarants(prisma, inputs, maps, report)
    console.log(`[reunion:apply] déclarants=${maps.declarants.size}`)
    await importPoints({prisma, inputs, maps, report, zone})
    console.log(`[reunion:apply] points=${maps.points.size}`)
    await importExploitations({prisma, inputs, maps, report, zone, usagesByCode})
    console.log(`[reunion:apply] exploitations=${maps.exploitations.size}`)
    await importAgents({prisma, inputs, maps, report, zone})
    console.log(`[reunion:apply] agents=${maps.agents.size}`)
    await importDocuments({
      prisma,
      inputs,
      maps,
      report,
      s3: {source: sourceS3, target: targetS3}
    })
    await importRules(prisma, inputs, maps, report)
  } finally {
    sourceS3.client.destroy()
    targetS3.client.destroy()
  }

  console.log('[reunion:apply] application terminée')
  return report
}

function buildSemanticReferences(inputs, documentPlans) {
  const declarants = inputs.groups.get('declarant') ?? []
  const points = inputs.groups.get('point') ?? []
  const exploitations = inputs.groups.get('exploitation') ?? []
  const agents = inputs.groups.get('agent') ?? []
  const declarantSourceIdByLegacyId = new Map(declarants.map(item => [
    legacyId(item._id),
    stableSourceId('declarant', item.id_preleveur)
  ]))
  const pointSourceIdByLegacyId = new Map(points.map(item => [
    legacyId(item._id),
    stableSourceId('point', item.id_point)
  ]))
  const exploitationSourceIdByLegacyId = new Map(exploitations.map(item => [
    legacyId(item._id),
    stableSourceId('exploitation', item.id_exploitation)
  ]))
  const documentSourceIdByPlanKey = new Map(documentPlans.map(plan => [
    `${plan.documentId}:${plan.ownerId}`,
    stableSourceId('document', plan.documentId, plan.ownerId)
  ]))

  return {
    declarants,
    points,
    exploitations,
    agents,
    declarantSourceIdByLegacyId,
    pointSourceIdByLegacyId,
    exploitationSourceIdByLegacyId,
    documentSourceIdByPlanKey
  }
}

async function verifyDeclarantSemantics(prisma, inputs, references) {
  const sourceIds = references.declarants.map(item => (
    stableSourceId('declarant', item.id_preleveur)
  ))
  const rows = await findManyBySourceIds(prisma.declarant, sourceIds, {
    sourceId: true,
    userId: true,
    declarantType: true,
    declarantRole: true,
    preleveurType: true,
    socialReason: true,
    civility: true,
    addressLine1: true,
    addressLine2: true,
    poBox: true,
    postalCode: true,
    city: true,
    siret: true,
    phoneNumber: true,
    quickDeclarationEnabled: true,
    declarationNotificationsEnabled: true,
    user: {select: {email: true, role: true, firstName: true, lastName: true}},
    contactEmails: {select: {email: true, isPrimary: true, sourceId: true}},
    zones: {
      where: {zone: {type: 'REGION', code: 'reg-04'}},
      select: {id: true}
    }
  })
  const rowsBySourceId = indexBySourceId(rows)
  const targetUsers = await prisma.user.findMany({
    where: {OR: [{email: {not: null}}, {emailAliases: {some: {}}}]},
    select: {id: true, email: true, emailAliases: {select: {email: true}}}
  })
  const targetEmailOwners = new Map()
  for (const user of targetUsers) {
    const emails = [user.email, ...user.emailAliases.map(alias => alias.email)]
      .map(normalizedEmailOrNull)
      .filter(Boolean)
    for (const email of emails) {
      if (!targetEmailOwners.has(email)) {
        targetEmailOwners.set(email, new Set())
      }

      targetEmailOwners.get(email).add(user.id)
    }
  }

  const sourceEmailOwners = new Map()
  for (const item of references.declarants) {
    for (const email of getDeclarantEmails(item)) {
      if (!sourceEmailOwners.has(email)) {
        sourceEmailOwners.set(email, new Set())
      }

      sourceEmailOwners.get(email).add(legacyId(item._id))
    }
  }

  const agentEmails = new Set(
    references.agents.map(item => normalizeEmail(item.email)).filter(Boolean)
  )
  const zonedDeclarantSourceIds = new Set(references.exploitations.map(item => (
    references.declarantSourceIdByLegacyId.get(legacyId(item.preleveur))
  )).filter(Boolean))
  const failures = []

  for (const item of references.declarants) {
    const sourceId = stableSourceId('declarant', item.id_preleveur)
    const row = rowsBySourceId.get(sourceId)
    if (!row) {
      appendSemanticComparison(failures, 'declarant', sourceId, {}, null)
      continue
    }

    const profile = declarantData(item)
    const contactPlan = buildDeclarantContactPlan({
      declarantLegacyId: item.id_preleveur,
      emails: getDeclarantEmails(item),
      current: []
    })
    const expectedContacts = contactPlan.expected
      .map(contact => ({
        sourceId: contact.sourceId,
        email: contact.email,
        isPrimary: contact.isPrimary
      }))
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
    const actualContacts = row.contactEmails
      .filter(contact => contact.sourceId?.startsWith(`${MIGRATION_PREFIX}:contact:`))
      .map(contact => ({
        sourceId: contact.sourceId,
        email: normalizedEmailOrNull(contact.email),
        isPrimary: contact.isPrimary
      }))
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
    const loginEmail = chooseDeclarantLoginEmail({
      declarant: item,
      sourceEmailOwners,
      agentEmails,
      targetEmailOwners,
      existingUserId: row.userId
    })
    const expected = {
      ...prefixDataFields('declarant', profile),
      'user.email': loginEmail,
      'user.role': 'DECLARANT',
      'user.firstName': item.prenom || null,
      'user.lastName': item.nom || null,
      contacts: expectedContacts
    }
    const actual = {
      ...prefixDataFields('declarant', selectDataFields(row, Object.keys(profile))),
      'user.email': normalizedEmailOrNull(row.user.email),
      'user.role': row.user.role,
      'user.firstName': row.user.firstName,
      'user.lastName': row.user.lastName,
      contacts: actualContacts
    }
    if (expectedContacts.length > 0) {
      expected.primaryContactSourceId = expectedContacts.find(contact => contact.isPrimary).sourceId
      actual.primaryContactSourceId = row.contactEmails.find(contact => contact.isPrimary)?.sourceId ?? null
    }

    if (zonedDeclarantSourceIds.has(sourceId)) {
      expected['relations.zone.reg-04'] = true
      actual['relations.zone.reg-04'] = row.zones.length === 1
    }

    appendSemanticComparison(failures, 'declarant', sourceId, expected, actual)
  }

  return failures
}

async function verifyPointSemantics(prisma, inputs, references) {
  const sourceIds = references.points.map(item => stableSourceId('point', item.id_point))
  const rows = await findManyBySourceIds(prisma.pointPrelevement, sourceIds, {
    sourceId: true,
    name: true,
    waterBodyType: true,
    flowType: true,
    pointKind: true,
    otherNames: true,
    depth: true,
    isZre: true,
    isBiologicalReservoir: true,
    streamName: true,
    locationDescription: true,
    geometryPrecision: true,
    comment: true,
    internalComment: true,
    communeName: true,
    communeCode: true,
    codeAIOT: true,
    codeBSS: true,
    codeBNPE: true,
    codeMESO: true,
    codeMEContinentalesBV: true,
    codeBDCarthage: true,
    zones: {
      where: {zone: {type: 'REGION', code: 'reg-04'}},
      select: {id: true}
    }
  })
  const rowsBySourceId = indexBySourceId(rows)
  const coordinatesBySourceId = await loadPointCoordinatesBySourceId(prisma, sourceIds)
  const failures = []

  for (const item of references.points) {
    const sourceId = stableSourceId('point', item.id_point)
    const row = rowsBySourceId.get(sourceId)
    if (!row) {
      appendSemanticComparison(failures, 'point', sourceId, {}, null)
      continue
    }

    const point = pointData(item, inputs.pointOverrides.get(String(item.id_point)))
    const expected = {
      ...prefixDataFields('point', point),
      coordinates: item.geom.coordinates.map(Number),
      'relations.zone.reg-04': true
    }
    const actual = {
      ...prefixDataFields('point', selectDataFields(row, Object.keys(point))),
      coordinates: coordinatesBySourceId.get(sourceId) ?? null,
      'relations.zone.reg-04': row.zones.length === 1
    }
    appendSemanticComparison(failures, 'point', sourceId, expected, actual)
  }

  return failures
}

async function verifyExploitationSemantics(prisma, inputs, references) {
  const sourceIds = references.exploitations.map(item => (
    stableSourceId('exploitation', item.id_exploitation)
  ))
  const rows = await findManyBySourceIds(prisma.declarantPointPrelevement, sourceIds, {
    sourceId: true,
    status: true,
    startDate: true,
    endDate: true,
    abandonReason: true,
    comment: true,
    declarant: {select: {sourceId: true}},
    pointPrelevement: {select: {sourceId: true}},
    usage: {select: {code: true, kind: true}},
    secondaryUsageLinks: {select: {usage: {select: {code: true, kind: true}}}}
  })
  const rowsBySourceId = indexBySourceId(rows)
  const failures = []

  for (const item of references.exploitations) {
    const sourceId = stableSourceId('exploitation', item.id_exploitation)
    const row = rowsBySourceId.get(sourceId)
    if (!row) {
      appendSemanticComparison(failures, 'exploitation', sourceId, {}, null)
      continue
    }

    const mapping = inputs.usageMap.get(String(item.id_exploitation))
    const expected = {
      'exploitation.sourceId': sourceId,
      'exploitation.status': getExploitationStatus(item.statut),
      'exploitation.startDate': dateOnlyKey(item.date_debut),
      'exploitation.endDate': dateOnlyKey(item.date_fin),
      'exploitation.abandonReason': item.raison_abandon || null,
      'exploitation.comment': item.remarque || null,
      'relations.declarantSourceId': references.declarantSourceIdByLegacyId.get(
        legacyId(item.preleveur)
      ),
      'relations.pointSourceId': references.pointSourceIdByLegacyId.get(legacyId(item.point)),
      'usage.primary': {code: mapping.primary, kind: 'USAGE'},
      'usage.secondary': mapping.secondary.map(code => ({code, kind: 'USAGE'}))
        .sort((left, right) => left.code.localeCompare(right.code))
    }
    const actual = {
      'exploitation.sourceId': row.sourceId,
      'exploitation.status': row.status,
      'exploitation.startDate': dateOnlyKey(row.startDate),
      'exploitation.endDate': dateOnlyKey(row.endDate),
      'exploitation.abandonReason': row.abandonReason,
      'exploitation.comment': row.comment,
      'relations.declarantSourceId': row.declarant.sourceId,
      'relations.pointSourceId': row.pointPrelevement.sourceId,
      'usage.primary': {code: row.usage.code, kind: row.usage.kind},
      'usage.secondary': row.secondaryUsageLinks.map(link => ({
        code: link.usage.code,
        kind: link.usage.kind
      })).sort((left, right) => left.code.localeCompare(right.code))
    }
    appendSemanticComparison(failures, 'exploitation', sourceId, expected, actual)
  }

  return failures
}

async function verifyAgentSemantics(prisma, references) {
  const sourceIds = references.agents.map(item => (
    stableSourceId('agent', legacyId(item._id))
  ))
  const rows = await findManyBySourceIds(prisma.instructor, sourceIds, {
    sourceId: true,
    jobTitle: true,
    phoneNumber: true,
    user: {select: {email: true, role: true, firstName: true, lastName: true}},
    instructorZones: {
      where: {zone: {type: 'REGION', code: 'reg-04'}},
      select: {
        isAdmin: true,
        startDate: true,
        endDate: true,
        permissions: {select: {permission: true}}
      }
    }
  })
  const rowsBySourceId = indexBySourceId(rows)
  const failures = []

  for (const item of references.agents) {
    const sourceId = stableSourceId('agent', legacyId(item._id))
    const row = rowsBySourceId.get(sourceId)
    if (!row) {
      appendSemanticComparison(failures, 'agent', sourceId, {}, null)
      continue
    }

    const expected = {
      'instructor.sourceId': sourceId,
      'instructor.jobTitle': item.fonction || item.structure || null,
      'instructor.phoneNumber': item.telephone || null
    }
    const actual = {
      'instructor.sourceId': row.sourceId,
      'instructor.jobTitle': row.jobTitle,
      'instructor.phoneNumber': row.phoneNumber
    }
    if (row.user.role === 'ADMIN') {
      expected['user.role'] = 'ADMIN'
      actual['user.role'] = row.user.role
    } else {
      const sourceRole = (item.roles ?? [])
        .find(role => role.territoire === TERRITORY_CODE)?.role
      const expectedPermissions = sourceRole === 'editor'
        ? [...ZONE_PERMISSION_CODES].sort()
        : [...READ_ONLY_ZONE_PERMISSIONS].sort()
      const zone = row.instructorZones[0]
      expected['user.email'] = normalizeEmail(item.email)
      expected['user.role'] = 'INSTRUCTOR'
      expected['user.firstName'] = item.prenom || null
      expected['user.lastName'] = item.nom || null
      expected['zone.reg-04'] = {
        exists: true,
        isAdmin: sourceRole === 'editor',
        startDate: dateOnlyKey(item.createdAt) ?? '1970-01-01',
        endDate: null,
        permissions: expectedPermissions
      }
      actual['user.email'] = normalizedEmailOrNull(row.user.email)
      actual['user.role'] = row.user.role
      actual['user.firstName'] = row.user.firstName
      actual['user.lastName'] = row.user.lastName
      actual['zone.reg-04'] = zone
        ? {
          exists: true,
          isAdmin: zone.isAdmin,
          startDate: dateOnlyKey(zone.startDate),
          endDate: dateOnlyKey(zone.endDate),
          permissions: zone.permissions.map(permission => permission.permission).sort()
        }
        : {exists: false}
    }

    appendSemanticComparison(failures, 'agent', sourceId, expected, actual)
  }

  return failures
}

async function verifyDocumentSemantics(prisma, references, documentPlans) {
  const sourceIds = documentPlans.map(plan => (
    stableSourceId('document', plan.documentId, plan.ownerId)
  ))
  const rows = await findManyBySourceIds(prisma.resourceDocument, sourceIds, {
    sourceId: true,
    contentSha256: true,
    title: true,
    reference: true,
    nature: true,
    comment: true,
    signatureDate: true,
    validityEndDate: true,
    filename: true,
    mimeType: true,
    size: true,
    storageKey: true,
    deletedAt: true,
    declarant: {select: {sourceId: true}},
    declarantPointPrelevement: {select: {sourceId: true}},
    exploitations: {
      select: {declarantPointPrelevement: {select: {sourceId: true}}}
    }
  })
  const rowsBySourceId = indexBySourceId(rows)
  const failures = []

  for (const plan of documentPlans) {
    const sourceId = stableSourceId('document', plan.documentId, plan.ownerId)
    const row = rowsBySourceId.get(sourceId)
    if (!row) {
      appendSemanticComparison(failures, 'document', sourceId, {}, null)
      continue
    }

    const orderedExploitationSourceIds = plan.exploitationIds.map(id => (
      references.exploitationSourceIdByLegacyId.get(id)
    )).filter(Boolean)
    const exploitationSourceIds = [...orderedExploitationSourceIds].sort()
    const storageKey = deterministicStorageKey({
      ownerLegacyId: plan.ownerId,
      documentLegacyId: plan.documentId,
      filename: plan.document.nom_fichier
    })
    const mapped = documentData(
      plan,
      references.declarantSourceIdByLegacyId.get(plan.ownerId),
      storageKey,
      orderedExploitationSourceIds[0] ?? null
    )
    const expected = {
      'document.sourceId': mapped.sourceId,
      'document.contentSha256': mapped.contentSha256,
      'document.title': mapped.title,
      'document.reference': mapped.reference,
      'document.nature': mapped.nature,
      'document.comment': mapped.comment,
      'document.signatureDate': dateOnlyKey(mapped.signatureDate),
      'document.validityEndDate': dateOnlyKey(mapped.validityEndDate),
      'document.filename': mapped.filename,
      'document.mimeType': mapped.mimeType,
      'document.size': mapped.size,
      'document.storageKey': mapped.storageKey,
      'document.deletedAt': dateTimeKey(mapped.deletedAt),
      'relations.declarantSourceId': mapped.declarantUserId,
      'relations.primaryExploitationSourceId': mapped.declarantPointPrelevementId,
      'relations.exploitationSourceIds': exploitationSourceIds
    }
    const actual = {
      'document.sourceId': row.sourceId,
      'document.contentSha256': row.contentSha256,
      'document.title': row.title,
      'document.reference': row.reference,
      'document.nature': row.nature,
      'document.comment': row.comment,
      'document.signatureDate': dateOnlyKey(row.signatureDate),
      'document.validityEndDate': dateOnlyKey(row.validityEndDate),
      'document.filename': row.filename,
      'document.mimeType': row.mimeType,
      'document.size': row.size,
      'document.storageKey': row.storageKey,
      'document.deletedAt': dateTimeKey(row.deletedAt),
      'relations.declarantSourceId': row.declarant?.sourceId ?? null,
      'relations.primaryExploitationSourceId': row.declarantPointPrelevement?.sourceId ?? null,
      'relations.exploitationSourceIds': row.exploitations.map(link => (
        link.declarantPointPrelevement.sourceId
      )).sort()
    }
    appendSemanticComparison(failures, 'document', sourceId, expected, actual)
  }

  return failures
}

async function verifyRuleSemantics(prisma, references, rulePlans) {
  const sourceIds = rulePlans.map(plan => stableSourceId('rule', plan.ruleId, plan.ownerId))
  const rows = await findManyBySourceIds(prisma.resourceRule, sourceIds, {
    sourceId: true,
    parameter: true,
    frequency: true,
    unit: true,
    value: true,
    constraint: true,
    validityStartDate: true,
    validityEndDate: true,
    annualPeriodStartDate: true,
    annualPeriodEndDate: true,
    comment: true,
    deletedAt: true,
    declarant: {select: {sourceId: true}},
    document: {select: {sourceId: true}},
    exploitations: {
      select: {declarantPointPrelevement: {select: {sourceId: true}}}
    }
  })
  const rowsBySourceId = indexBySourceId(rows)
  const failures = []

  for (const plan of rulePlans) {
    const sourceId = stableSourceId('rule', plan.ruleId, plan.ownerId)
    const row = rowsBySourceId.get(sourceId)
    if (!row) {
      appendSemanticComparison(failures, 'rule', sourceId, {}, null)
      continue
    }

    const expectedDocumentSourceId = plan.documentId
      ? references.documentSourceIdByPlanKey.get(`${plan.documentId}:${plan.ownerId}`) ?? null
      : null
    const exploitationSourceIds = plan.exploitationIds.map(id => (
      references.exploitationSourceIdByLegacyId.get(id)
    )).filter(Boolean).sort()
    const mapped = ruleData(
      plan,
      references.declarantSourceIdByLegacyId.get(plan.ownerId),
      expectedDocumentSourceId
    )
    const expected = {
      'rule.sourceId': mapped.sourceId,
      'rule.parameter': mapped.parameter,
      'rule.frequency': mapped.frequency,
      'rule.unit': mapped.unit,
      'rule.value': mapped.value,
      'rule.constraint': mapped.constraint,
      'rule.validityStartDate': dateOnlyKey(mapped.validityStartDate),
      'rule.validityEndDate': dateOnlyKey(mapped.validityEndDate),
      'rule.annualPeriodStartDate': dateOnlyKey(mapped.annualPeriodStartDate),
      'rule.annualPeriodEndDate': dateOnlyKey(mapped.annualPeriodEndDate),
      'rule.comment': mapped.comment,
      'rule.deletedAt': dateTimeKey(mapped.deletedAt),
      'relations.declarantSourceId': mapped.declarantUserId,
      'relations.documentSourceId': mapped.documentId,
      'relations.exploitationSourceIds': exploitationSourceIds
    }
    const actual = {
      'rule.sourceId': row.sourceId,
      'rule.parameter': row.parameter,
      'rule.frequency': row.frequency,
      'rule.unit': row.unit,
      'rule.value': row.value,
      'rule.constraint': row.constraint,
      'rule.validityStartDate': dateOnlyKey(row.validityStartDate),
      'rule.validityEndDate': dateOnlyKey(row.validityEndDate),
      'rule.annualPeriodStartDate': dateOnlyKey(row.annualPeriodStartDate),
      'rule.annualPeriodEndDate': dateOnlyKey(row.annualPeriodEndDate),
      'rule.comment': row.comment,
      'rule.deletedAt': dateTimeKey(row.deletedAt),
      'relations.declarantSourceId': row.declarant.sourceId,
      'relations.documentSourceId': row.document?.sourceId ?? null,
      'relations.exploitationSourceIds': row.exploitations.map(link => (
        link.declarantPointPrelevement.sourceId
      )).sort()
    }
    appendSemanticComparison(failures, 'rule', sourceId, expected, actual)
  }

  return failures
}

export async function verifySemanticMigration(prisma, inputs, documentPlans, rulePlans) {
  const references = buildSemanticReferences(inputs, documentPlans)
  return [
    ...await verifyDeclarantSemantics(prisma, inputs, references),
    ...await verifyPointSemantics(prisma, inputs, references),
    ...await verifyExploitationSemantics(prisma, inputs, references),
    ...await verifyAgentSemantics(prisma, references),
    ...await verifyDocumentSemantics(prisma, references, documentPlans),
    ...await verifyRuleSemantics(prisma, references, rulePlans)
  ]
}

async function verifyRelationalInvariants({
  prisma,
  inputs,
  expectedSourceIds,
  documentPlans,
  rulePlans
}) {
  const declarants = inputs.groups.get('declarant') ?? []
  const exploitations = inputs.groups.get('exploitation') ?? []
  const agents = inputs.groups.get('agent') ?? []
  const contactPlans = declarants.map(item => buildDeclarantContactPlan({
    declarantLegacyId: item.id_preleveur,
    emails: getDeclarantEmails(item),
    current: []
  }))
  const contactSourceIds = contactPlans.flatMap(plan => plan.expected.map(item => item.sourceId))
  const primaryContactSourceIds = contactPlans.flatMap(plan => (
    plan.expected.filter(item => item.isPrimary).map(item => item.sourceId)
  ))
  const declarantSourceIdByLegacyId = new Map(declarants.map(item => [
    legacyId(item._id),
    stableSourceId('declarant', item.id_preleveur)
  ]))
  const zonedDeclarantSourceIds = [...new Set(exploitations
    .map(item => declarantSourceIdByLegacyId.get(legacyId(item.preleveur)))
    .filter(Boolean))]
  const agentTargets = await prisma.instructor.findMany({
    where: {sourceId: {in: expectedSourceIds.agents}},
    select: {sourceId: true, user: {select: {role: true}}}
  })
  const globalAdminSourceIds = new Set(
    agentTargets.filter(item => item.user.role === 'ADMIN').map(item => item.sourceId)
  )
  let expectedAgentPermissions = 0
  for (const item of agents) {
    const sourceId = stableSourceId('agent', legacyId(item._id))
    if (globalAdminSourceIds.has(sourceId)) {
      continue
    }

    const role = (item.roles ?? []).find(entry => entry.territoire === TERRITORY_CODE)?.role
    expectedAgentPermissions += role === 'editor'
      ? ZONE_PERMISSION_CODES.length
      : READ_ONLY_ZONE_PERMISSIONS.length
  }

  let expectedSecondaryUsageLinks = 0
  for (const item of exploitations) {
    expectedSecondaryUsageLinks += (
      inputs.usageMap.get(String(item.id_exploitation))?.secondary.length ?? 0
    )
  }

  let expectedDocumentLinks = 0
  for (const plan of documentPlans) {
    expectedDocumentLinks += plan.exploitationIds.length
  }

  let expectedRuleLinks = 0
  for (const plan of rulePlans) {
    expectedRuleLinks += plan.exploitationIds.length
  }

  const expected = {
    contactEmails: contactSourceIds.length,
    primaryContactEmails: primaryContactSourceIds.length,
    pointZoneLinks: expectedSourceIds.points.length,
    declarantZoneLinks: zonedDeclarantSourceIds.length,
    secondaryUsageLinks: expectedSecondaryUsageLinks,
    agentZoneLinks: expectedSourceIds.agents.length - globalAdminSourceIds.size,
    agentPermissions: expectedAgentPermissions,
    documentExploitationLinks: expectedDocumentLinks,
    ruleExploitationLinks: expectedRuleLinks
  }
  const [
    contactEmails,
    primaryContactEmails,
    pointZoneLinks,
    declarantZoneLinks,
    secondaryUsageLinks,
    agentZoneLinks,
    agentPermissions,
    documentExploitationLinks,
    ruleExploitationLinks
  ] = await Promise.all([
    prisma.declarantContactEmail.count({where: {sourceId: {in: contactSourceIds}}}),
    prisma.declarantContactEmail.count({where: {
      sourceId: {in: primaryContactSourceIds},
      isPrimary: true
    }}),
    prisma.pointPrelevementZone.count({where: {
      pointPrelevement: {sourceId: {in: expectedSourceIds.points}},
      zone: {type: 'REGION', code: 'reg-04'}
    }}),
    prisma.declarantZone.count({where: {
      declarant: {sourceId: {in: zonedDeclarantSourceIds}},
      zone: {type: 'REGION', code: 'reg-04'}
    }}),
    prisma.declarantPointPrelevementSecondaryUsage.count({where: {
      exploitation: {sourceId: {in: expectedSourceIds.exploitations}}
    }}),
    prisma.instructorZone.count({where: {
      instructor: {sourceId: {in: expectedSourceIds.agents}},
      zone: {type: 'REGION', code: 'reg-04'}
    }}),
    prisma.instructorZonePermission.count({where: {instructorZone: {
      instructor: {sourceId: {in: expectedSourceIds.agents}},
      zone: {type: 'REGION', code: 'reg-04'}
    }}}),
    prisma.resourceDocumentExploitation.count({where: {
      resourceDocument: {sourceId: {in: expectedSourceIds.documents}}
    }}),
    prisma.resourceRuleExploitation.count({where: {
      resourceRule: {sourceId: {in: expectedSourceIds.rules}}
    }})
  ])
  const actual = {
    contactEmails,
    primaryContactEmails,
    pointZoneLinks,
    declarantZoneLinks,
    secondaryUsageLinks,
    agentZoneLinks,
    agentPermissions,
    documentExploitationLinks,
    ruleExploitationLinks
  }
  const mismatches = Object.keys(expected).filter(key => expected[key] !== actual[key])

  return {expected, actual, mismatches, globalAdminAgents: globalAdminSourceIds.size}
}

async function verifyMigration(options, inputs, targetContext, targetEnvironment) {
  assertVerificationOptions(options)
  const {prisma} = targetContext
  const excludedDocumentIds = new Set(inputs.documentExclusions.keys())
  const documentPlans = partitionDocuments({
    documents: inputs.groups.get('document') ?? [],
    exploitations: inputs.groups.get('exploitation') ?? [],
    rules: inputs.groups.get('rule') ?? [],
    excludedDocumentIds
  })
  const rulePlans = partitionRules({
    rules: inputs.groups.get('rule') ?? [],
    exploitations: inputs.groups.get('exploitation') ?? [],
    excludedDocumentIds
  })
  const expectedSourceIds = {
    declarants: (inputs.groups.get('declarant') ?? [])
      .map(item => stableSourceId('declarant', item.id_preleveur)),
    points: (inputs.groups.get('point') ?? [])
      .map(item => stableSourceId('point', item.id_point)),
    exploitations: (inputs.groups.get('exploitation') ?? [])
      .map(item => stableSourceId('exploitation', item.id_exploitation)),
    agents: (inputs.groups.get('agent') ?? [])
      .map(item => stableSourceId('agent', legacyId(item._id))),
    documents: documentPlans
      .map(plan => stableSourceId('document', plan.documentId, plan.ownerId)),
    rules: rulePlans
      .map(plan => stableSourceId('rule', plan.ruleId, plan.ownerId))
  }
  const expected = Object.fromEntries(
    Object.entries(expectedSourceIds).map(([key, sourceIds]) => [key, sourceIds.length])
  )
  const actual = {
    declarants: await prisma.declarant.count({where: {sourceId: {in: expectedSourceIds.declarants}}}),
    points: await prisma.pointPrelevement.count({where: {sourceId: {in: expectedSourceIds.points}}}),
    exploitations: await prisma.declarantPointPrelevement.count({where: {sourceId: {in: expectedSourceIds.exploitations}}}),
    agents: await prisma.instructor.count({where: {sourceId: {in: expectedSourceIds.agents}}}),
    documents: await prisma.resourceDocument.count({where: {sourceId: {in: expectedSourceIds.documents}}}),
    rules: await prisma.resourceRule.count({where: {sourceId: {in: expectedSourceIds.rules}}})
  }
  const mismatches = Object.keys(expected).filter(key => expected[key] !== actual[key])
  const invariants = await verifyRelationalInvariants({
    prisma,
    inputs,
    expectedSourceIds,
    documentPlans,
    rulePlans
  })
  const semanticFailures = await verifySemanticMigration(
    prisma,
    inputs,
    documentPlans,
    rulePlans
  )
  const s3Failures = []
  const targetS3 = createS3Context(targetEnvironment, 'S3 cible')
  try {
    let processed = 0
    for (const plan of documentPlans) {
      const storageKey = deterministicStorageKey({
        ownerLegacyId: plan.ownerId,
        documentLegacyId: plan.documentId,
        filename: plan.document.nom_fichier
      })
      const sourceId = stableSourceId('document', plan.documentId, plan.ownerId)
      if (!await verifyTargetDocumentContent(
        targetS3,
        storageKey,
        plan.document.s3.sha256,
        plan.document.s3.size
      )) {
        s3Failures.push(sourceId)
        semanticFailures.push(semanticFailure(
          'document',
          sourceId,
          'S3_CONTENT_MISMATCH',
          ['s3.content']
        ))
      }

      processed += 1
      if (processed % 100 === 0 || processed === documentPlans.length) {
        console.log(`[reunion:verify] contenu S3=${processed}/${documentPlans.length}`)
      }
    }
  } finally {
    targetS3.client.destroy()
  }

  const semantic = summarizeSemanticFailures(semanticFailures)

  const result = {
    ok: mismatches.length === 0
      && invariants.mismatches.length === 0
      && semantic.ok
      && s3Failures.length === 0,
    manifestSha256: inputs.manifestSha256,
    expected,
    actual,
    mismatches,
    invariants,
    semantic,
    missingOrInvalidS3Objects: s3Failures.length
  }
  console.log(
    `[reunion:verify] ok=${result.ok} mismatches=${mismatches.length}`
    + ` invariants=${invariants.mismatches.length}`
    + ` semantic=${semantic.total} s3=${s3Failures.length}`
  )
  return result
}

function defaultReportPath(options) {
  return options.report ?? `${options.manifest}.${options.command}.report.json`
}

async function main() {
  const options = parseArguments(process.argv.slice(2), DEFAULTS)
  if (options.help) {
    printUsage()
    return
  }

  if (options.command === 'verify') {
    assertVerificationOptions(options)
  }

  let snapshotReport
  if (options.command === 'snapshot' || options.command === 'all') {
    snapshotReport = await createSnapshot(options)
    if (options.command === 'snapshot') {
      await writeJsonReport(defaultReportPath(options), {command: 'snapshot', ...snapshotReport})
      return
    }
  }

  const inputs = await loadInputs(options)
  const needsTarget = ['preflight', 'apply', 'verify', 'all'].includes(options.command)
  let targetContext
  let targetEnvironment = {}
  let targetIdentity
  try {
    if (needsTarget) {
      if (!options.target || !options.targetEnv) {
        throw new Error('--target et --target-env sont requis')
      }

      targetEnvironment = await loadEnv(options.targetEnv)
      const targetAttestation = assertSafeTarget({
        target: options.target,
        confirmTarget: options.confirmTarget,
        apply: options.apply,
        targetEnv: options.targetEnv,
        targetEnvironment,
        manifestSha256: inputs.manifestSha256
      })
      await assertTargetCertificate(options.target, targetAttestation.sslRootCert)
      const targetS3 = createS3Context(targetEnvironment, 'S3 cible')
      try {
        await assertVersionedS3Bucket(
          targetS3,
          'S3 cible',
          options.target === 'testing' ? 'fr-par' : undefined
        )
      } finally {
        targetS3.client.destroy()
      }

      targetContext = await createTargetPrisma(requireEnv(targetEnvironment, 'DATABASE_URL', 'base cible'))
      const database = await attestTargetDatabase(targetContext.prisma, options.target)
      targetIdentity = {
        target: targetAttestation.target,
        appEnv: targetAttestation.appEnv,
        database,
        s3: targetAttestation.s3,
        fingerprint: targetAttestation.fingerprint,
        confirmation: targetAttestation.confirmation
      }
    }

    const preflight = await runPreflight(options, inputs, targetContext, targetIdentity)
    let applyReport
    let verifyReport

    if (options.command === 'apply' || options.command === 'all') {
      applyReport = await applyMigration({
        options,
        inputs,
        targetContext,
        targetEnvironment,
        preflight
      })
    }

    if (options.command === 'verify' || (options.command === 'all' && options.apply)) {
      verifyReport = await verifyMigration(options, inputs, targetContext, targetEnvironment)
    }

    const report = {
      command: options.command,
      target: options.target,
      manifestSha256: inputs.manifestSha256,
      snapshot: snapshotReport,
      preflight,
      apply: applyReport,
      verify: verifyReport
    }
    await writeJsonReport(defaultReportPath(options), report)

    if (!preflight.ok || verifyReport?.ok === false) {
      process.exitCode = 2
    }
  } finally {
    await targetContext?.close()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    await main()
  } catch (error) {
    console.error(`[reunion] ${error.message}`)
    process.exitCode = 1
  }
}
