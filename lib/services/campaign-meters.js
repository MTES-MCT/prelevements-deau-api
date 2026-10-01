/* eslint-disable no-await-in-loop -- Resolve meter identities and optional serial numbers inside the submission transaction. */
import createHttpError from 'http-errors'
import {meterHash} from './meter-core.js'
import {CAMPAIGN_MANUAL_PROVIDER} from './campaign-readings.js'
import {lockMeter} from './meter-publication.js'

const serialKey = value => value?.trim().toLocaleUpperCase('fr') || null

async function writeMeter(operation) {
  try {
    return await operation()
  } catch (error) {
    if (error.code === 'P2002') throw createHttpError(409, 'Ce numéro est déjà attribué à un autre compteur.')
    throw error
  }
}

// Reconstruct only the identities of an exact replay from the saved response.
// Anonymous new rows never use a global lookup, nor a guessed meter allocation.
export function campaignSubmissionHash(data, previousData = null) {
  const previous = previousData?.meters ?? []
  return meterHash({...data, meters: data.meters.map((meter, index) => {
    const serialNumber = serialKey(meter.serialNumber)
    const saved = meter.compteurId
      ? previous.find(row => row.compteurId === meter.compteurId)
      : serialNumber
        ? previous.find(row => serialKey(row.serialNumber) === serialNumber)
        : (!serialKey(previous[index]?.serialNumber) ? previous[index] : null)
    return {...meter, compteurId: meter.compteurId ?? saved?.compteurId ?? null,
      serialNumber: serialNumber ?? (meter.compteurId ? serialKey(saved?.serialNumber) : null)}
  })})
}

async function completeMeterNumber(tx, record, serialNumber, matches) {
  if (!record || !serialNumber || record.serialNumber) return record
  if (matches.some(match => match.id !== record.id)) throw createHttpError(409, 'Ce numéro est déjà attribué à un autre compteur.')
  await lockMeter(tx, record.id)
  const updated = await writeMeter(() => tx.compteur.updateMany({where: {id: record.id, OR: [{serialNumber: null}, {serialNumber: ''}]}, data: {serialNumber}}))
  if (updated.count !== 1) throw createHttpError(409, 'Le compteur a changé. Rechargez le formulaire avant de réessayer.')
  return {...record, serialNumber}
}

async function findCampaignMeter(tx, meter, authorizedIds, serialNumber) {
  if (meter.compteurId && !authorizedIds.has(meter.compteurId)) {
    throw createHttpError(403, 'Ce compteur n’appartient pas à cette réponse.')
  }
  if (serialNumber) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('collection-meter-serial'), hashtext(${serialKey(serialNumber)}))`
  const matches = serialNumber ? await tx.compteur.findMany({where: {serialNumber: {equals: serialNumber, mode: 'insensitive'}}, take: 2}) : []
  if (matches.length > 1 || matches[0]?.deletedAt) throw createHttpError(409, 'Ce numéro de compteur doit être vérifié par un administrateur.')
  const record = meter.compteurId ? await tx.compteur.findUnique({where: {id: meter.compteurId}}) : matches[0]
  if (meter.compteurId && (!record || record.deletedAt || (serialNumber && record.serialNumber && serialKey(record.serialNumber) !== serialKey(serialNumber)))) {
    throw createHttpError(409, 'Le numéro du compteur connu ne peut pas être modifié dans ce formulaire.')
  }
  return completeMeterNumber(tx, record, serialNumber, matches)
}

export async function resolveCampaignMeters(tx, response, data, {actorId = response.preleveurUserId} = {}) {
  const links = await tx.meterAllocation.findMany({where: {exploitationId: response.exploitationId}, include: {compteur: true}})
  const requiredIds = new Set(links.filter(link => !link.compteur.deletedAt).map(link => link.compteurId))
  const authorizedIds = new Set([...requiredIds, ...(response.submittedData?.meters ?? []).map(meter => meter.compteurId)])
  const resolved = []
  for (const meter of data.meters) {
    const serialNumber = meter.serialNumber?.trim() || null
    let record = await findCampaignMeter(tx, meter, authorizedIds, serialNumber)
    if (!record) {
      record = await writeMeter(() => tx.compteur.create({data: {serialNumber}}))
      await tx.meterAllocation.create({data: {
        sourceId: `collection:${response.campaignId}:${response.exploitationId}:${record.id}`,
        provider: CAMPAIGN_MANUAL_PROVIDER, scope: response.campaignId,
        compteurId: record.id, exploitationId: response.exploitationId,
        metadata: {collectionCampaignId: response.campaignId, declaredBy: actorId},
        versions: {create: {version: 1, enabled: false}}
      }})
    }
    resolved.push({...meter, compteurId: record.id, serialNumber: record.serialNumber})
  }
  const ids = new Set(resolved.map(meter => meter.compteurId))
  if (ids.size !== resolved.length) throw createHttpError(400, 'Un même compteur ne peut apparaître deux fois dans le formulaire.')
  if ([...requiredIds].some(id => !ids.has(id))) throw createHttpError(400, 'Tous les compteurs connus de cette exploitation doivent être renseignés.')
  return {...data, meters: resolved}
}
