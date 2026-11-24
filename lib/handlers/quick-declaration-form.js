import createHttpError from 'http-errors'
import {getCoordsByPointIds} from '../models/point-prelevement.js'
import {resolveHistoricalQuickExploitation} from '../services/quick-declaration-series.js'
import {getWaterUseRootId} from '../services/sandre-water-uses.js'
import {getQuickDeclarationPointDisplayName, quickDeclarationExploitationWhere} from './declarations.js'

const day = date => date.toISOString().slice(0, 10)

function formSlot(row) {
  return {pointPrelevementId: row.pointPrelevementId, exploitationId: row.effectiveExploitationId ?? row.exploitationId,
    usageId: row.usageId, compteurId: row.compteurId ?? null}
}

async function eligibleComptages(client, user, declarantUserId, ids) {
  if (!ids.length) return []
  return client.declarantPointPrelevement.findMany({
    where: {...quickDeclarationExploitationWhere({declarantUserId, actorDeclarantUserId: user.role === 'ADMIN' ? undefined : user.id}),
      declarant: {declarantRole: 'PRELEVEUR', quickDeclarationEnabled: true}, id: {in: ids}},
    select: {id: true, countingCode: true, pointPrelevementId: true, pointPrelevement: {select: {name: true, usageName: true, flowType: true}}, usageId: true},
    orderBy: [{pointPrelevement: {name: 'asc'}}, {countingCode: 'asc'}, {id: 'asc'}]
  })
}

export async function submittedQuickForm(client, user, declarantUserId, entries, formExploitationIds) {
  const slots = new Map(entries.map(entry => [entry.exploitationId, formSlot(entry)]))
  if (formExploitationIds) {
    const requested = new Set(formExploitationIds)
    if (entries.some(entry => !requested.has(entry.exploitationId))) {
      throw createHttpError(400, 'Chaque comptage renseigné doit figurer dans le formulaire soumis.')
    }
    const empty = [...requested].filter(id => !slots.has(id))
    const allowed = await eligibleComptages(client, user, declarantUserId, empty)
    if (allowed.length !== empty.length) throw createHttpError(403, 'Un comptage du formulaire est hors de votre périmètre.')
    for (const row of allowed) slots.set(row.id, formSlot({...row, exploitationId: row.id}))
  }
  return [...slots.values()].sort((a,b) => a.exploitationId.localeCompare(b.exploitationId))
}

function matchesOriginalScope(scope, chunk) {
  return scope.some(row => row.pointPrelevementId === chunk.pointPrelevementId && row.exploitationId === chunk.exploitationId
    && (row.exploitationId || (row.minDate === day(chunk.minDate) && row.maxDate === day(chunk.maxDate))))
}

async function historicalSlots(client, declaration) {
  const revision = declaration.source.metadata.quickRevision && await client.quickDeclarationRevision.findUnique({
    where: {declarationId_revision: {declarationId: declaration.id, revision: 1}}, select: {before: true}
  })
  // The first audit predates all corrections. Never infer the original form from today's delegations.
  const chunks = revision ? declaration.source.chunks.filter(chunk => matchesOriginalScope(revision.before.scope ?? [], chunk)) : declaration.source.chunks
  const evidence = [...(revision?.before?.entries ?? []), ...chunks]
  const slots = new Map()
  for (const row of evidence) {
    const slot = formSlot(row)
    if (!slot.exploitationId && row.pointPrelevementId) {
      // eslint-disable-next-line no-await-in-loop -- Exact dated resolution is needed only for legacy rows without an exploitation.
      slot.exploitationId = await resolveHistoricalQuickExploitation(client, {declarantUserId: declaration.declarantUserId,
        pointPrelevementId: row.pointPrelevementId, periodStartDate: row.readingDate ?? row.periodStartDate ?? day(row.minDate),
        periodEndDate: row.readingDate ?? row.periodEndDate ?? day(row.maxDate)})
    }
    if (slot.exploitationId && slot.usageId) slots.set(JSON.stringify(slot), slot)
  }
  return [...slots.values()]
}

export async function getQuickForm(client, declaration) {
  const recorded = await client.quickDeclarationForm.findUnique({where: {declarationId: declaration.id}, select: {slots: true}})
  return recorded ? {slots: recorded.slots, recorded: true} : {slots: await historicalSlots(client, declaration), recorded: false}
}

export async function saveQuickForm(client, declarationId, current, draft) {
  if (current?.form.recorded) return
  const slots = current ? current.form.slots : draft.formSlots
  await client.quickDeclarationForm.create({data: {declarationId, slots}})
}

export async function getEmptyQuickEntries(client, user, current, requestedIds) {
  if (!current.entries.length) return []
  const requested = requestedIds && new Set(requestedIds)
  const active = new Set(current.entries.map(row => row.effectiveExploitationId ?? row.exploitationId))
  const ambiguousPoints = new Set(current.entries.filter(row => !row.exploitationId && !row.effectiveExploitationId).map(row => row.pointPrelevementId))
  const slots = new Map()
  for (const slot of current.form.slots) {
    if (requested && !requested.has(slot.exploitationId)) continue
    if (!active.has(slot.exploitationId) && !ambiguousPoints.has(slot.pointPrelevementId)) {
      // A legacy dossier can contain multiple meter/usage identities on one exploitation.
      // The empty input only identifies one exploitation; ambiguous identities cannot be recreated from it.
      slots.set(slot.exploitationId, slots.has(slot.exploitationId) ? null : slot)
    }
  }
  if (!slots.size) return []
  const allowed = await eligibleComptages(client, user, current.declaration.declarantUserId, [...slots.keys()])
  const eligible = allowed.filter(row => slots.get(row.id)?.pointPrelevementId === row.pointPrelevementId)
  const originals = eligible.map(row => slots.get(row.id))
  const usages = await client.sandreWaterUse.findMany({where: {id: {in: [...new Set(originals.map(row => row.usageId))]}},
    select: {id: true, label: true, kind: true, parentId: true}})
  const meterIds = [...new Set(originals.map(row => row.compteurId).filter(Boolean))]
  const meters = meterIds.length ? await client.compteur.findMany({where: {id: {in: meterIds}}, select: {id: true, serialNumber: true, identifier: true}}) : []
  const byUsage = new Map(usages.map(row => [row.id,row]))
  const byMeter = new Map(meters.map(row => [row.id,row.serialNumber ?? row.identifier]))
  return eligible.filter(row => byUsage.has(slots.get(row.id).usageId)).map(row => {
    const slot = slots.get(row.id)
    const usage = byUsage.get(slot.usageId)
    return {...slot, countingCode: row.countingCode, pointName: getQuickDeclarationPointDisplayName(row.pointPrelevement),
      compteurName: byMeter.get(slot.compteurId) ?? null, usageLabel: usage.label, flowType: row.pointPrelevement.flowType, rootUsageId: getWaterUseRootId(usage)}
  })
}

export async function getQuickFormMap(client, entries) {
  const points = new Map(entries.filter(row => row.pointPrelevementId).map(row => [row.pointPrelevementId, row.pointName]))
  const coordinates = await getCoordsByPointIds([...points.keys()], {client})
  return [...points].map(([id,name]) => ({id, pointPrelevementId: id, name, coordinates: coordinates.get(id) ?? null}))
}
