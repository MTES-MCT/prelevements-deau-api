import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'

import {SAGE_OVERLAP_ZONE_CODES, selectCompatibleSageZone} from '../../../lib/services/zone-resource-types.js'

const pairCodes = Object.values(SAGE_OVERLAP_ZONE_CODES).sort()
const policyHash = createHash('sha256')
  .update(readFileSync(new URL(import.meta.url)))
  .update(readFileSync(new URL('../../../lib/services/zone-resource-types.js', import.meta.url)))
  .digest('hex')

function failure(code, message) {
  return Object.assign(new Error(message), {code})
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

export function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function seal(value, field) {
  return {...value, [field]: fingerprint(value)}
}

function assertSeal(value, field) {
  if (!value || typeof value !== 'object') throw failure('INVALID_DOCUMENT', 'Document de contrôle invalide.')
  const {[field]: checksum, ...body} = value
  if (checksum !== fingerprint(body)) throw failure('INVALID_DOCUMENT_HASH', 'Empreinte du document de contrôle invalide.')
}

function sortedLinks(links) {
  return [...links].sort((a, b) => a.zoneId.localeCompare(b.zoneId) || a.id.localeCompare(b.id))
}

function normalizeState(state) {
  return {
    zones: [...state.zones].sort((a, b) => a.id.localeCompare(b.id)),
    points: state.points.map(point => ({...point, candidateZoneIds: [...point.candidateZoneIds].sort(), links: sortedLinks(point.links)}))
      .sort((a, b) => a.id.localeCompare(b.id))
  }
}

function assertTarget(target) {
  if (!['local', 'testing', 'prod'].includes(target)) throw failure('INVALID_TARGET', 'Environnement explicite local, testing ou prod requis.')
}

function linkId(stateHash, pointId, zoneId, createdAt) {
  const hex = fingerprint({policyHash, stateHash, pointId, zoneId, createdAt})
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function pointDecision(point, zones, pair) {
  if (point.deletedAt) return {reason: 'DELETED_POINT'}
  if (!point.coordinatesHash) return {reason: 'MISSING_COORDINATES'}
  if (!pair.every(zone => point.candidateZoneIds.includes(zone.id))) return {reason: 'OUTSIDE_INTERSECTION'}
  if (!['SUPERFICIELLE', 'SOUTERRAIN'].includes(point.waterBodyType)) return {reason: 'UNSUPPORTED_WATER_BODY_TYPE'}
  const sageIds = new Set(zones.map(zone => zone.id))
  if (point.links.some(link => sageIds.has(link.zoneId) && !pair.some(zone => zone.id === link.zoneId))) {
    return {reason: 'EXISTING_THIRD_SAGE'}
  }
  const selection = selectCompatibleSageZone(zones.filter(zone => point.candidateZoneIds.includes(zone.id)), point.waterBodyType)
  if (selection.reason !== 'SAGE_OVERLAP_RESOURCE_PRIORITY') return {reason: selection.reason}
  return {reason: selection.reason, zoneId: selection.selectedSage.id}
}

export function buildReview(input, {target, createdAt = new Date().toISOString()} = {}) {
  assertTarget(target)
  if (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) throw failure('INVALID_REVIEW_DATE', 'Date de revue invalide.')
  const state = normalizeState(input)
  const stateHash = fingerprint(state)
  const pair = pairCodes.map(code => {
    const matches = state.zones.filter(zone => zone.code === code && zone.type === 'SAGE')
    if (matches.length !== 1 || !matches[0].geometryHash) throw failure('INVALID_SAGE_PAIR', 'La paire de SAGE attendue est absente ou ambiguë.')
    return matches[0]
  })
  const entries = state.points.map(point => {
    const decision = pointDecision(point, state.zones, pair)
    const beforeLinks = point.links
    if (!decision.zoneId) return {pointId: point.id, status: 'EXCEPTION', reason: decision.reason, beforeLinks, afterLinks: beforeLinks}
    const afterLinks = beforeLinks.filter(link => !pair.some(zone => zone.id === link.zoneId) || link.zoneId === decision.zoneId)
    if (!afterLinks.some(link => link.zoneId === decision.zoneId)) {
      afterLinks.push({id: linkId(stateHash, point.id, decision.zoneId, createdAt), zoneId: decision.zoneId,
        createdAt: createdAt.replace('Z', '000')})
    }
    const after = sortedLinks(afterLinks)
    return {pointId: point.id, status: fingerprint(beforeLinks) === fingerprint(after) ? 'UNCHANGED' : 'CHANGE',
      reason: decision.reason, targetZoneId: decision.zoneId, beforeLinks, afterLinks: after}
  })
  const summary = {points: entries.length, changed: 0, unchanged: 0, exceptions: 0, reasons: {}}
  for (const entry of entries) {
    summary[entry.status === 'CHANGE' ? 'changed' : entry.status === 'UNCHANGED' ? 'unchanged' : 'exceptions']++
    summary.reasons[entry.reason] = (summary.reasons[entry.reason] || 0) + 1
  }
  return seal({version: 1, kind: 'sage-overlap-review', policyHash, target, createdAt, state, stateHash, entries, summary}, 'reportHash')
}

export function validateReview(review, target) {
  assertTarget(target)
  assertSeal(review, 'reportHash')
  if (review.kind !== 'sage-overlap-review' || review.version !== 1 || review.target !== target || review.policyHash !== policyHash) {
    throw failure('INCOMPATIBLE_REVIEW', 'Revue incompatible avec la cible ou la version du script.')
  }
  const rebuilt = buildReview(review.state, {target, createdAt: review.createdAt})
  if (rebuilt.reportHash !== review.reportHash) throw failure('INCONSISTENT_REVIEW', 'Plan de réparation incohérent avec son inventaire.')
  return review
}

export function projectedState(review) {
  const afterById = new Map(review.entries.map(entry => [entry.pointId, entry.afterLinks]))
  return normalizeState({...review.state, points: review.state.points.map(point => ({...point, links: afterById.get(point.id)}))})
}

// No identity or credentials are selected. Exact microseconds preserve link rows
// during rollback; geometry and settings fingerprints also cover new candidates.
export async function readState(client) {
  const {rows: zones} = await client.query(`
    SELECT id, code, type, "managedResourceType", md5(ST_AsEWKB(coordinates)) AS "geometryHash",
      to_char("updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "updatedAt"
    FROM "Zone" WHERE type = 'SAGE' ORDER BY id
  `)
  const pair = pairCodes.map(code => zones.find(zone => zone.code === code))
  if (pair.some(zone => !zone)) throw failure('INVALID_SAGE_PAIR', 'La paire de SAGE attendue est absente.')
  const {rows: points} = await client.query(`
    SELECT p.id, p."waterBodyType", md5(ST_AsEWKB(p.coordinates)) AS "coordinatesHash",
      to_char(p."deletedAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "deletedAt",
      to_char(p."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "updatedAt",
      ARRAY(SELECT z.id::text FROM "Zone" z WHERE z.type = 'SAGE'
        AND ST_Intersects(z.coordinates, p.coordinates) ORDER BY z.id) AS "candidateZoneIds",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id', l.id, 'zoneId', l."zoneId", 'createdAt',
        to_char(l."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.US')) ORDER BY l."zoneId", l.id)
        FROM "PointPrelevementZone" l WHERE l."pointPrelevementId" = p.id), '[]'::jsonb) AS links
    FROM "PointPrelevement" p
    WHERE EXISTS (SELECT 1 FROM "PointPrelevementZone" l WHERE l."pointPrelevementId" = p.id AND l."zoneId" = ANY($1::uuid[]))
      OR (ST_Intersects(p.coordinates, (SELECT coordinates FROM "Zone" WHERE id = $2::uuid))
        AND ST_Intersects(p.coordinates, (SELECT coordinates FROM "Zone" WHERE id = $3::uuid)))
    ORDER BY p.id
  `, [pair.map(zone => zone.id), pair[0].id, pair[1].id])
  return normalizeState({zones, points})
}

async function transaction(client, write, callback) {
  await client.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    await client.query("SET LOCAL lock_timeout = '5s'")
    await client.query("SET LOCAL statement_timeout = '120s'")
    if (write) {
      // Prevent updates/inserts/deletes and phantom candidates through every
      // application/import writer, including ones not using advisory locks.
      await client.query('LOCK TABLE "Zone", "PointPrelevement", "PointPrelevementZone" IN SHARE ROW EXCLUSIVE MODE')
    }
    const result = await callback()
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}

export async function reviewRepair(client, {target}) {
  assertTarget(target)
  return transaction(client, false, async () => buildReview(await readState(client), {target}))
}

function makeReceipt({review, operation, changes, beforeHash, afterHash, againstReceiptHash}) {
  return seal({version: 1, kind: 'sage-overlap-receipt', target: review.target, operation, status: 'PREPARED',
    createdAt: new Date().toISOString(), review, changes, beforeHash, afterHash,
    ...(againstReceiptHash ? {againstReceiptHash} : {}), summary: {changed: changes.length}}, 'receiptHash')
}

function committed(receipt) {
  const {receiptHash, ...body} = receipt
  return seal({...body, status: 'COMMITTED'}, 'receiptHash')
}

async function writeDelta(client, entries, reverse = false) {
  for (const entry of entries) {
    const before = reverse ? entry.afterLinks : entry.beforeLinks
    const after = reverse ? entry.beforeLinks : entry.afterLinks
    const removedIds = before.filter(link => !after.some(next => next.id === link.id)).map(link => link.id)
    if (removedIds.length) {
      const removed = await client.query('DELETE FROM "PointPrelevementZone" WHERE "pointPrelevementId" = $1::uuid AND id = ANY($2::uuid[])', [entry.pointId, removedIds])
      if (removed.rowCount !== removedIds.length) throw failure('LINK_DRIFT', 'Dérive des liens pendant la réparation.')
    }
    for (const link of after.filter(link => !before.some(previous => previous.id === link.id))) {
      await client.query(`INSERT INTO "PointPrelevementZone" (id, "pointPrelevementId", "zoneId", "createdAt")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamp)`, [link.id, entry.pointId, link.zoneId, link.createdAt])
    }
  }
}

async function persistAndCheck(client, {review, expected, changes, operation, reverse = false, persistPrepared, againstReceiptHash}) {
  const beforeHash = fingerprint(await readState(client))
  await writeDelta(client, changes, reverse)
  const afterHash = fingerprint(await readState(client))
  if (afterHash !== fingerprint(expected)) throw failure('AFTER_STATE_MISMATCH', 'Vérification après réparation non conforme : transaction annulée.')
  const receipt = makeReceipt({review, operation, changes, beforeHash, afterHash, againstReceiptHash})
  await persistPrepared(receipt)
  return receipt
}

export async function applyRepair(client, review, {target, persistPrepared}) {
  validateReview(review, target)
  if (typeof persistPrepared !== 'function') throw failure('RECEIPT_PERSISTENCE_REQUIRED', 'Persistance durable du reçu requise avant application.')
  const after = projectedState(review)
  const receipt = await transaction(client, true, async () => {
    const currentHash = fingerprint(await readState(client))
    const alreadyApplied = currentHash === fingerprint(after)
    if (!alreadyApplied && currentHash !== review.stateHash) throw failure('REVIEW_STATE_DRIFT', 'Dérive depuis la revue : refaire une simulation.')
    const changes = alreadyApplied ? [] : review.entries.filter(entry => entry.status === 'CHANGE')
    return persistAndCheck(client, {review, expected: after, changes, operation: 'APPLY', persistPrepared})
  })
  return committed(receipt)
}

export function validateReceipt(receipt, target) {
  assertSeal(receipt, 'receiptHash')
  if (receipt.kind !== 'sage-overlap-receipt' || receipt.version !== 1 || receipt.operation !== 'APPLY'
    || receipt.target !== target || !['PREPARED', 'COMMITTED'].includes(receipt.status)) throw failure('INCOMPATIBLE_RECEIPT', 'Reçu de réparation incompatible.')
  validateReview(receipt.review, target)
  const changes = receipt.review.entries.filter(entry => entry.status === 'CHANGE')
  const afterHash = fingerprint(projectedState(receipt.review))
  const replay = receipt.changes?.length === 0
  if (receipt.afterHash !== afterHash || receipt.beforeHash !== (replay ? afterHash : receipt.review.stateHash)
    || (!replay && fingerprint(receipt.changes) !== fingerprint(changes)) || receipt.summary?.changed !== receipt.changes.length) {
    throw failure('INCONSISTENT_RECEIPT', 'Reçu de réparation incohérent.')
  }
  return receipt
}

export async function rollbackRepair(client, receipt, {target, persistPrepared}) {
  validateReceipt(receipt, target)
  if (typeof persistPrepared !== 'function') throw failure('RECEIPT_PERSISTENCE_REQUIRED', 'Persistance durable du reçu requise avant retour arrière.')
  const {review} = receipt
  const result = await transaction(client, true, async () => {
    const current = await readState(client)
    const currentHash = fingerprint(current)
    const alreadyReverted = currentHash === review.stateHash
    if (!alreadyReverted && currentHash !== receipt.afterHash) throw failure('ROLLBACK_STATE_DRIFT', 'Dérive depuis la réparation : retour arrière refusé.')
    const changes = alreadyReverted ? [] : receipt.changes
    const expected = receipt.changes.length ? review.state : current
    return persistAndCheck(client, {review, expected, changes, operation: 'ROLLBACK', reverse: true,
      persistPrepared, againstReceiptHash: receipt.receiptHash})
  })
  return committed(result)
}
