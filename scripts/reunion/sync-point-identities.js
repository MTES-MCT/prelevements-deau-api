#!/usr/bin/env node
import process from 'node:process'
import path from 'node:path'
import {readFile} from 'node:fs/promises'
import {parseArgs} from 'node:util'
import {compareData, pointNameCollisions, readManifestContent, reunionPointIdentity, sha256} from './lib/core.js'
import {loadEnv, verifyManifestChecksum} from './lib/runtime.js'
import {reservePrivateReport} from './lib/access-cli.js'
import {historyTarget, historyPlanHash, assertHistorySimulation, HISTORY_TARGET_OPTIONS, historyTargetArguments} from './lib/history-target.js'

export const POINT_IDENTITY_VERSION = 1
const OPERATION = 'reunion-point-identities'

export function pointIdentityScope(content) {
  const {header, records} = readManifestContent(content)
  if (header.territory !== 'DEP-974') throw new Error('Référentiel hors Réunion')
  const points = records.filter(row => row.kind === 'point').map(row => row.data)
  const identities = points.map(point => reunionPointIdentity(point))
  if (points.length !== 453 || new Set(identities.map(row => row.sourceId)).size !== 453
    || new Set(identities.map(row => row.name)).size !== 453) {
    throw new Error('Périmètre attendu de 453 points Réunion uniques absent')
  }
  return points.sort((a, b) => a.id_point - b.id_point)
}

export function planPointIdentities(points, rows) {
  const identities = points.map(point => reunionPointIdentity(point))
  if (new Set(identities.map(row => row.sourceId)).size !== points.length) throw new Error('Identité source dupliquée')
  if (pointNameCollisions(points, rows).length) throw new Error('Nom cible déjà utilisé par un autre point')
  const changes = []
  const before = []
  for (const item of points) {
    const {sourceId} = reunionPointIdentity(item)
    const matches = rows.filter(row => row.sourceId === sourceId)
    if (matches.length !== 1 || matches[0].deletedAt) throw new Error(`Point actif unique absent : ${sourceId}`)
    const current = matches[0]
    const after = reunionPointIdentity(item, current.identifiers)
    before.push(current)
    if (!compareData(current, after)) changes.push({id: current.id, sourceId, before: {name: current.name, identifiers: current.identifiers}, after: {name: after.name, identifiers: after.identifiers}})
  }
  return {points: points.length, before, changes}
}

async function readPoints(client, points) {
  const identities = points.map(point => reunionPointIdentity(point))
  const result = await client.$queryRawUnsafe(`SELECT to_jsonb(p) AS row FROM "PointPrelevement" p
    WHERE "sourceId" = ANY($1::text[]) OR name = ANY($2::text[]) ORDER BY id`,
  identities.map(row => row.sourceId), identities.map(row => row.name))
  return result.map(item => item.row)
}

function unchangedPointFields(rows) {
  return rows.map(({name: _name, updatedAt: _updatedAt, identifiers, ...row}) => {
    const {REUNION: _reunion, ...otherIdentifiers} = identifiers
    return {...row, identifiers: otherIdentifiers}
  }).sort((a, b) => a.id.localeCompare(b.id))
}

async function pointRelations(client, ids) {
  // No ChunkValue reads: stable point UUIDs retain all historical values.
  const relations = {
    zones: await client.pointPrelevementZone.findMany({where: {pointPrelevementId: {in: ids}}, orderBy: {id: 'asc'}}),
    exploitations: await client.declarantPointPrelevement.findMany({where: {pointPrelevementId: {in: ids}}, orderBy: {id: 'asc'}}),
    externalReferences: await client.externalReference.findMany({where: {pointPrelevementId: {in: ids}}, orderBy: {id: 'asc'}}),
    chunks: await client.chunk.findMany({where: {pointPrelevementId: {in: ids}}, orderBy: {id: 'asc'}, select: {
      id: true, sourceId: true, pointPrelevementId: true, pointPrelevementName: true, exploitationId: true,
      preleveurUserId: true, contentHash: true, instructionStatus: true, updatedAt: true
    }})
  }
  // Prisma returns Date objects; the legacy canonicalizer only handles JSON.
  return JSON.parse(JSON.stringify(relations))
}

