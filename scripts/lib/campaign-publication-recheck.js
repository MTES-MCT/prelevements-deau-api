import {createHash} from 'node:crypto'
import {constants} from 'node:fs'
import {mkdir, open, realpath, stat} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {assertConnectedProdAdminDatabase} from '../network/prod-database-target.js'
import {requireDisposableDatabase} from '../../lib/util/test-helpers/disposable-database.js'

const OPERATION = 'recheck-campaign-publications'
const VERSION = 1
const MANUAL_PROVIDER = 'manual-collection'
const TRANSACTION_OPTIONS = {isolationLevel: 'Serializable', maxWait: 10_000, timeout: 60_000}
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const SHA256 = /^[a-f\d]{64}$/
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const requireCondition = (condition, message) => { if (!condition) throw new Error(message) }
const json = value => JSON.parse(JSON.stringify(value))
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))

export const publicationRecheckHash = value => createHash('sha256').update(JSON.stringify(sorted(json(value)))).digest('hex')

export function validatePublicationRecheckScope({target, campaignId, responseIds}) {
  requireCondition(['prod', 'disposable'].includes(target), 'Cible requise : prod ou disposable.')
  requireCondition(UUID.test(campaignId ?? ''), 'Un identifiant de campagne explicite est obligatoire.')
  requireCondition(Array.isArray(responseIds) && responseIds.length > 0 && responseIds.length <= 500
    && responseIds.every(id => UUID.test(id)) && new Set(responseIds).size === responseIds.length,
  'Une liste explicite de 1 à 500 identifiants de réponses distincts est obligatoire.')
  return {target, campaignId, responseIds: [...responseIds].sort()}
}

async function assertTarget(client, target) {
  if (target === 'prod') return assertConnectedProdAdminDatabase(client)
  requireDisposableDatabase()
  const [identity] = await client.$queryRawUnsafe('SELECT current_database()::text AS "databaseName", inet_server_port()::integer AS "serverPort"')
  const expected = requireDisposableDatabase()
  requireCondition(identity?.databaseName === expected.pathname.slice(1), 'Identité de la base jetable incorrecte.')
  return identity
}

function immutableResponse(response) {
  return omit(response, ['publicationStatus', 'publicationIssues', 'updatedAt', 'campaign', 'exploitation', 'declaration'])
}

const chunkInclude = {chunkValues: {orderBy: {id: 'asc'}}, source: true}

