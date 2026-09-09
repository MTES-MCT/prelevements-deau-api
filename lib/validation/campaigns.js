import Joi from 'joi'
import createError from 'http-errors'

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
    previousCompteurId: id.required(),
    nextCompteurId: id,
    previousIndex: decimal.allow(null).required(),
    nextIndex: decimal.allow(null).required(),
    previousMissingReason: Joi.string().trim().max(2000),
    nextMissingReason: Joi.string().trim().max(2000),
    reason: Joi.string().trim().max(2000).required()
  })).max(5000).default([])
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

export function validateCampaignConfig(input, {create = false} = {}) {
  const result = validateCampaignValue(campaignConfigSchema, {...input, ...(create ? {expectedVersion: 0} : {})})
  if (result.opensAt && result.closesAt && result.opensAt >= result.closesAt) {
    throw createError(400, 'La clôture doit être postérieure à l’ouverture.')
  }

  const keys = new Set()
  for (const item of result.periods) {
    const key = `${item.kind}:${item.position}`
    if (keys.has(key) || item.startDate >= item.endDate) {
      throw createError(400, 'Les périodes sont invalides ou dupliquées.')
    }

    keys.add(key)
    if (item.kind === 'INDEX' && (!item.startReadingDate || !item.endReadingDate || item.startReadingDate >= item.endReadingDate || !result.indexDates.includes(item.startReadingDate) || !result.indexDates.includes(item.endReadingDate))) {
      throw createError(400, 'Chaque période d’index doit référencer deux dates de relevé ordonnées de la campagne.')
    }
  }

  for (const kind of ['INDEX', 'NEEDS']) {
    const periods = result.periods.filter(item => item.kind === kind).sort((a, b) => a.startDate.localeCompare(b.startDate))
    if (periods.length === 0 || periods.some((item, index) => index > 0 && periods[index - 1].endDate > item.startDate)) {
      throw createError(400, 'Chaque volet doit contenir des périodes sans chevauchement.')
    }
  }

  return result
}

export function validateCampaignDraft(kind, input, {campaign, targets, complete = false}) {
  if (!['INDEX', 'NEEDS'].includes(kind)) {
    throw createError(400, 'Volet de campagne inconnu.')
  }

  const value = validateCampaignValue(kind === 'INDEX' ? campaignIndexDraftSchema : campaignNeedsDraftSchema, input)
  const byTarget = new Map(targets.map(target => [target.id, target]))
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
        ? target.meters.length === 0
        : target.meters.some(meter => meter.compteurId === entry.compteurId)
      if (!allowedMeter || !campaign.indexDates.includes(entry.readingDate)) {
        throw createError(400, 'Le point, le compteur ou la date de relevé ne correspond pas à la campagne.')
      }
    } else if (!periods.has(entry.periodId) || (complete && (!entry.requestedFlow || !entry.requestedVolume))) {
      throw createError(400, 'Chaque besoin doit renseigner un débit et un volume pour une période de la campagne.')
    }
  }

  if (kind === 'NEEDS' && complete && seen.size !== targets.length * periods.size) {
    throw createError(400, 'Renseignez chaque point et chaque période avant transmission.')
  }

  for (const event of value.meterEvents ?? []) {
    const target = byTarget.get(event.targetId)
    if (!target || !target.meters.some(meter => meter.compteurId === event.previousCompteurId) || (event.nextCompteurId && !target.meters.some(meter => meter.compteurId === event.nextCompteurId))) {
      throw createError(403, 'L’événement de compteur ne correspond pas à votre périmètre.')
    }
  }

  return value
}
