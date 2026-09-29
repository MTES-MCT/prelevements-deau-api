/* eslint-disable no-await-in-loop -- Meter and point locks, version closure and recalculation form one transaction. */
import {randomUUID} from 'node:crypto'
import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {meterAllocationEditSchema} from '../validation/meters.js'
import {meterBusinessDateBoundary, meterHash, validateAllocationSnapshot} from './meter-core.js'
import {lockMeter, reprocessMeterStreamInTransaction} from './meter-publication.js'

const dateFormatter = new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'})
export function assertMeterAllocationAdmin(user) {
  if (user?.role !== 'ADMIN') throw createHttpError(403, 'La répartition d’un compteur partagé est réservée aux administrateurs.')
}

export function validateMeterAllocationEdit(body) {
  const {error, value} = meterAllocationEditSchema.validate(body)
  if (error) throw createHttpError(400, error.message)
  const date = new Date(`${value.effectiveDate}T12:00:00Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value.effectiveDate
    || date.getUTCFullYear() < 1900 || date.getUTCFullYear() > 2100) throw createHttpError(400, 'Date d’effet invalide (1900–2100).')
  try {
    validateAllocationSnapshot(value.allocations.map((row, index) => ({key: row.key ?? `new:${index}`, percentage: row.percentage, inScope: row.exploitationId !== null})), true)
  } catch {
    throw createHttpError(400, 'Les parts doivent être comprises entre 0 et 100 %, sans doublon, avec un total exactement égal à 100 %.')
  }
  if (!value.allocations.some(row => row.exploitationId)) throw createHttpError(400, 'Au moins une exploitation doit rester rattachée au compteur.')
  return value
}

const exploitationInclude = {pointPrelevement: true, declarant: {include: {user: true}}, usage: true}

function exploitationLabel(exploitation) {
  const name = exploitation.declarant.socialReason
    || [exploitation.declarant.user.firstName, exploitation.declarant.user.lastName].filter(Boolean).join(' ')
    || 'Préleveur'
  return `${exploitation.pointPrelevement.name || 'Point sans nom'} — ${name}${exploitation.countingCode ? ` — Comptage ${exploitation.countingCode}` : ''}${exploitation.usage?.label ? ` — ${exploitation.usage.label}` : ''}`
}

async function loadState(client, {meterId, exploitationId, streamId}) {
  const stream = await client.meterStream.findFirst({where: {id: streamId, compteurId: meterId, compteur: {deletedAt: null}}, include: {compteur: true}})
  if (!stream) throw createHttpError(404, 'Synchronisation du compteur introuvable.')
  if (stream.provider === 'manual-collection') throw createHttpError(409, 'Les répartitions de cette collecte se valident depuis la campagne correspondante.')
  const allocations = await client.meterAllocation.findMany({
    where: {compteurId: meterId, provider: stream.provider, scope: stream.scope},
    include: {versions: {orderBy: {version: 'asc'}}, exploitation: {include: exploitationInclude}}, orderBy: {id: 'asc'}
  })
  if (!allocations.some(allocation => allocation.exploitationId === exploitationId
    && !allocation.exploitation.pointPrelevement.deletedAt && !allocation.exploitation.declarant.user.deletedAt)) {
    throw createHttpError(404, 'Ce compteur n’est pas rattaché à cette exploitation.')
  }
  return {stream, allocations}
}

function serializeState({stream, allocations}) {
  const latestDates = allocations.flatMap(allocation => allocation.versions.map(version => version.startDate)).filter(Boolean)
  if (stream.activatedAt) latestDates.push(stream.activatedAt)
  const latest = latestDates.length ? new Date(Math.max(...latestDates.map(date => date.getTime()))) : null
  const minimum = latest ? new Date(`${dateFormatter.format(latest)}T12:00:00Z`) : new Date()
  if (latest) minimum.setUTCDate(minimum.getUTCDate() + 1)
  const expectedVersion = meterHash(JSON.parse(JSON.stringify({
    streamId: stream.id, enabled: stream.enabled, activatedAt: stream.activatedAt,
    snapshot: stream.allocationSnapshot, validated: stream.allocationSnapshotValidated,
    allocations: allocations.map(allocation => ({id: allocation.id, exploitationId: allocation.exploitationId, versions: allocation.versions}))
  })))
  return {
    meter: {id: stream.compteur.id, serialNumber: stream.compteur.serialNumber, identifier: stream.compteur.identifier},
    stream: {id: stream.id, provider: stream.provider, enabled: stream.enabled},
    expectedVersion, minEffectiveDate: dateFormatter.format(minimum),
    allocations: (Array.isArray(stream.allocationSnapshot) ? stream.allocationSnapshot : []).map(share => {
      const allocation = allocations.find(item => item.sourceId === share.key)
      const latestVersion = allocation?.versions.toSorted((a, b) => (b.startDate?.getTime() ?? 0) - (a.startDate?.getTime() ?? 0))[0]
      return {key: share.key, exploitationId: share.inScope ? allocation?.exploitationId ?? null : null,
        inScope: share.inScope === true, unresolved: share.inScope === true && !allocation,
        exploitationLabel: share.inScope && allocation ? exploitationLabel(allocation.exploitation) : null,
        percentage: String(share.percentage ?? ''), additive: latestVersion?.additive ?? false}
    })
  }
}

export async function getMeterAllocationSettings({user, ...scope}, {client = prisma} = {}) {
  assertMeterAllocationAdmin(user)
  return serializeState(await loadState(client, scope))
}

export async function searchMeterAllocationTargets({user, search}, {client = prisma} = {}) {
  assertMeterAllocationAdmin(user)
  if (typeof search !== 'string' || search.trim().length < 2 || search.trim().length > 100) throw createHttpError(400, 'Saisissez entre 2 et 100 caractères.')
  const contains = {contains: search.trim(), mode: 'insensitive'}
  const rows = await client.declarantPointPrelevement.findMany({
    where: {status: {in: ['EN_ACTIVITE', 'NON_RENSEIGNE']}, pointPrelevement: {deletedAt: null}, declarant: {user: {deletedAt: null}},
      OR: [{countingCode: contains}, {pointPrelevement: {name: contains}}, {declarant: {socialReason: contains}},
        {declarant: {user: {firstName: contains}}}, {declarant: {user: {lastName: contains}}}]},
    include: exploitationInclude, orderBy: {id: 'asc'}, take: 25
  })
  return {items: rows.map(row => ({id: row.id, label: exploitationLabel(row)}))}
}

async function validateTargets(client, rows, effectiveDate) {
  const ids = [...new Set(rows.map(row => row.exploitationId).filter(Boolean))]
  const targets = await client.declarantPointPrelevement.findMany({
    where: {id: {in: ids}, status: {in: ['EN_ACTIVITE', 'NON_RENSEIGNE']},
      pointPrelevement: {deletedAt: null}, declarant: {user: {deletedAt: null}}}, include: exploitationInclude
  })
  if (targets.length !== ids.length || targets.some(target => !target.usageId
    || (target.startDate && target.startDate.toISOString().slice(0, 10) > effectiveDate)
    || (target.endDate && target.endDate.toISOString().slice(0, 10) < effectiveDate))) {
    throw createHttpError(400, 'Toutes les exploitations doivent être actives, avec un usage renseigné, à la date d’effet.')
  }
  return targets
}

export async function updateMeterAllocationSettings({user, meterId, exploitationId, body}, {client = prisma} = {}) {
  assertMeterAllocationAdmin(user)
  const payload = validateMeterAllocationEdit(body)
  return client.$transaction(async tx => {
    await lockMeter(tx, meterId)
    const state = await loadState(tx, {meterId, exploitationId, streamId: payload.streamId})
    const current = serializeState(state)
    if (payload.expectedVersion !== current.expectedVersion) throw createHttpError(409, 'La répartition a changé. Rechargez-la avant d’enregistrer.')
    if (payload.effectiveDate < current.minEffectiveDate) throw createHttpError(400, `La date d’effet doit être au moins le ${current.minEffectiveDate}.`)
    const effectiveAt = meterBusinessDateBoundary(payload.effectiveDate)
    const currentKeys = new Set((Array.isArray(state.stream.allocationSnapshot) ? state.stream.allocationSnapshot : []).map(row => row.key))
    if (payload.allocations.some(row => row.key && !currentKeys.has(row.key))) throw createHttpError(400, 'Une affectation ne fait pas partie de cette répartition.')
    const targets = await validateTargets(tx, payload.allocations, payload.effectiveDate)
    const pointIds = [...new Set([...state.allocations.map(allocation => allocation.exploitation.pointPrelevementId), ...targets.map(target => target.pointPrelevementId)])].sort()
    for (const pointId of pointIds) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('volumes-from-index'), hashtext(${pointId}))`
    const audit = {actorUserId: user.id, reason: payload.reason, recordedAt: new Date().toISOString(), effectiveDate: payload.effectiveDate, previousVersion: payload.expectedVersion}
    const desired = payload.allocations.map(row => {
      const previous = state.allocations.find(allocation => allocation.sourceId === row.key)
      const retained = previous && previous.exploitationId === row.exploitationId
      return {...row, key: retained || (!row.exploitationId && row.key) ? row.key : `manual:${randomUUID()}`,
        allocation: retained ? previous : null, previousAllocationId: previous?.id ?? null}
    })
    const snapshot = desired.map(row => ({key: row.key, percentage: row.percentage, inScope: row.exploitationId !== null}))
    validateAllocationSnapshot(snapshot, true)
    // Close the old effective periods; their identities, shares, snapshots and contributions stay intact.
    for (const allocation of state.allocations) {
      for (const version of allocation.versions.filter(version => version.enabled && (!version.endDate || version.endDate > effectiveAt))) {
        await tx.meterAllocationVersion.update({where: {id: version.id}, data: {endDate: effectiveAt}})
      }
    }
    for (const row of desired.filter(row => row.exploitationId)) {
      const allocation = row.allocation ?? await tx.meterAllocation.create({data: {
        sourceId: row.key, provider: state.stream.provider, scope: state.stream.scope, compteurId: meterId,
        exploitationId: row.exploitationId, metadata: {manualAllocation: true, previousAllocationId: row.previousAllocationId, ...audit}
      }})
      const latestVersion = row.allocation?.versions.at(-1)?.version ?? 0
      await tx.meterAllocationVersion.create({data: {allocationId: allocation.id, version: latestVersion + 1,
        percentage: row.percentage, enabled: true, additive: row.additive, startDate: effectiveAt,
        metadata: {allocationSnapshot: snapshot, allocationSnapshotValidated: true, preserveOrdinary: true, allocationEdit: audit}}})
    }
    const stream = await tx.meterStream.update({where: {id: state.stream.id}, data: {allocationSnapshot: snapshot, allocationSnapshotValidated: true}})
    const recalculation = await reprocessMeterStreamInTransaction(tx, stream, {preserveOrdinary: true})
    await tx.meterStream.update({where: {id: stream.id}, data: {lastIssue: recalculation.issues.join(',') || null}})
    return {...serializeState(await loadState(tx, {meterId, exploitationId, streamId: stream.id})), recalculation}
  }, {timeout: 120_000, maxWait: 20_000})
}