// Keep the complete before-image private. Hash only actual inputs for the stale
// preview check; generated volume identifiers are output, never evidence.
export async function snapshotCampaignPublication(tx, responseId) {
  const response = await tx.collectionResponse.findUnique({where: {id: responseId}, include: {
    campaign: true, exploitation: {include: {pointPrelevement: true,
      declarant: {select: {user: {select: {deletedAt: true}}}}}}, declaration: true
  }})
  requireCondition(response, `Réponse introuvable : ${responseId}.`)
  const compteurIds = [...new Set((response.submittedData?.meters ?? []).map(meter => meter.compteurId).filter(Boolean))].sort()
  const meterWhere = {compteurId: {in: compteurIds}}
  const [responses, meters, allocations, streams, readings, publications, chunks] = await Promise.all([
    tx.collectionResponse.findMany({where: {campaignId: response.campaignId}, orderBy: {id: 'asc'}}),
    tx.compteur.findMany({where: {id: {in: compteurIds}}, orderBy: {id: 'asc'}}),
    tx.meterAllocation.findMany({where: meterWhere, orderBy: {id: 'asc'}, include: {versions: {orderBy: {id: 'asc'}},
      exploitation: {select: {id: true, declarantUserId: true, pointPrelevementId: true, status: true,
        startDate: true, endDate: true, usageId: true,
        pointPrelevement: {select: {deletedAt: true, collectionMode: true}},
        declarant: {select: {user: {select: {deletedAt: true}}}}}}}}),
    tx.meterStream.findMany({where: meterWhere, orderBy: {id: 'asc'}}),
    tx.meterReading.findMany({where: meterWhere, orderBy: {id: 'asc'}, include: {revisions: {orderBy: {id: 'asc'}}}}),
    tx.meterPublication.findMany({where: meterWhere, orderBy: {id: 'asc'}, include: {contributions: {orderBy: {id: 'asc'}}}}),
    tx.chunk.findMany({where: {OR: [{pointPrelevementId: response.exploitation.pointPrelevementId}, meterWhere]},
      orderBy: {id: 'asc'}, include: chunkInclude})
  ])
  const relatedResponses = responses.filter(row => row.id === responseId
    || row.submittedData?.meters?.some(meter => compteurIds.includes(meter.compteurId)))
  const snapshot = json({response, responses: relatedResponses, meters, allocations, streams, readings, publications, chunks})
  const foreign = row => row.provider !== MANUAL_PROVIDER || row.scope !== response.campaignId
  const foreignStreamIds = new Set(snapshot.streams.filter(foreign).map(row => row.id))
  const foreignSourceIds = new Set(snapshot.publications.filter(row => foreignStreamIds.has(row.streamId)).map(row => row.sourceId))
  const protectedState = {
    response: immutableResponse(snapshot.response), campaign: snapshot.response.campaign,
    exploitation: snapshot.response.exploitation, declaration: snapshot.response.declaration,
    otherResponses: snapshot.responses.filter(row => row.id !== responseId).map(immutableResponse),
    meters: snapshot.meters,
    allocations: snapshot.allocations.filter(foreign),
    streams: snapshot.streams.filter(row => foreignStreamIds.has(row.id)),
    readings: snapshot.readings.filter(row => row.revisions.some(revision => foreignStreamIds.has(revision.streamId))),
    publications: snapshot.publications.filter(row => foreignStreamIds.has(row.streamId)),
    providerChunks: snapshot.chunks.filter(row => foreignSourceIds.has(row.sourceId)),
    declaredValues: snapshot.chunks.flatMap(chunk => chunk.chunkValues.filter(value => value.valueKind === 'DECLARED')),
    receiptActors: snapshot.chunks.filter(row => row.source.declarationId === response.declarationId)
      .map(row => ({id: row.id, sourceId: row.sourceId, exploitationId: row.exploitationId,
        pointPrelevementId: row.pointPrelevementId, preleveurUserId: row.preleveurUserId,
        submittedByDeclarantUserId: row.submittedByDeclarantUserId, collecteurUserId: row.collecteurUserId,
        compteurId: row.compteurId, usageId: row.usageId, minDate: row.minDate, maxDate: row.maxDate}))
  }
  const inputs = {...snapshot, responses: snapshot.responses.map(immutableResponse)}
  const outputs = {response: snapshot.response, chunks: snapshot.chunks.filter(row => row.source.declarationId === response.declarationId),
    streams: snapshot.streams, allocations: snapshot.allocations, readings: snapshot.readings, publications: snapshot.publications}
  return {snapshot, protectedHash: publicationRecheckHash(protectedState), inputHash: publicationRecheckHash(inputs),
    outputHash: publicationRecheckHash(outputs)}
}

async function services() {
  return import('../../lib/services/campaign-auto-publication.js')
}

function seal(report) {
  return {...report, reportHash: publicationRecheckHash(report)}
}

export function assertPublicationRecheckReport(report, expectedHash, scope, mode) {
  requireCondition(SHA256.test(expectedHash ?? ''), 'Empreinte SHA-256 du rapport attendue obligatoire.')
  requireCondition(report?.version === VERSION && report.operation === OPERATION && report.complete === true
    && report.mode === mode && report.reportHash === expectedHash
    && publicationRecheckHash(omit(report, ['reportHash'])) === expectedHash, 'Rapport invalide ou empreinte incorrecte.')
  requireCondition(report.target === scope.target && report.campaignId === scope.campaignId
    && publicationRecheckHash(report.responseIds) === publicationRecheckHash(scope.responseIds), 'Le périmètre diffère du rapport figé.')
  requireCondition(report.entries.length === scope.responseIds.length
    && publicationRecheckHash(report.entries.map(row => row.responseId).sort()) === publicationRecheckHash(scope.responseIds),
  'Les réponses du rapport diffèrent du périmètre explicite.')
}

export function summarizePublicationRecheck(entries) {
  const counts = {total: entries.length, eligible: 0, changed: 0, unchanged: 0, excluded: 0, published: 0, pending: 0}
  const reasons = {}
  for (const entry of entries) {
    if (entry.eligible) counts.eligible++
    if (entry.changed) counts.changed++
    else counts.unchanged++
    if (!entry.eligible) counts.excluded++
    if (entry.publicationStatus === 'PUBLISHED') counts.published++
    if (entry.publicationStatus === 'PENDING_REVIEW') counts.pending++
    for (const code of new Set((entry.publicationIssues ?? []).map(issue => issue.code))) reasons[code] = (reasons[code] ?? 0) + 1
  }
  return {counts, reasons}
}

