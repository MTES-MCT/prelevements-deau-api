/* eslint-disable no-await-in-loop -- Serial identities and physical meters are locked in a stable order inside the caller's transaction. */
import createHttpError from 'http-errors'
import {lockMeters} from './meter-publication.js'
import {CAMPAIGN_MANUAL_PROVIDER} from './campaign-readings.js'

export const COLLECTOR_METER_PROVIDER = 'collector-form'
const serialKey = value => value?.trim().toLocaleUpperCase('fr') || null
const meterSelect = {
  id: true, serialNumber: true, updatedAt: true, deletedAt: true,
  meterAllocations: {select: {exploitationId: true, provider: true}},
  meterStreams: {select: {provider: true}},
  externalReferences: {select: {id: true}},
  chunks: {select: {exploitationId: true, pointPrelevementId: true, preleveurUserId: true,
    source: {select: {apiImportId: true}}}}
}

function hasExploitationLink(meter, exploitationId) {
  return Boolean(meter && !meter.deletedAt && (meter.meterAllocations.some(link => link.exploitationId === exploitationId)
    || meter.chunks.some(chunk => chunk.exploitationId === exploitationId)))
}

export function collectorMeterCapabilities(meter, exploitation) {
  if (!hasExploitationLink(meter, exploitation.id)) return {canEditSerialNumber: false, reason: 'AMBIGUOUS_HISTORY'}
  if (meter.meterAllocations.some(link => link.exploitationId !== exploitation.id)
    || meter.chunks.some(chunk => chunk.exploitationId && chunk.exploitationId !== exploitation.id)) {
    return {canEditSerialNumber: false, reason: 'SHARED_METER'}
  }
  if (meter.externalReferences.length
    || meter.meterStreams.some(stream => stream.provider !== CAMPAIGN_MANUAL_PROVIDER)
    || meter.meterAllocations.some(link => ['willie', 'rives-et-eaux'].includes(link.provider))
    || meter.chunks.some(chunk => chunk.source?.apiImportId)) {
    return {canEditSerialNumber: false, reason: 'EXTERNAL_METER'}
  }
  if (meter.chunks.some(chunk => !chunk.exploitationId
    || (chunk.pointPrelevementId && chunk.pointPrelevementId !== exploitation.pointPrelevementId)
    || (chunk.preleveurUserId && chunk.preleveurUserId !== exploitation.declarantUserId))) {
    return {canEditSerialNumber: false, reason: 'AMBIGUOUS_HISTORY'}
  }
  return {canEditSerialNumber: true, reason: null}
}

export async function getCollectorExploitationMeters(client, exploitationId) {
  const exploitation = await client.declarantPointPrelevement.findUniqueOrThrow({where: {id: exploitationId},
    select: {id: true, pointPrelevementId: true, declarantUserId: true}})
  const meters = await client.compteur.findMany({where: {deletedAt: null, OR: [
    {meterAllocations: {some: {exploitationId}}}, {chunks: {some: {exploitationId}}}
  ]}, select: meterSelect, orderBy: {id: 'asc'}})
  return meters.map(meter => ({id: meter.id, serialNumber: meter.serialNumber, updatedAt: meter.updatedAt,
    capabilities: collectorMeterCapabilities(meter, exploitation)}))
}

function auditScopes(exploitation, compteurId) {
  return [
    {resourceType: 'POINT', resourceId: exploitation.pointPrelevementId},
    {resourceType: 'EXPLOITATION', resourceId: exploitation.id},
    {resourceType: 'DECLARANT', resourceId: exploitation.declarantUserId},
    {resourceType: 'COMPTEUR', resourceId: compteurId}
  ]
}

async function assertSerialAvailable(tx, serialNumber, id) {
  if (!serialNumber) return
  // Include soft-deleted meters and historical whitespace; never disclose the
  // conflicting identity or silently associate another beneficiary's meter.
  const matches = await tx.$queryRaw`
    SELECT id FROM "Compteur"
    WHERE upper(btrim("serialNumber")) = upper(${serialNumber})
      AND (${id ?? null}::uuid IS NULL OR id <> ${id ?? null}::uuid)
    LIMIT 1`
  if (matches.length) throw createHttpError(409, 'Ce numéro est déjà attribué à un autre compteur. Faites vérifier son rattachement par un administrateur.')
}