export function assertPointIdentityBackup(evidence, snapshot, plan, sourceHash) {
  if (evidence?.operation !== OPERATION || evidence.sourceHash !== sourceHash
    || evidence.planHash !== plan.planHash || evidence.rowsSha256 !== historyPlanHash(plan.before)
    || snapshot?.operation !== OPERATION || snapshot.sourceHash !== sourceHash
    || historyPlanHash(snapshot.rows) !== evidence.rowsSha256) {
    throw new Error('Sauvegarde ciblée des mêmes points et du même état obligatoire')
  }
}

export async function synchronizePointIdentities(client, {points, apply = false, validatePlan = () => {}}) {
  if (apply) {
    const sourceIds = points.map(point => reunionPointIdentity(point).sourceId)
    await client.$queryRawUnsafe('SELECT id FROM "PointPrelevement" WHERE "sourceId" = ANY($1::text[]) ORDER BY id FOR UPDATE', sourceIds)
  }
  const plan = planPointIdentities(points, await readPoints(client, points))
  const ids = plan.before.map(row => row.id)
  const relations = await pointRelations(client, ids)
  const preservedFieldsHash = historyPlanHash(unchangedPointFields(plan.before))
  const relationsHash = historyPlanHash(relations)
  const planHash = historyPlanHash({...plan, relationsHash, version: POINT_IDENTITY_VERSION})
  await validatePlan({...plan, planHash})
  if (apply) {
    for (const change of plan.changes) {
      await client.pointPrelevement.update({where: {id: change.id, sourceId: change.sourceId}, data: change.after})
    }
    const after = planPointIdentities(points, await readPoints(client, points))
    if (after.changes.length || historyPlanHash(unchangedPointFields(after.before)) !== preservedFieldsHash
      || historyPlanHash(await pointRelations(client, ids)) !== relationsHash) {
      throw new Error('Vérification après écriture différente : transaction annulée')
    }
  }
  return {...plan, planHash, preservedFieldsHash, relationsHash,
    relationCounts: Object.fromEntries(Object.entries(relations).map(([key, rows]) => [key, rows.length])), verified: apply}
}

export async function syncPointIdentities({manifest, targetEnv, reportFile, apply = false, target = 'local', ...targetOptions}) {
  process.umask(0o077)
  const {content} = await verifyManifestChecksum(path.resolve(manifest))
  const points = pointIdentityScope(content)
  const sourceHash = historyPlanHash({referenceSha256: sha256(content), version: POINT_IDENTITY_VERSION, operation: OPERATION})
  const configuration = await loadEnv(targetEnv)
  const context = await historyTarget({target, configuration, sourceHash, targetEnv, apply, withStorage: false, ...targetOptions})
  const {prisma, close, attestation, expected, backup} = context
  let output
  try {
    output = await reservePrivateReport(reportFile)
    const backupEvidence = apply && target === 'testing' ? JSON.parse(await readFile(targetOptions.backupEvidence, 'utf8')) : undefined
    const backupSnapshot = backupEvidence ? JSON.parse(await readFile(backupEvidence.backupFile, 'utf8')) : undefined
    const result = await prisma.$transaction(async tx => {
      if (!apply) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
      return synchronizePointIdentities(tx, {points, apply, validatePlan: plan => {
        if (apply && target === 'testing') {
          assertHistorySimulation(expected, {target, operation: OPERATION, sourceHash, planHash: plan.planHash, attestation})
          assertPointIdentityBackup(backupEvidence, backupSnapshot, plan, sourceHash)
        }
      }})
    }, {timeout: 120000})
    const report = {createdAt: new Date().toISOString(), target, operation: OPERATION, apply, complete: true,
      attestation, backup, sourceHash, referenceSha256: sha256(content), version: POINT_IDENTITY_VERSION, ...result}
    await output.writeFile(`${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify({operation: OPERATION, target, apply, points: result.points, changes: result.changes.length,
      verified: result.verified, relationCounts: result.relationCounts}))
    return report
  } finally { await output?.close(); await close() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const {values} = parseArgs({options: {...HISTORY_TARGET_OPTIONS, manifest: {type: 'string'}, 'target-env': {type: 'string'}, report: {type: 'string'}, apply: {type: 'boolean', default: false}}})
  syncPointIdentities({manifest: values.manifest, targetEnv: values['target-env'], reportFile: values.report, apply: values.apply, ...historyTargetArguments(values)})
    .catch(error => { console.error(JSON.stringify({operation: OPERATION, error: error.name, code: error.code ?? null, message: error.message})); process.exitCode = 1 })
}
