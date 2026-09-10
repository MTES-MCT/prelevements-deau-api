import createError from 'http-errors'
import {campaignMeterlessPeriod, isCampaignMeterlessDate} from './campaign-meter-scope.js'
import {pendingCampaignMeterId, reconcileCampaignMeterEventEdits} from './campaign-meter-event-edits.js'

const day = value => value ? new Date(value).toISOString().slice(0, 10) : null
const unavailableMeter = () => createError(409, 'Ce nouveau compteur ne peut pas être enregistré. Vérifiez son identification ou contactez votre collecteur.')

function withoutReassignmentConfirmation(event) {
  const {reassignFollowingReadings, ...result} = event
  return result
}

function reassignConfirmedReadings(targets, readings, meterEvents, campaign) {
  const byTarget = new Map(targets.map(target => [target.id, target]))
  const assignments = new Map()
  for (const event of meterEvents.filter(event => event.reassignFollowingReadings === true)) {
    const target = byTarget.get(event.targetId)
    const nextMeter = target?.meters.find(meter => meter.compteurId === event.nextCompteurId)
    if (event.type !== 'REPLACEMENT' || event.previousCompteurId !== null) {
      throw createError(400, 'Seul le remplacement d’un compteur non référencé permet de rattacher ces relevés.')
    }

    if (!target || !nextMeter || !isCampaignMeterlessDate(campaignMeterlessPeriod(target, {campaign, meterEvents}), event.at)) {
      throw createError(403, 'Le rattachement de ces relevés ne correspond pas à votre périmètre ou à la période du compteur.')
    }

    const ends = [nextMeter.endDate && day(nextMeter.endDate), ...meterEvents.filter(next => next.targetId === target.id
      && next.type === 'REPLACEMENT' && next.previousCompteurId === event.nextCompteurId).map(next => next.at)].filter(Boolean).sort()
    assignments.set(target.id, {at: event.at, endDate: ends[0] ?? null, compteurId: event.nextCompteurId})
  }

  return readings.map(reading => {
    const assignment = assignments.get(reading.targetId)
    return assignment && reading.compteurId === null && reading.readingDate > assignment.at
      && (!assignment.endDate || reading.readingDate <= assignment.endDate)
      ? {...reading, compteurId: assignment.compteurId, meterConfirmed: true}
      : reading
  })
}

// Les fiches restent virtuelles dans le brouillon : annuler un remplacement
// n’ajoute ni compteur ni affectation à l’inventaire partagé.
export function prepareCampaignResponseMeters(targets, draft, {campaign, previousDraft} = {}) {
  draft = reconcileCampaignMeterEventEdits(targets, draft, previousDraft)
  const scopedTargets = targets.map(target => ({...target, meters: [...target.meters]}))
  const byTarget = new Map(scopedTargets.map(target => [target.id, target]))
  const meterEvents = (draft?.meterEvents ?? []).map(event => {
    if (!event.nextMeter) {
      return event
    }

    const target = byTarget.get(event.targetId)
    if (!target) {
      throw createError(403, 'L’événement de compteur ne correspond pas à votre périmètre.')
    }

    const compteurId = pendingCampaignMeterId(event)
    if (!target.meters.some(meter => meter.compteurId === compteurId)) {
      target.meters.push({
        id: compteurId, associationId: null, compteurId, pending: true,
        pendingEvent: {previousCompteurId: event.previousCompteurId, at: event.at},
        compteur: {id: compteurId, ...event.nextMeter}, startDate: event.at, endDate: null
      })
    }

    const {nextMeter, ...normalizedEvent} = event
    return {...normalizedEvent, nextCompteurId: compteurId}
  })
  // Le rattachement est une action explicite et consommée une seule fois. Les
  // relevés du jour du changement restent du côté de l’ancien compteur.
  const readings = reassignConfirmedReadings(scopedTargets, draft?.readings ?? [], meterEvents, campaign)
  return {targets: scopedTargets.map(target => {
    const meterless = campaignMeterlessPeriod(target, {campaign, meterEvents, includePending: false})
    return {...target, meterlessInitial: Boolean(meterless), meterlessEndDate: meterless?.endDate ?? null}
  }), draft: {...draft, readings, meterEvents: meterEvents.map(event => withoutReassignmentConfirmation(event))},
  draftForSave: {...draft, readings, meterEvents: (draft?.meterEvents ?? []).map(event => withoutReassignmentConfirmation(event))}}
}

async function createOrReuseMeter(target, meter, client) {
  const {serialNumber, identifier} = meter.compteur
  // Ne jamais rechercher, révéler ou rattacher un compteur d’un autre point.
  const candidates = await client.compteur.findMany({where: {
    deletedAt: null, points: {some: {pointPrelevementId: target.pointPrelevementId}},
    OR: [...(serialNumber ? [{serialNumber}] : []), ...(identifier ? [{identifier}] : [])]
  }, take: 2})
  if (candidates.length > 1) {
    throw unavailableMeter()
  }

  let compteur = candidates[0]
  if (compteur && ((serialNumber && compteur.serialNumber !== serialNumber) || (identifier && compteur.identifier !== identifier))) {
    throw unavailableMeter()
  }

  compteur ||= await client.compteur.create({data: {id: meter.compteurId, serialNumber, identifier}})

  const startDate = new Date(`${meter.startDate}T00:00:00.000Z`)
  const bindings = await client.compteurPointPrelevement.findMany({where: {
    compteurId: compteur.id, OR: [{endDate: null}, {endDate: {gte: startDate}}]
  }})
  let association = bindings.find(binding => binding.pointPrelevementId === target.pointPrelevementId && day(binding.startDate) === meter.startDate && !binding.endDate)
  if (bindings.some(binding => binding.id !== association?.id)) {
    throw unavailableMeter()
  }

  association ||= await client.compteurPointPrelevement.create({data: {compteurId: compteur.id, pointPrelevementId: target.pointPrelevementId, startDate, endDate: null}})

  const campaignMeter = await client.campaignTargetMeter.upsert({
    where: {targetId_associationId: {targetId: target.id, associationId: association.id}},
    create: {targetId: target.id, associationId: association.id, compteurId: compteur.id, startDate, endDate: null}, update: {}
  })
  return {...campaignMeter, compteur}
}

// À appeler uniquement après autorisation et contrôle de version, dans la
// transaction de transmission : tout échec annule aussi les nouvelles fiches.
export async function publishCampaignResponseMeters(targets, draft, client) {
  const replacements = new Map()
  const resultTargets = []
  /* eslint-disable no-await-in-loop -- Les affectations et la publication partagent la même transaction. */
  for (const target of targets) {
    const meters = []
    for (const meter of target.meters) {
      if (meter.pending) {
        const persisted = await createOrReuseMeter(target, meter, client)
        replacements.set(meter.compteurId, persisted.compteurId)
        meters.push(persisted)
      } else {
        meters.push(meter)
      }
    }

    resultTargets.push({...target, meters: [...new Map(meters.map(meter => [meter.associationId ?? meter.id ?? meter.compteurId, meter])).values()]})
  }
  /* eslint-enable no-await-in-loop */

  const resolveId = id => replacements.get(id) ?? id
  return {targets: resultTargets, draft: {
    ...draft,
    readings: (draft.readings ?? []).map(reading => ({...reading, compteurId: resolveId(reading.compteurId)})),
    meterEvents: (draft.meterEvents ?? []).map(event => ({
      ...event,
      previousCompteurId: resolveId(event.previousCompteurId),
      ...(event.nextCompteurId ? {nextCompteurId: resolveId(event.nextCompteurId)} : {})
    }))
  }}
}
