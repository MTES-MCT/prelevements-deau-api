import {pendingCampaignMeterId} from '../services/campaign-meter-event-edits.js'
import {campaignMeterlessPeriod, isCampaignMeterlessDate} from '../services/campaign-meter-scope.js'
import {campaignMeterEventIssue} from '../util/campaign-meter-issues.js'

const day = value => (value instanceof Date ? value.toISOString() : value).slice(0, 10)
const dateLabel = value => value.split('-').reverse().join('/')
const meterKey = (targetId, compteurId) => `${targetId}:${compteurId}`
const nextId = event => event.nextMeter ? pendingCampaignMeterId(event) : event.nextCompteurId
const atBinding = (meter, date) => (!meter.startDate || date >= day(meter.startDate)) && (!meter.endDate || date <= day(meter.endDate))

function transitions(events) {
  const incoming = new Map()
  const outgoing = new Map()
  for (const event of events.filter(event => event.type === 'REPLACEMENT')) {
    for (const [map, id] of [[outgoing, event.previousCompteurId], [incoming, nextId(event)]]) {
      const key = meterKey(event.targetId, id)
      const list = map.get(key) ?? []
      list.push(event)
      map.set(key, list)
    }
  }

  return {incoming, outgoing}
}

function bindingIssues(event, target) {
  const result = []
  for (const [id, role] of [[event.previousCompteurId, 'ancien'], ...(event.type === 'REPLACEMENT' && !event.nextMeter ? [[event.nextCompteurId, 'nouveau']] : [])]) {
    const bindings = target.meters.filter(meter => meter.compteurId === id)
    if (bindings.length > 0 && !bindings.some(meter => atBinding(meter, event.at))) {
      const code = role === 'ancien' ? 'METER_EVENT_OUTSIDE_PREVIOUS_BINDING' : 'METER_EVENT_OUTSIDE_NEXT_BINDING'
      const message = `La date du changement doit appartenir à une période d’utilisation ${role === 'ancien' ? 'de l’ancien' : 'du nouveau'} compteur.`
      result.push(campaignMeterEventIssue(event, code, message))
    }
  }

  return result
}

function chronologyIssues(event, {incoming, outgoing}) {
  const result = []
  const entries = incoming.get(meterKey(event.targetId, event.previousCompteurId)) ?? []
  const exits = outgoing.get(meterKey(event.targetId, event.previousCompteurId)) ?? []
  if (event.type === 'REPLACEMENT') {
    if (exits.length > 1) {
      result.push(campaignMeterEventIssue(event, 'MULTIPLE_METER_REPLACEMENTS', 'Ce compteur a déjà un remplacement déclaré. Modifiez ce remplacement au lieu d’en ajouter un autre.'))
    }

    if ((incoming.get(meterKey(event.targetId, nextId(event)))?.length ?? 0) > 1) {
      result.push(campaignMeterEventIssue(event, 'METER_ENTERED_MULTIPLE_TIMES', 'Ce nouveau compteur est déjà utilisé dans un autre remplacement.'))
    }
  }

  const entry = entries.find(other => event.at <= other.at)
  if (entry) {
    const message = `Ce compteur entre en service le ${dateLabel(entry.at)}. Un autre changement sur ce compteur doit être postérieur à cette date.`
    result.push(campaignMeterEventIssue(event, 'METER_EVENT_BEFORE_ENTRY', message, {relatedAt: entry.at}))
  }

  const exit = exits.find(other => other !== event && event.at > other.at)
  if (exit) {
    result.push(campaignMeterEventIssue(event, 'METER_EVENT_AFTER_EXIT', `Ce compteur a été remplacé le ${dateLabel(exit.at)}. Le changement doit être antérieur à cette date.`, {relatedAt: exit.at}))
  }

  return result
}

// Contrôles structurels seulement : les index et relevés encore absents ne
// rendent pas le brouillon invalide. Les événements sont triés logiquement,
// jamais selon l'ordre d'affichage ou de saisie des cartes.
export function campaignMeterEventDateIssues(events, {campaign, targets, periods = campaign?.periods ?? []}) {
  if (events.length === 0) {
    return []
  }

  const byTarget = new Map(targets.map(target => [target.id, target]))
  const dates = [...(campaign?.indexDates ?? []), ...periods.filter(period => period.kind === 'INDEX')
    .flatMap(period => [period.startReadingDate, period.endReadingDate])].filter(Boolean).map(value => day(value)).sort()
  const meterless = new Map(targets.map(target => [target.id, campaignMeterlessPeriod(target, {campaign, periods, meterEvents: events})]))
  const transitionMap = transitions(events)
  const issues = []
  for (const event of events) {
    const target = byTarget.get(event.targetId)
    if (!target) {
      continue
    }

    if (dates.length > 0 && (event.at < dates[0] || event.at > dates.at(-1))) {
      issues.push(campaignMeterEventIssue(event, 'METER_EVENT_OUTSIDE_CAMPAIGN', `La date du changement doit être comprise entre le ${dateLabel(dates[0])} et le ${dateLabel(dates.at(-1))}.`))
    }

    if (event.previousCompteurId === null && meterless.get(target.id) && !isCampaignMeterlessDate(meterless.get(target.id), event.at)) {
      issues.push(campaignMeterEventIssue(event, 'METER_EVENT_OUTSIDE_PREVIOUS_BINDING', 'La date du changement doit appartenir à la période d’utilisation de l’ancien compteur.'))
    }

    issues.push(...bindingIssues(event, target), ...chronologyIssues(event, transitionMap))
  }

  return issues
}
