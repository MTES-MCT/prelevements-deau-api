import Joi from 'joi'
import {campaignMeterEventDateIssues} from './campaign-meter-events.js'
import {allowsCampaignEventRemovalRepair} from './campaign-removal-repair.js'
import {campaignMeterEventError, campaignMeterEventIssue} from '../util/campaign-meter-issues.js'
import createError from 'http-errors'
import {campaignDeadlineDate, campaignLocalDate} from '../util/campaign-dates.js'
import {campaignMeterlessPeriod, isCampaignMeterlessDate} from '../services/campaign-meter-scope.js'

const id = Joi.string().guid({version: ['uuidv4', 'uuidv5', 'uuidv7']})
const day = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).custom((value, helpers) => {
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? helpers.error('any.invalid') : value
})
const decimal = Joi.string().pattern(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/)
const comment = Joi.string().max(20_000).allow('').default('')
const expectedVersion = Joi.number().integer().min(0).required()
const managers = Joi.array().items(Joi.object({userId: id.required(), role: Joi.string().valid('MANAGER', 'READER').required()})).max(100).unique('userId')
const period = Joi.object({
  id,
  kind: Joi.string().valid('INDEX', 'NEEDS').required(),
  position: Joi.number().integer().min(0).max(99).required(),
  label: Joi.string().trim().max(200).required(),
  startDate: day.required(),
  endDate: day.required(),
  startReadingDate: day.allow(null),
  endReadingDate: day.allow(null)
})

export const campaignConfigSchema = Joi.object({
  expectedVersion,
  name: Joi.string().trim().max(200).required(),
  year: Joi.number().integer().min(2000).max(2200).required(),
  ownerCollecteurUserId: id.required(),
  zoneId: id.required(),
  indexDates: Joi.array().items(day.required()).min(2).max(100).unique().required(),
  periods: Joi.array().items(period).min(2).max(100).required(),
  targets: Joi.array().items(Joi.object({exploitationId: id.required(), eligibilityConfirmed: Joi.boolean().required()})).max(5000).unique('exploitationId').required(),
  managers: managers.default([]),
  opensAt: Joi.date().iso().allow(null).default(null),
  closesAt: Joi.date().iso().allow(null).default(null),
  timezone: Joi.string().max(100).custom((value, helpers) => {
    try {
      new Intl.DateTimeFormat('fr-FR', {timeZone: value}).format()
      return value
    } catch {
      return helpers.error('any.invalid')
    }
  }).default('Europe/Paris'),
  reminderDays: Joi.array().items(Joi.number().integer().min(0).max(365)).unique().max(30).default([]),
  openingMessage: comment
})

export const campaignReadingSchema = Joi.object({
  targetId: id.required(),
  compteurId: id.allow(null).required(),
  readingDate: day.required(),
  value: decimal.allow(null, ''),
  missingReason: Joi.string().max(2000).allow(''),
  sourceChunkValueId: id,
  correctionOfChunkValueId: id,
  correctionReason: Joi.string().trim().max(2000),
  sourceValueUpdatedAt: Joi.string().isoDate(),
  meterConfirmed: Joi.boolean()
}).oxor('sourceChunkValueId', 'correctionOfChunkValueId').with('sourceChunkValueId', 'sourceValueUpdatedAt').with('correctionOfChunkValueId', ['sourceValueUpdatedAt', 'correctionReason'])

export const campaignIndexDraftSchema = Joi.object({
  comment,
  readings: Joi.array().items(campaignReadingSchema).max(50_000).default([]),
  meterEvents: Joi.array().items(Joi.object({
    targetId: id.required(),
    type: Joi.string().valid('RESET', 'REPLACEMENT').required(),
    at: day.required(),
    previousCompteurId: id.allow(null).required(),
    nextCompteurId: id.allow(null),
    nextMeter: Joi.object({serialNumber: Joi.string().trim().max(200), identifier: Joi.string().trim().max(200)}).or('serialNumber', 'identifier'),
    previousEvent: Joi.object({
      at: day.required(),
      previousCompteurId: id.allow(null).required(),
      nextMeter: Joi.object({serialNumber: Joi.string().trim().max(200), identifier: Joi.string().trim().max(200)}).or('serialNumber', 'identifier')
    }),
    reassignFollowingReadings: Joi.boolean(),
    previousIndex: decimal.allow(null).required(),
    nextIndex: decimal.allow(null).required(),
    previousMissingReason: Joi.string().trim().max(2000),
    nextMissingReason: Joi.string().trim().max(2000),
    reason: Joi.string().trim().max(2000).required()
  }).oxor('nextCompteurId', 'nextMeter')).max(5000).default([])
})

