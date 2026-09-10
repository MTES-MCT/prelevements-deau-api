import {isDeepStrictEqual} from 'node:util'
import {prepareCampaignResponseMeters} from '../services/campaign-response-meters.js'
import {pendingCampaignMeterId} from '../services/campaign-meter-event-edits.js'
import {campaignMeterlessPeriod, isCampaignMeterlessDate} from '../services/campaign-meter-scope.js'
import {campaignMeterEventDateIssues} from './campaign-meter-events.js'

const meterKey = (targetId, compteurId) => `${targetId}:${compteurId}`
const readingKey = reading => `${reading.targetId}:${reading.compteurId}:${reading.readingDate}`
const day = value => (value instanceof Date ? value.toISOString() : value).slice(0, 10)
const normalizedEvent = event => event.type === 'RESET' ? {...event, nextCompteurId: event.previousCompteurId} : event

function removedEvents(before, after) {
  if (after.length >= before.length) {
    return null
  }

  const remaining = before.map(event => normalizedEvent(event))
  for (const event of after) {
    const index = remaining.findIndex(original => isDeepStrictEqual(original, normalizedEvent(event)))
    if (index === -1) {
      return null
    }

    remaining.splice(index, 1)
  }

  return remaining
}

function readingDestinations(removed, targets) {
  const inventory = new Set(targets.flatMap(target => target.meters.filter(meter => !meter.pending).map(meter => meterKey(target.id, meter.compteurId))))
  const destinations = new Map(removed.filter(event => event.type === 'REPLACEMENT' && event.nextMeter)
    .map(event => [meterKey(event.targetId, pendingCampaignMeterId(event)), event.previousCompteurId])
    .filter(([key]) => !inventory.has(key)))
  const resolved = new Map()
  return (targetId, compteurId) => {
    const visited = new Set()
    let current = compteurId
    while (destinations.has(meterKey(targetId, current))) {
      const key = meterKey(targetId, current)
      if (visited.has(key)) {
        return undefined
      }

      visited.add(key)
      if (resolved.has(key)) {
        current = resolved.get(key)
        break
      }

      current = destinations.get(key)
    }

    for (const key of visited) {
      resolved.set(key, current)
    }

    return current
  }
}

function withinDestination(reading, {campaign, targets, meterEvents}) {
  const target = targets.find(target => target.id === reading.targetId)
  if (!target) {
    return false
  }

  if (reading.compteurId === null) {
    return isCampaignMeterlessDate(campaignMeterlessPeriod(target, {campaign, meterEvents}), reading.readingDate)
  }

  const inBinding = target.meters.some(meter => meter.compteurId === reading.compteurId
    && (!meter.startDate || reading.readingDate >= day(meter.startDate))
    && (!meter.endDate || reading.readingDate <= day(meter.endDate)))
  return inBinding && meterEvents.filter(event => event.targetId === target.id && event.type === 'REPLACEMENT').every(event => {
    const nextId = event.nextMeter ? pendingCampaignMeterId(event) : event.nextCompteurId
    return (event.previousCompteurId !== reading.compteurId || reading.readingDate <= event.at)
      && (nextId !== reading.compteurId || reading.readingDate >= event.at)
  })
}

function sameReadings(before, after, removed, context) {
  if (before.length !== after.length) {
    return false
  }

  const resolve = readingDestinations(removed, context.targets)
  const expected = new Map()
  for (const original of before) {
    const compteurId = resolve(original.targetId, original.compteurId)
    const reading = {...original, compteurId}
    if (compteurId === undefined || (compteurId !== original.compteurId && !withinDestination(reading, context))) {
      return false
    }

    const key = readingKey(reading)
    if (expected.has(key)) {
      return false
    }

    expected.set(key, reading)
  }

  return after.every(reading => {
    const key = readingKey(reading)
    if (!isDeepStrictEqual(expected.get(key), reading)) {
      return false
    }

    expected.delete(key)
    return true
  }) && expected.size === 0
}

function noNewIssues(previousIssues, issues) {
  const remaining = [...previousIssues]
  return issues.every(issue => {
    const index = remaining.findIndex(previous => isDeepStrictEqual(previous, issue))
    if (index === -1) {
      return false
    }

    remaining.splice(index, 1)
    return true
  })
}

// Exception interne au seul enregistrement d'un brouillon déjà incohérent :
// retirer une carte ne doit pas exiger de réparer toutes les autres à la fois.
// Ni les éditions ordinaires ni la transmission n'utilisent cette exception.
export function allowsCampaignEventRemovalRepair(before, after, {campaign, targets, issues}) {
  if (!before || (before.comment ?? '') !== (after.comment ?? '')) {
    return false
  }

  const removed = removedEvents(before.meterEvents ?? [], after.meterEvents ?? [])
  if (!removed || !sameReadings(before.readings ?? [], after.readings ?? [], removed, {campaign, targets, meterEvents: after.meterEvents ?? []})) {
    return false
  }

  try {
    const original = prepareCampaignResponseMeters(targets.map(target => ({...target, meters: target.meters.filter(meter => !meter.pending)})), before, {campaign})
    const previousIssues = campaignMeterEventDateIssues(before.meterEvents ?? [], {campaign, targets: original.targets})
    return previousIssues.length > 0 && noNewIssues(previousIssues, issues)
  } catch {
    return false
  }
}