export function assertIndependentPublicationTargets(entries) {
  const points = new Set()
  const meters = new Set()
  for (const entry of entries.filter(row => row.eligible)) {
    requireCondition(UUID.test(entry.pointPrelevementId ?? '') && Array.isArray(entry.compteurIds), 'Périmètre de calcul absent du rapport.')
    requireCondition(!points.has(entry.pointPrelevementId) && entry.compteurIds.every(id => !meters.has(id)),
      'Des réponses partagent un point ou un compteur. Prévisualiser, appliquer et vérifier séparément chaque réponse, dans cet ordre.')
    points.add(entry.pointPrelevementId)
    for (const id of entry.compteurIds) meters.add(id)
  }
}

const eligible = response => response.publicationStatus === 'PENDING_REVIEW'
  && Boolean(response.submittedData && response.lastSubmittedAt && response.declarationId)
const publicationState = response => ({publicationStatus: response.publicationStatus, publicationIssues: response.publicationIssues})

export async function previewCampaignPublications(client, options) {
  const scope = validatePublicationRecheckScope(options)
  const identity = await assertTarget(client, scope.target)
  const {getCampaignResponsePublicationPlan} = await services()
  const entries = []
  for (const responseId of scope.responseIds) {
    entries.push(await client.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
      const before = await snapshotCampaignPublication(tx, responseId)
      requireCondition(before.snapshot.response.campaignId === scope.campaignId, `Réponse hors campagne : ${responseId}.`)
      const canRecheck = eligible(before.snapshot.response)
      const plan = canRecheck ? await getCampaignResponsePublicationPlan(responseId, {client: tx}) : publicationState(before.snapshot.response)
      return {responseId, eligible: canRecheck, pointPrelevementId: before.snapshot.response.exploitation.pointPrelevementId,
        compteurIds: before.snapshot.meters.map(meter => meter.id).sort(), inputHash: before.inputHash, protectedHash: before.protectedHash,
        before: publicationState(before.snapshot.response), plan: json(plan), ...publicationState(plan)}
    }, TRANSACTION_OPTIONS))
  }
  return seal({version: VERSION, operation: OPERATION, mode: 'preview', complete: true, ...scope,
    identity, createdAt: new Date().toISOString(), entries, ...summarizePublicationRecheck(entries)})
}