export const campaignNeedsDraftSchema = Joi.object({
  comment,
  needs: Joi.array().items(Joi.object({
    targetId: id.required(),
    periodId: id.required(),
    requestedFlow: decimal.allow(''),
    requestedVolume: decimal.allow('')
  })).max(50_000).default([])
})

export const campaignResponseRequestSchema = Joi.object({
  preleveurUserId: id.required(),
  expectedVersion,
  data: Joi.object().required()
})
export const campaignSubmitSchema = Joi.object({preleveurUserId: id.required(), expectedVersion, idempotencyKey: id.required()})
export const campaignReopenSchema = Joi.object({preleveurUserId: id.required(), expectedVersion, reason: Joi.string().trim().max(2000).required(), reopenUntil: Joi.date().iso()})
export const campaignVersionSchema = Joi.object({expectedVersion})
export const campaignManagersSchema = Joi.object({expectedVersion, managers: managers.required()})
export const campaignFollowupOverviewQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(20),
  cursor: id,
  q: Joi.string().trim().max(100).allow('').default(''),
  status: Joi.string().valid('all', 'missing', 'received', 'correction').default('all')
})
export const campaignFollowupResultsQuerySchema = Joi.object({preleveurUserId: id.required()})
export const campaignMeterSchema = Joi.object({
  expectedVersion,
  compteurId: id,
  serialNumber: Joi.string().trim().max(200),
  identifier: Joi.string().trim().max(200),
  startDate: day.allow(null).required(),
  endDate: day.allow(null).default(null)
})

export function validateCampaignValue(schema, input) {
  const {value, error} = schema.validate(input, {abortEarly: false})
  if (error) {
    throw createError(400, 'Les informations de campagne sont invalides.', {details: error.details.map(item => ({path: item.path.join('.'), type: item.type}))})
  }

  return value
}

function validateResponseSchedule(result) {
  if (result.opensAt && result.closesAt && result.opensAt >= result.closesAt) {
    throw createError(400, 'La clôture doit être postérieure à l’ouverture.')
  }

  if (result.closesAt && campaignDeadlineDate(result.closesAt, result.timezone) < result.indexDates.at(-1)) {
    throw createError(400, 'La date limite de réponse ne peut pas précéder le dernier relevé demandé.')
  }

  if (result.reminderDays.length > 0) {
    if (!result.closesAt) {
      throw createError(400, 'Définissez une date limite de réponse avant de programmer des relances.')
    }

    const deadline = Date.parse(campaignDeadlineDate(result.closesAt, result.timezone))
    const opening = result.opensAt && Date.parse(campaignLocalDate(result.opensAt, result.timezone))
    if (opening && result.reminderDays.some(days => deadline - (days * 86_400_000) < opening)) {
      throw createError(400, 'Les relances doivent être prévues à partir de la date d’ouverture des réponses.')
    }
  }
}

export function validateCampaignConfig(input, {create = false} = {}) {
  const result = validateCampaignValue(campaignConfigSchema, {...input, ...(create ? {expectedVersion: 0} : {})})
  if (result.indexDates.some((date, index) => index > 0 && date <= result.indexDates[index - 1])) {
    throw createError(400, 'Les dates de relevé doivent suivre un ordre strictement chronologique.')
  }

  validateResponseSchedule(result)

  const keys = new Set()
  for (const item of result.periods) {
    const key = `${item.kind}:${item.position}`
    if (keys.has(key) || item.startDate >= item.endDate) {
      throw createError(400, 'Les périodes sont invalides ou dupliquées.')
    }

    keys.add(key)
    if (item.kind === 'INDEX' && (
      !item.startReadingDate || !item.endReadingDate
      || !result.indexDates.includes(item.startReadingDate)
      || result.indexDates[result.indexDates.indexOf(item.startReadingDate) + 1] !== item.endReadingDate
    )) {
      throw createError(400, 'Chaque période d’index doit référencer deux relevés successifs de la campagne.')
    }
  }

  for (const kind of ['INDEX', 'NEEDS']) {
    const periods = result.periods.filter(item => item.kind === kind).sort((a, b) => a.startDate.localeCompare(b.startDate))
    if (periods.length === 0 || periods.some((item, index) => index > 0 && periods[index - 1].endDate > item.startDate)) {
      throw createError(400, 'Chaque volet doit contenir des périodes sans chevauchement.')
    }

    if (kind === 'INDEX' && periods.some((item, index) => index > 0 && (periods[index - 1].endDate !== item.startDate || periods[index - 1].endReadingDate !== item.startReadingDate))) {
      throw createError(400, 'Les périodes d’index doivent se suivre sans interruption.')
    }
  }

  return result
}