async function saveMeters(tx, {exploitation, meters = [], actorId}) {
  if (!meters.length) return {mutations: []}
  const ids = meters.filter(meter => meter.id).map(meter => meter.id)
  if (new Set(ids).size !== ids.length) throw createHttpError(400, 'Un même compteur ne peut apparaître deux fois.')
  const keys = meters.map(meter => serialKey(meter.serialNumber)).filter(Boolean)
  if (new Set(keys).size !== keys.length) throw createHttpError(400, 'Un même numéro de compteur ne peut apparaître deux fois.')
  // Match the campaign resolver's lock order and namespace.
  for (const key of [...new Set(keys)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('collection-meter-serial'), hashtext(${key}))`
  }
  await lockMeters(tx, ids)
  const mutations = []
  for (const input of [...meters].sort((a, b) => String(a.id ?? a.serialNumber).localeCompare(String(b.id ?? b.serialNumber)))) {
    const serialNumber = input.serialNumber?.trim() || null
    if (!input.id && !serialNumber) continue
    if (input.id) {
      const before = await tx.compteur.findUnique({where: {id: input.id}, select: meterSelect})
      if (!hasExploitationLink(before, exploitation.id)) {
        throw createHttpError(403, 'Ce compteur n’appartient pas à cette exploitation.')
      }
      if (!collectorMeterCapabilities(before, exploitation).canEditSerialNumber) {
        throw createHttpError(403, 'La correction de ce compteur doit être effectuée par un administrateur.')
      }
      if (!input.expectedUpdatedAt || new Date(before.updatedAt).getTime() !== new Date(input.expectedUpdatedAt).getTime()) {
        throw createHttpError(409, 'Le compteur a été modifié. Rechargez le formulaire avant de réessayer.')
      }
      if (before.serialNumber === serialNumber) continue
      await assertSerialAvailable(tx, serialNumber, input.id)
      const updated = await tx.compteur.updateMany({where: {id: input.id, updatedAt: before.updatedAt}, data: {serialNumber}})
      if (updated.count !== 1) throw createHttpError(409, 'Le compteur a été modifié. Rechargez le formulaire avant de réessayer.')
      const after = await tx.compteur.findUniqueOrThrow({where: {id: input.id}})
      mutations.push({operation: 'UPDATE', entityType: 'COMPTEUR', entityId: before.id,
        before: {id: before.id, serialNumber: before.serialNumber}, after,
        scopes: auditScopes(exploitation, before.id)})
    } else {
      await assertSerialAvailable(tx, serialNumber)
      const meter = await tx.compteur.create({data: {serialNumber}})
      const allocation = await tx.meterAllocation.create({data: {
        sourceId: `${COLLECTOR_METER_PROVIDER}:${exploitation.id}:${meter.id}`,
        provider: COLLECTOR_METER_PROVIDER, scope: exploitation.id,
        compteurId: meter.id, exploitationId: exploitation.id, metadata: {createdBy: actorId},
        versions: {create: {version: 1, enabled: false}}
      }, include: {versions: true}})
      const scopes = auditScopes(exploitation, meter.id)
      mutations.push({operation: 'CREATE', entityType: 'COMPTEUR', entityId: meter.id, after: meter, scopes},
        {operation: 'CREATE', entityType: 'METER_ALLOCATION', entityId: allocation.id, after: allocation, scopes})
    }
  }
  return {mutations}
}

export async function saveCollectorExploitationMeters(tx, options) {
  try {
    return await saveMeters(tx, options)
  } catch (error) {
    if (error.code === 'P2002') throw createHttpError(409, 'Ce numéro est déjà attribué à un autre compteur. Rechargez le formulaire.')
    throw error
  }
}
