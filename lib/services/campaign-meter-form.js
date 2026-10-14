import createHttpError from 'http-errors'
import {campaignSerialKey} from './campaign-meter-proposals.js'

const meterId = meter => meter.compteurId ?? meter.id
const byId = meters => new Map(meters.map(meter => [meterId(meter), meter]))

// Legacy answers can reference a meter before allocations existed. Only load
// explicitly claimed UUIDs with a real chunk on this exact exploitation.
export async function findClaimedCampaignMeters(client, response, excludeIds = []) {
  const excluded = new Set(excludeIds)
  const ids = [...new Set([...(response.draftData?.meters ?? []), ...(response.submittedData?.meters ?? [])]
    .map(row => row.compteurId).filter(id => id && !excluded.has(id)))]
  if (!ids.length) return []
  return client.compteur.findMany({where: {id: {in: ids}, deletedAt: null,
    chunks: {some: {exploitationId: response.exploitationId}}},
  select: {id: true, serialNumber: true, updatedAt: true, meterAllocations: {select: {exploitationId: true}}}})
}

function uniqueSerialMatch(meters, serialNumber) {
  const key = campaignSerialKey(serialNumber)
  if (!key) return null
  const matches = meters.filter(meter => campaignSerialKey(meter.serialNumber) === key)
  return matches.length === 1 ? matches[0] : null
}

function currentIdentity(row, meter, draftUpdatedAt) {
  // Completing an unnamed meter in a draft must survive a reload. A later
  // physical correction (including clearing the serial) takes precedence.
  const draftTime = draftUpdatedAt ? new Date(draftUpdatedAt).getTime() : NaN
  const meterTime = meter.updatedAt ? new Date(meter.updatedAt).getTime() : NaN
  const pendingSerial = !campaignSerialKey(meter.serialNumber) && draftTime >= meterTime
  return {...row, compteurId: meterId(meter), serialNumber: pendingSerial ? row.serialNumber ?? null : meter.serialNumber ?? null,
    expectedSerialNumber: meter.serialNumber ?? null}
}

// This is a form projection only. Never update the stored draft, submitted
// answer, source prefill or historical meter values when a serial is corrected.
export function reconcileCampaignMeterForm(data, meters, {draftUpdatedAt} = {}) {
  const result = structuredClone(data)
  if (!result || !meters.length) return result
  const known = byId(meters)
  const rows = result.meters ?? []
  const represented = new Set(rows.map(row => row.compteurId).filter(id => known.has(id)))
  const serialCounts = new Map()
  for (const row of rows.filter(row => !row.compteurId)) {
    const key = campaignSerialKey(row.serialNumber)
    if (key) serialCounts.set(key, (serialCounts.get(key) ?? 0) + 1)
  }
  result.meters = rows.map(row => {
    if (row.compteurId) return known.has(row.compteurId) ? currentIdentity(row, known.get(row.compteurId), draftUpdatedAt) : row
    const match = uniqueSerialMatch(meters, row.serialNumber)
    if (!match || represented.has(meterId(match)) || serialCounts.get(campaignSerialKey(row.serialNumber)) !== 1) return row
    represented.add(meterId(match))
    return currentIdentity(row, match)
  })
  for (const [id, meter] of known) {
    if (!represented.has(id)) result.meters.push(currentIdentity({offSeason: {}, season: {}}, meter))
  }
  return result
}

// Called before a draft write and before the exact-submission replay shortcut.
// A blank server serial with no token requires reloading: otherwise a stale
// page could silently restore a serial that the collector deliberately cleared.
export function validateCampaignMeterForm(data, meters) {
  const known = byId(meters)
  const represented = new Set()
  const result = {...data}
  if (Array.isArray(data.meters)) result.meters = data.meters.map(row => {
    const meter = row.compteurId ? known.get(row.compteurId) : uniqueSerialMatch(meters, row.serialNumber)
    if (meter) {
      const current = campaignSerialKey(meter.serialNumber)
      const supplied = campaignSerialKey(row.serialNumber)
      const expected = Object.hasOwn(row, 'expectedSerialNumber') ? campaignSerialKey(row.expectedSerialNumber) : supplied
      if (expected !== current || (current && supplied && supplied !== current)) {
        throw createHttpError(409, 'Le numéro d’un compteur a changé. Rechargez le formulaire avant d’enregistrer.')
      }
      represented.add(meterId(meter))
    }
    const {expectedSerialNumber, ...persisted} = row
    return persisted
  })
  if (Array.isArray(data.meters) && [...known.keys()].some(id => !represented.has(id))) {
    throw createHttpError(409, 'Les compteurs de cette exploitation ont changé. Rechargez le formulaire avant d’enregistrer.')
  }
  return result
}