export function validateCampaignDraft(kind, input, {campaign, targets, complete = false, previousDraft}) {
  if (!['INDEX', 'NEEDS'].includes(kind)) {
    throw createError(400, 'Volet de campagne inconnu.')
  }

  const value = validateCampaignValue(kind === 'INDEX' ? campaignIndexDraftSchema : campaignNeedsDraftSchema, input)
  const byTarget = new Map(targets.map(target => [target.id, target]))
  const meterlessPeriods = kind === 'INDEX'
    ? new Map(targets.map(target => [target.id, campaignMeterlessPeriod(target, {campaign, meterEvents: value.meterEvents})]))
    : new Map()
  const periods = new Map(campaign.periods.filter(period => period.kind === kind).map(period => [period.id, period]))
  const seen = new Set()
  for (const entry of kind === 'INDEX' ? value.readings : value.needs) {
    const target = byTarget.get(entry.targetId)
    if (!target) {
      throw createError(403, 'Cette exploitation ne fait pas partie de votre périmètre de campagne.')
    }

    const key = kind === 'INDEX' ? `${entry.targetId}:${entry.compteurId}:${entry.readingDate}` : `${entry.targetId}:${entry.periodId}`
    if (seen.has(key)) {
      throw createError(400, 'Une même mesure ou demande ne peut être envoyée deux fois.')
    }

    seen.add(key)
    if (kind === 'INDEX') {
      const allowedMeter = entry.compteurId === null
        ? isCampaignMeterlessDate(meterlessPeriods.get(target.id), entry.readingDate)
        : target.meters.some(meter => meter.compteurId === entry.compteurId)
      if (!allowedMeter || !campaign.indexDates.includes(entry.readingDate)) {
        throw createError(400, 'Le point, le compteur ou la date de relevé ne correspond pas à la campagne.')
      }
    } else if (!periods.has(entry.periodId) || (complete && !entry.requestedVolume)) {
      throw createError(400, 'Chaque besoin doit renseigner un volume pour une période de la campagne.')
    }
  }

  if (kind === 'NEEDS' && complete && seen.size !== targets.length * periods.size) {
    throw createError(400, 'Renseignez chaque point et chaque période avant transmission.')
  }

  const seenEvents = new Set()
  for (const event of value.meterEvents ?? []) {
    const target = byTarget.get(event.targetId)
    const previousAllowed = target && (event.previousCompteurId === null
      ? Boolean(meterlessPeriods.get(target.id))
      : target.meters.some(meter => meter.compteurId === event.previousCompteurId))
    if (!previousAllowed || (event.nextCompteurId && !target.meters.some(meter => meter.compteurId === event.nextCompteurId))) {
      throw createError(403, 'L’événement de compteur ne correspond pas à votre périmètre.')
    }

    const eventKey = `${event.targetId}:${event.previousCompteurId}:${event.at}`
    if (seenEvents.has(eventKey)) {
      const message = 'Un changement est déjà déclaré à cette date pour ce compteur. Modifiez-le au lieu d’en ajouter un autre.'
      throw campaignMeterEventError([campaignMeterEventIssue(event, 'DUPLICATE_METER_EVENT', message)])
    }

    if ((event.type === 'RESET' && (event.nextMeter || (event.nextCompteurId !== undefined && event.nextCompteurId !== event.previousCompteurId)))
      || (event.type === 'REPLACEMENT' && ((!event.nextMeter && !event.nextCompteurId) || event.nextCompteurId === event.previousCompteurId))) {
      throw createError(400, 'Précisez un changement unique, avec le même compteur pour une remise à zéro ou un autre compteur pour un remplacement.')
    }

    seenEvents.add(eventKey)
  }

  const dateIssues = campaignMeterEventDateIssues(value.meterEvents ?? [], {campaign, targets})
  if (dateIssues.length > 0 && (complete || !allowsCampaignEventRemovalRepair(previousDraft, value, {campaign, targets, issues: dateIssues}))) {
    throw campaignMeterEventError(dateIssues)
  }

  return value
}
