import createHttpError from 'http-errors'
import Joi from 'joi'
import {prisma} from '../../db/prisma.js'
import {getExploitationRight} from '../services/resource-permissions.js'
import {getMeterStreamContext, ingestMeterBatch} from '../services/meter-ingestion.js'
import {meterReadingsQuerySchema} from '../validation/meters.js'
import {getMeterAllocationSettings, searchMeterAllocationTargets, updateMeterAllocationSettings} from '../services/meter-allocation-editing.js'

function actor(req) {
  // ACCESS tokens expose a pseudo-user whose id belongs to ServiceAccount.
  return req.serviceAccount ? {serviceAccountId: req.serviceAccount.id} : {user: req.user}
}

export async function getMeterStreamContextHandler(req, res) {
  res.send(await getMeterStreamContext(req.query, actor(req)))
}

export async function ingestMeterBatchHandler(req, res) {
  res.send(await ingestMeterBatch(req.body, actor(req)))
}

function validateId(value) {
  const {error} = Joi.string().uuid().required().validate(value)
  if (error) throw createHttpError(400, 'Identifiant invalide.')
  return value
}

export async function getExploitationMeterAllocationsHandler(req, res) {
  const exploitationId = validateId(req.params.exploitationId)
  const right = await getExploitationRight(req.user, exploitationId)
  if (!right.canRead) throw createHttpError(403, 'Vous ne pouvez pas consulter cette exploitation.')
  const allocations = await prisma.meterAllocation.findMany({
    where: {exploitationId},
    include: {compteur: {include: {meterStreams: true}}, versions: {orderBy: {version: 'desc'}}},
    orderBy: {id: 'asc'}
  })
  const now = new Date()
  const meterAllocations = allocations.map(allocation => {
    const stream = allocation.compteur.meterStreams.find(item => item.provider === allocation.provider && item.scope === allocation.scope)
    const currentVersion = allocation.versions.find(item => item.enabled && item.startDate && item.startDate <= now && (!item.endDate || item.endDate > now))
    const version = currentVersion ?? [...allocation.versions].sort((a, b) => new Date(b.startDate ?? 0) - new Date(a.startDate ?? 0))[0]
    const ended = !currentVersion && version?.endDate && version.endDate <= now
    const complete = Boolean(version?.enabled && version.startDate && version.percentage !== null && stream?.allocationSnapshotValidated)
    const state = !stream?.enabled ? 'DISABLED' : (stream.lastIssue ? 'ERROR' : (stream.lastSuccessAt ? 'SUCCESS' : 'PENDING'))
    return {
      id: allocation.id,
      compteur: {id: allocation.compteur.id, serialNumber: allocation.compteur.serialNumber},
      provider: allocation.provider,
      percentage: version?.percentage?.toString() ?? null,
      startDate: version?.startDate ?? null, endDate: version?.endDate ?? null,
      status: ended ? 'ENDED' : (!complete ? 'INCOMPLETE' : (stream?.enabled ? 'ACTIVE' : 'DISABLED')),
      sync: {available: Boolean(stream), streamId: stream?.id ?? null, state, lastSuccessAt: stream?.lastSuccessAt ?? null, lastReadingAt: stream?.lastReadingAt ?? null},
      // Sharing a point or a single beneficiary does not authorize the global
      // physical index. Complete-scope delegation requires a future explicit policy.
      capabilities: {canReadGlobalReadings: req.user?.role === 'ADMIN', canEditAllocations: req.user?.role === 'ADMIN' && Boolean(stream)}
    }
  })
  res.send({meterAllocations})
}

export async function getMeterAllocationSettingsHandler(req, res) {
  res.send(await getMeterAllocationSettings({user: req.user,
    meterId: validateId(req.params.meterId), exploitationId: validateId(req.params.exploitationId), streamId: validateId(req.query.streamId)}))
}

export async function updateMeterAllocationSettingsHandler(req, res) {
  if (req.serviceAccount) throw createHttpError(403, 'Une validation administrative est obligatoire.')
  res.send(await updateMeterAllocationSettings({user: req.user,
    meterId: validateId(req.params.meterId), exploitationId: validateId(req.params.exploitationId), body: req.body}))
}

export async function searchMeterAllocationTargetsHandler(req, res) {
  res.send(await searchMeterAllocationTargets({user: req.user, search: req.query.search}))
}

export async function getExploitationMeterReadingsHandler(req, res) {
  if (req.user?.role !== 'ADMIN') throw createHttpError(403, 'Les index physiques partagés sont réservés aux administrateurs.')
  const exploitationId = validateId(req.params.exploitationId)
  const compteurId = validateId(req.params.meterId)
  const {value: query, error} = meterReadingsQuerySchema.validate(req.query)
  if (error) throw createHttpError(400, error.message)
  const allocation = await prisma.meterAllocation.findFirst({where: {exploitationId, compteurId}, select: {id: true}})
  if (!allocation) throw createHttpError(404, 'Compteur introuvable pour cette exploitation.')
  if (query.cursor) {
    const cursor = await prisma.meterReading.findUnique({where: {id: query.cursor}, select: {compteurId: true}})
    if (cursor?.compteurId !== compteurId) throw createHttpError(400, 'Curseur invalide pour ce compteur.')
  }
  const readings = await prisma.meterReading.findMany({
    where: {compteurId}, include: {currentRevision: true}, orderBy: [{observedAt: 'desc'}, {id: 'desc'}],
    ...(query.cursor ? {cursor: {id: query.cursor}, skip: 1} : {}), take: query.limit + 1
  })
  const page = readings.slice(0, query.limit)
  res.send({
    items: page.map(reading => ({
      id: reading.id, observedAt: reading.observedAt, index: reading.currentRevision?.index?.toString() ?? null,
      quality: reading.currentRevision?.quality ?? null, origin: reading.currentRevision?.origin ?? null,
      admissible: reading.currentRevision?.admissible ?? false
    })),
    nextCursor: readings.length > query.limit ? page.at(-1).id : null
  })
}
