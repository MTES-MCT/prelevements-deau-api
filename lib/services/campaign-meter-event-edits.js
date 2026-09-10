import {createHash} from 'node:crypto'
import createError from 'http-errors'
import {campaignMeterEventError, campaignMeterEventIssue} from '../util/campaign-meter-issues.js'

const eventKey = event => `${event.targetId}:${event.previousCompteurId}:${event.at}`
const meterKey = (targetId, compteurId) => `${targetId}:${compteurId}`
const staleEvent = () => createError(409, 'Ce changement de compteur a été modifié. Rechargez le brouillon avant de réessayer.')
const sameMeter = (left, right) => Boolean(left) === Boolean(right)
  && (left?.serialNumber ?? null) === (right?.serialNumber ?? null)
  && (left?.identifier ?? null) === (right?.identifier ?? null)
const nextIdentity = event => event.type === 'RESET' ? event.previousCompteurId : (event.nextCompteurId ?? null)
const sameIdentity = (left, right) => eventKey(left) === eventKey(right) && left.type === right.type
  && sameMeter(left.nextMeter, right.nextMeter) && nextIdentity(left) === nextIdentity(right)

export function pendingCampaignMeterId(event) {
  const digest = createHash('sha256').update(JSON.stringify([
    'campaign-response-meter',
    event.targetId,
    event.previousCompteurId,
    event.at,
    event.nextMeter.serialNumber ?? null,
    event.nextMeter.identifier ?? null
  ])).digest('hex').slice(0, 32)
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20)}`
}

function editOrigin(event, previousByKey) {
  const marker = event.previousEvent
  if (!marker) {
    return {event, original: event}
  }

  const key = eventKey({...marker, targetId: event.targetId})
  const saved = previousByKey.get(key)
  if (saved && (!marker.nextMeter || sameMeter(marker.nextMeter, saved.nextMeter))) {
    return {event, original: saved, saved}
  }

  // Une saisie faite pendant le premier enregistrement peut encore transporter
  // l'ancien marqueur et les anciens UUID virtuels. Son identité finale sera
  // vérifiée contre le brouillon déjà normalisé avant d'accepter ce rejeu.
  return {event, original: {...event, ...marker, targetId: event.targetId,
    ...(marker.nextMeter ? {type: 'REPLACEMENT', nextCompteurId: undefined} : {})}}
}

function assertEditableIdentity(node, event, targets) {
  const {original} = node
  const nextId = original.nextMeter ? pendingCampaignMeterId(original) : original.nextCompteurId
  if (original.nextMeter && targets.get(event.targetId).meters.some(meter => !meter.pending && meter.compteurId === nextId)
    && (!event.nextMeter || pendingCampaignMeterId(event) !== nextId)) {
    throw createError(400, 'Ce compteur est déjà enregistré. Son identification ne peut pas être modifiée depuis ce changement.')
  }

  if (original.type === 'REPLACEMENT' && !original.nextMeter && original.nextCompteurId && event.nextMeter) {
    throw createError(400, 'Ce compteur est déjà référencé. Modifiez seulement la date, les index ou le motif du changement.')
  }

  return nextId
}

function assertSafeEdit(node, event, {previousEvents, readings, byTarget}) {
  const {original} = node
  if (!node.saved && !previousEvents.some(saved => sameIdentity(saved, event))) {
    throw staleEvent()
  }

  const nextId = assertEditableIdentity(node, event, byTarget)
  if (!node.saved) {
    // L'identité et sa date ont déjà été acceptées. Une saisie ultérieure est
    // contrôlée sur cette nouvelle phase, pas sur celle qui a été remplacée.
    return
  }

  const ids = new Set([original.previousCompteurId, nextId].filter(id => id !== undefined))
  const related = readings.filter(reading => reading.targetId === event.targetId && ids.has(reading.compteurId))
  if (original.at !== event.at) {
    const [start, end] = [original.at, event.at].sort()
    if (related.some(reading => reading.readingDate >= start && reading.readingDate <= end)) {
      const message = 'Cette date déplacerait des relevés déjà saisis d’un côté à l’autre du changement. Corrigez d’abord les relevés concernés.'
      throw campaignMeterEventError([campaignMeterEventIssue(event, 'METER_EVENT_CROSSES_READING', message, {previousAt: original.at})])
    }
  }

  const identityChanged = original.type !== event.type || original.previousCompteurId !== node.event.previousCompteurId
    || Boolean(original.nextMeter) !== Boolean(event.nextMeter)
    || (!original.nextMeter && nextIdentity(original) !== nextIdentity(event))
  if (identityChanged && (related.some(reading => reading.readingDate >= original.at)
    || previousEvents.some(other => other !== node.saved && other.targetId === event.targetId && nextId !== undefined
      && (other.previousCompteurId === nextId || other.nextCompteurId === nextId)))) {
    throw createError(400, 'Des relevés ou d’autres changements dépendent de ce compteur. Corrigez-les avant de modifier le type de changement ou les compteurs concernés.')
  }
}

// L'édition est explicite, bornée au brouillon et au point autorisé. Seules les
// identités virtuelles changent ; aucune valeur ni référence source n'est créée.
function pendingReplacements(nodes) {
  const creators = new Map()
  for (const node of nodes.filter(node => node.event.nextMeter)) {
    node.oldId = pendingCampaignMeterId(node.original.nextMeter ? node.original : node.event)
    const key = meterKey(node.event.targetId, node.oldId)
    if (creators.has(key)) {
      throw staleEvent()
    }

    creators.set(key, node)
  }

  const queue = []
  for (const node of creators.values()) {
    const dependency = creators.get(meterKey(node.event.targetId, node.event.previousCompteurId))
    if (dependency) {
      dependency.dependents ??= []
      dependency.dependents.push(node)
    } else {
      queue.push(node)
    }
  }

  const replacements = new Map()
  const resolve = (targetId, id) => replacements.get(meterKey(targetId, id)) ?? id
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]
    const event = {...node.event, previousCompteurId: resolve(node.event.targetId, node.event.previousCompteurId)}
    replacements.set(meterKey(event.targetId, node.oldId), pendingCampaignMeterId(event))
    queue.push(...(node.dependents ?? []))
  }

  if (queue.length !== creators.size) {
    throw createError(400, 'Les changements de compteur doivent former une suite chronologique sans boucle.')
  }

  return resolve
}

export function reconcileCampaignMeterEventEdits(targets, draft, previousDraft) {
  const events = draft?.meterEvents ?? []
  if (!events.some(event => event.previousEvent)) {
    return draft
  }

  const byTarget = new Map(targets.map(target => [target.id, target]))
  const previousEvents = previousDraft?.meterEvents ?? []
  const previousByKey = new Map(previousEvents.map(event => [eventKey(event), event]))
  const editedKeys = new Set()
  const nodes = events.map(event => {
    if (event.previousEvent) {
      if (!byTarget.has(event.targetId)) {
        throw createError(403, 'L’événement de compteur ne correspond pas à votre périmètre.')
      }

      const key = eventKey({...event.previousEvent, targetId: event.targetId})
      if (editedKeys.has(key)) {
        throw staleEvent()
      }

      editedKeys.add(key)
    }

    return editOrigin(event, previousByKey)
  })
  const resolve = pendingReplacements(nodes)
  const readings = [...(previousDraft?.readings ?? []), ...(draft?.readings ?? [])]
  const meterEvents = nodes.map(node => {
    const {previousEvent, ...raw} = node.event
    const event = {...raw, previousCompteurId: resolve(raw.targetId, raw.previousCompteurId),
      ...(raw.nextCompteurId ? {nextCompteurId: resolve(raw.targetId, raw.nextCompteurId)} : {})}
    if (previousEvent) {
      assertSafeEdit(node, event, {previousEvents, readings, byTarget})
    }

    return event
  })
  return {...draft, meterEvents, readings: (draft?.readings ?? []).map(reading => ({...reading, compteurId: resolve(reading.targetId, reading.compteurId)}))}
}
