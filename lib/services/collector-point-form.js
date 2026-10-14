/* eslint-disable no-await-in-loop -- Explicit exploitations are processed in stable lock order in one transaction. */
import Joi from 'joi'
import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {decoratePointWithCoords, getPointPrelevement, updatePointPrelevementById} from '../models/point-prelevement.js'
import {validateCollectorPointForm} from '../validation/collector-point-form-validation.js'
import {isDatabaseWriteConflict} from '../util/database-write-conflict.js'
import {assertExploitationMultiplicity, exploitationAtDateWhere, normalizeCountingCode} from './exploitation-periods.js'
import {assertCollectorPointManagementEnabled, getCollectorPointRights, prepareCollectorPointUpdate} from './collector-point-management.js'
import {getCollectorExploitationMeters, saveCollectorExploitationMeters} from './collector-point-meters.js'

function validatePointId(pointId) {
  if (Joi.string().uuid().required().validate(pointId).error) throw createHttpError(400, 'Identifiant de point invalide.')
}

function exploitationWhere(user, pointId, now) {
  return {
    pointPrelevementId: pointId,
    ...exploitationAtDateWhere(now),
    declarant: {declarantRole: 'PRELEVEUR', user: {role: 'DECLARANT', deletedAt: null}},
    collecteurs: {some: {collecteurUserId: user.id}}
  }
}

async function readForm(client, pointId, user, now) {
  const record = await client.pointPrelevement.findFirst({where: {id: pointId, deletedAt: null}})
  if (!record) throw createHttpError(404, 'Point de prélèvement introuvable.')
  const right = (await getCollectorPointRights(user, [pointId], {client, now})).get(pointId)
  if (!right?.canEdit) throw createHttpError(403, 'Vous ne suivez pas d’exploitation active sur ce point.')
  const rows = await client.declarantPointPrelevement.findMany({
    where: exploitationWhere(user, pointId, now),
    select: {
      id: true, countingCode: true,
      declarant: {select: {userId: true, socialReason: true, user: {select: {firstName: true, lastName: true}}}},
      usage: {select: {id: true, label: true}}
    },
    orderBy: {id: 'asc'}
  })
  if (!rows.length) throw createHttpError(403, 'Vous ne suivez pas d’exploitation active sur ce point.')
  const {internalComment: _internalComment, ...publicPoint} = record
  const point = {...await decoratePointWithCoords(publicPoint, {client}), right}
  const exploitations = []
  for (const row of rows) {
    exploitations.push({
      id: row.id, countingCode: row.countingCode, usage: row.usage,
      preleveur: {id: row.declarant.userId, socialReason: row.declarant.socialReason, ...row.declarant.user},
      meters: await getCollectorExploitationMeters(client, row.id),
      capabilities: {canEditCountingCode: true, canAddMeter: true}
    })
  }
  return {point, exploitations}
}

export async function getCollectorPointForm(pointId, {user, client = prisma, now = new Date()} = {}) {
  validatePointId(pointId)
  await assertCollectorPointManagementEnabled(user, {client})
  return readForm(client, pointId, user, now)
}

async function lockSelectedExploitations(tx, edits, {pointId, user, now, exploitationIds}) {
  const allowed = new Set(exploitationIds)
  const rows = new Map()
  for (const edit of edits) {
    if (!allowed.has(edit.id)) throw createHttpError(403, 'Cette exploitation ne fait pas partie des exploitations que vous suivez sur ce point.')
    await tx.$queryRaw`SELECT id FROM "DeclarantPointPrelevement" WHERE id = ${edit.id}::uuid FOR UPDATE`
    const existing = await tx.declarantPointPrelevement.findFirst({
      where: {id: edit.id, ...exploitationWhere(user, pointId, now)},
      select: {id: true, declarantUserId: true, pointPrelevementId: true, countingCode: true,
        status: true, startDate: true, endDate: true}
    })
    if (!existing) throw createHttpError(403, 'Les droits sur cette exploitation ont changé. Rechargez la fiche.')
    rows.set(edit.id, existing)
  }
  return rows
}

async function updateCountingCode(tx, existing, edit) {
  if (!Object.hasOwn(edit, 'countingCode')) return null
  const current = normalizeCountingCode(existing.countingCode)
  if (normalizeCountingCode(edit.expectedCountingCode) !== current) {
    throw createHttpError(409, 'Le code comptage a été modifié depuis le chargement de cette exploitation.')
  }
  if (edit.countingCode === current) return null
  const next = {...existing, countingCode: edit.countingCode}
  await assertExploitationMultiplicity(tx, next, {existing})
  await tx.declarantPointPrelevement.update({where: {id: existing.id}, data: {countingCode: next.countingCode}})
  return {operation: 'UPDATE', entityType: 'EXPLOITATION', entityId: existing.id, before: existing, after: next}
}

function throwFormConflict(error) {
  if (isDatabaseWriteConflict(error)) throw createHttpError(409, 'Les droits ou la fiche ont changé. Rechargez la page avant de réessayer.')
  const details = [error.message, error.code, error.meta?.database_error,
    error.meta?.driverAdapterError?.cause?.originalMessage, error.meta?.driverAdapterError?.cause?.constraint].join(' ')
  if (/DPP_operational_counting_period_excl|DPP_uncoded_operational_period_conflict|DeclarantPointPrelevement_operational_period_excl|23P01/.test(details)) {
    throw createHttpError(409, 'Ce code comptage est incompatible avec une autre exploitation du même préleveur et du même point.')
  }
  if (/DPP_unresolved_history_split_check/.test(details)) {
    throw createHttpError(409, 'Les déclarations existantes doivent être rattachées à leur exploitation avant de modifier ces comptages.')
  }
  throw error
}

export async function updateCollectorPointForm(pointId, payload, {
  user, client = prisma, now = new Date(), onUpdated = () => {}
} = {}) {
  validatePointId(pointId)
  const value = validateCollectorPointForm(payload)
  const edits = [...value.exploitations].sort((a, b) => a.id.localeCompare(b.id))
  let committed
  try {
    committed = await client.$transaction(async tx => {
      const prepared = await prepareCollectorPointUpdate(tx, pointId,
        {expectedUpdatedAt: value.expectedUpdatedAt, changes: value.point}, {user, now})
      const selected = await lockSelectedExploitations(tx, edits, {pointId, user, now, exploitationIds: prepared.exploitationIds})
      const before = await getPointPrelevement(pointId, {client: tx})
      const mutations = []
      for (const edit of edits) {
        const exploitation = selected.get(edit.id)
        const mutation = await updateCountingCode(tx, exploitation, edit)
        if (mutation) mutations.push(mutation)
        if (edit.meters?.length) {
          const result = await saveCollectorExploitationMeters(tx, {exploitation, meters: edit.meters, actorId: user.id})
          mutations.push(...result.mutations)
        }
      }
      // The form version also covers newly attached meters. A repeated PATCH
      // with the old version cannot create a second meter after a lost reply.
      const updatedAt = new Date(Math.max(Date.now(), new Date(prepared.point.updatedAt).getTime() + 1))
      const after = await updatePointPrelevementById(pointId, {...prepared.changes, updatedAt}, {client: tx})
      mutations.unshift({operation: 'UPDATE', entityType: 'POINT', entityId: pointId, before, after})
      return {form: await readForm(tx, pointId, user, now), mutations}
    }, {isolationLevel: 'Serializable', maxWait: 5000, timeout: 20000})
  } catch (error) {
    throwFormConflict(error)
  }
  await onUpdated(committed.mutations)
  return committed.form
}