async function lockResponse(tx, campaignId, responseId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('collection-campaign'), hashtext(${campaignId}))`
  await tx.$queryRaw`SELECT id FROM "CollectionResponse" WHERE id = ${responseId}::uuid FOR UPDATE`
}

async function applyEntry(client, entry, scope, options, recheck) {
  return client.$transaction(async tx => {
    await lockResponse(tx, scope.campaignId, entry.responseId)
    const before = await snapshotCampaignPublication(tx, entry.responseId)
    const response = before.snapshot.response
    requireCondition(response.campaignId === scope.campaignId && before.protectedHash === entry.protectedHash,
      `Les données protégées ont changé : ${entry.responseId}. Refaire la prévisualisation.`)
    // An already published answer can be replayed from the original preview.
    // Pending answers whose inputs changed require a new preview, never a guess.
    if (response.publicationStatus === 'PUBLISHED' && entry.publicationStatus === 'PUBLISHED') {
      return {responseId: entry.responseId, eligible: entry.eligible, changed: false, replayed: true,
        ...publicationState(response), protectedHash: before.protectedHash, afterHash: before.outputHash}
    }
    requireCondition(before.inputHash === entry.inputHash,
      `Les données ont changé : ${entry.responseId}. Refaire la prévisualisation.`)
    if (!entry.eligible) return {responseId: entry.responseId, eligible: false, changed: false,
      ...publicationState(response), protectedHash: before.protectedHash, afterHash: before.outputHash}
    requireCondition(eligible(response), `Réponse non éligible : ${entry.responseId}.`)
    const backup = {version: VERSION, operation: OPERATION, ...scope, responseId: entry.responseId,
      previewHash: options.expectedReportHash, createdAt: new Date().toISOString(), before: before.snapshot}
    const backupReference = await options.onBeforeApply(backup)
    requireCondition(backupReference, 'La sauvegarde durable doit être confirmée avant toute écriture.')
    const result = await recheck(tx, entry.responseId, {now: new Date()})
    const after = await snapshotCampaignPublication(tx, entry.responseId)
    requireCondition(after.protectedHash === before.protectedHash,
      `Invariant de conservation violé : ${entry.responseId}. Transaction annulée.`)
    requireCondition(publicationRecheckHash(publicationState(after.snapshot.response)) === publicationRecheckHash(publicationState(entry.plan)),
      `La décision a changé : ${entry.responseId}. Transaction annulée ; refaire la prévisualisation.`)
    return {responseId: entry.responseId, eligible: true, changed: before.inputHash !== after.inputHash,
      ...publicationState(after.snapshot.response), protectedHash: after.protectedHash, afterHash: after.outputHash,
      backupReference, result: json(result)}
  }, TRANSACTION_OPTIONS)
}

export async function applyCampaignPublications(client, options) {
  const scope = validatePublicationRecheckScope(options)
  assertPublicationRecheckReport(options.expectedReport, options.expectedReportHash, scope, 'preview')
  assertIndependentPublicationTargets(options.expectedReport.entries)
  requireCondition(typeof options.onBeforeApply === 'function', 'Sauvegarde privée durable obligatoire avant application.')
  const identity = await assertTarget(client, scope.target)
  const {recheckCampaignResponsePublicationInTransaction} = await services()
  const entries = []
  for (const entry of options.expectedReport.entries) {
    const result = await applyEntry(client, entry, scope, options, recheckCampaignResponsePublicationInTransaction)
    entries.push(result)
    // A durable journal makes successfully committed rows explicit even if a
    // later transaction fails. This callback runs only after that row commits.
    await options.onAfterEntry?.(result)
  }
  return seal({version: VERSION, operation: OPERATION, mode: 'apply', complete: true, ...scope,
    identity, previewHash: options.expectedReportHash, createdAt: new Date().toISOString(), entries,
    ...summarizePublicationRecheck(entries)})
}

export async function verifyCampaignPublications(client, options) {
  const scope = validatePublicationRecheckScope(options)
  assertPublicationRecheckReport(options.expectedReport, options.expectedReportHash, scope, 'apply')
  const identity = await assertTarget(client, scope.target)
  const entries = []
  for (const expected of options.expectedReport.entries) {
    entries.push(await client.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
      const current = await snapshotCampaignPublication(tx, expected.responseId)
      return {responseId: expected.responseId, verified: current.protectedHash === expected.protectedHash
        && current.outputHash === expected.afterHash, ...publicationState(current.snapshot.response)}
    }, TRANSACTION_OPTIONS))
  }
  return seal({version: VERSION, operation: OPERATION, mode: 'verify', complete: entries.every(row => row.verified),
    ...scope, identity, appliedReportHash: options.expectedReportHash, createdAt: new Date().toISOString(), entries,
    counts: {verified: entries.filter(row => row.verified).length, failed: entries.filter(row => !row.verified).length}})
}

export async function privatePublicationReportDirectory(directory) {
  const absolute = path.resolve(directory)
  await mkdir(absolute, {recursive: true, mode: 0o700})
  const resolved = await realpath(absolute)
  requireCondition(resolved !== repository && !resolved.startsWith(`${repository}${path.sep}`), 'Les rapports doivent rester hors du dépôt.')
  const info = await stat(resolved)
  requireCondition(info.isDirectory() && (info.mode & 0o077) === 0 && info.uid === process.getuid(),
    'Le dossier de rapports doit appartenir à cet utilisateur et être privé (0700).')
  return resolved
}

export async function writePrivatePublicationReport(filePath, value) {
  const directory = await privatePublicationReportDirectory(path.dirname(filePath))
  const target = path.join(directory, path.basename(filePath))
  const file = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync() } finally { await file.close() }
  const parent = await open(directory, constants.O_RDONLY)
  try { await parent.sync() } finally { await parent.close() }
  return {fileName: path.basename(target), sha256: publicationRecheckHash(value)}
}

export async function readPrivatePublicationReport(filePath) {
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    requireCondition(info.isFile() && (info.mode & 0o077) === 0 && info.uid === process.getuid(), 'Le rapport doit être privé (0600).')
    return JSON.parse(await file.readFile('utf8'))
  } finally { await file.close() }
}
