import Joi from 'joi'
import createHttpError from 'http-errors'
import {scaledDecimal} from '../services/meter-core.js'

export const COLLECTION_CAMPAIGN_TYPE = 'DROPT_INDEX_NEEDS_2026_2027'
const uuid = Joi.string().guid({version: ['uuidv4', 'uuidv5']})
const date = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).custom((value, helpers) => {
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? helpers.error('any.invalid') : value
}).allow(null)

export function validateCampaignInput(data, {partial = false} = {}) {
  const schema = Joi.object({
    name: Joi.string().trim().min(1).max(200), type: Joi.string().valid(COLLECTION_CAMPAIGN_TYPE),
    opensOn: date, closesOn: date, collecteurUserId: uuid,
    exploitationIds: Joi.array().items(uuid.required()).unique().min(1).max(5000),
    sourceId: Joi.string().trim().max(250)
  }).unknown(false)
  return validate(partial ? schema.min(1) : schema.fork(['name', 'collecteurUserId', 'exploitationIds'], rule => rule.required()), data)
}

function validate(schema, data) {
  const result = schema.validate(data, {abortEarly: false})
  if (result.error) {
    const fields = Object.fromEntries(result.error.details.map(detail => [detail.path.join('.'), validationMessage(detail, data)]))
    const error = createHttpError(400, 'Vérifiez les champs du formulaire.')
    error.data = {fields, validationErrors: fields}
    throw error
  }
  return result.value
}

const decimalLabels = {
  indexStart: ['l’index relevé sur votre compteur', 'L’index du compteur doit être supérieur ou égal à zéro.'],
  indexEnd: ['l’index relevé sur votre compteur', 'L’index du compteur doit être supérieur ou égal à zéro.'],
  surface: ['la surface irriguée en hectares', 'La surface irriguée doit être supérieure ou égale à zéro.'],
  volume: ['le volume demandé en m³', 'Le volume demandé doit être supérieur ou égal à zéro.'],
  flow: ['le débit demandé en m³/h', 'Le débit demandé doit être supérieur ou égal à zéro.']
}

function validationMessage(detail, data) {
  const key = detail.path.at(-1)
  const labels = ['meters', 'needs'].includes(detail.path[0]) && Object.hasOwn(decimalLabels, key) && decimalLabels[key]
  if (!labels) return detail.message
  const value = detail.path.reduce((current, key) => current?.[key], data)
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return `Renseignez ${labels[0]}.`
  const numeric = typeof value === 'string' ? Number(value.trim().replace(',', '.')) : value
  if (typeof numeric === 'number' && Number.isFinite(numeric) && numeric < 0) return labels[1]
  return `Vérifiez ${labels[0]}.`
}

function decimal(required) {
  const rule = Joi.alternatives().try(Joi.string().trim().pattern(/^\d{1,12}(?:[.,]\d{1,4})?$/), Joi.number().min(0).max(999999999999).precision(4).strict())
    .custom(value => {
      const [integer, fraction = ''] = String(value).replace(',', '.').split('.')
      const normalizedInteger = integer.replace(/^0+(?=\d)/, '')
      const normalizedFraction = fraction.replace(/0{1,4}$/, '')
      return normalizedFraction ? `${normalizedInteger}.${normalizedFraction}` : normalizedInteger
    })
  return required ? rule.required() : rule.allow('', null)
}

export function validateCollectionResponseData(data, {submitted = false, waterUses = [], deferAgriculturalRequirements = false} = {}) {
  const required = rule => submitted ? rule.required() : rule.allow('', null)
  const cropLabel = Joi.string().trim().min(1).max(3000)
  const crops = required => Joi.alternatives().try(cropLabel, Joi.array().items(cropLabel).unique().min(required ? 1 : 0).max(100))
  const replenishmentRoots = new Set(waterUses.filter(usage => usage.kind === 'USAGE' && usage.code === '12').map(usage => usage.id))
  const replenishmentIds = waterUses.filter(usage => replenishmentRoots.has(usage.id)
    || replenishmentRoots.has(usage.parentId) || (usage.parent?.kind === 'USAGE' && usage.parent.code === '12')).map(usage => usage.id)
  const agriculturalField = (optionalRule, requiredRule) => {
    if (!submitted || deferAgriculturalRequirements) return optionalRule
    return replenishmentIds.length ? Joi.when('usageId', {is: Joi.valid(...replenishmentIds).required(), then: optionalRule, otherwise: requiredRule}) : requiredRule
  }
  const agricultural = {
    usageId: required(uuid),
    surface: agriculturalField(decimal(false), decimal(true)),
    crops: agriculturalField(crops(false).allow('', null), crops(true).required())
  }
  const period = fields => {
    const rule = Joi.object({...agricultural, ...fields}).unknown(false)
    return submitted ? rule.required() : rule
  }
  const meter = Joi.object({
    compteurId: uuid.allow(null), serialNumber: Joi.string().trim().max(100).empty('').allow(null).default(null),
    offSeason: period({indexStart: decimal(submitted), indexEnd: decimal(submitted)}),
    season: period({indexEnd: decimal(submitted)})
  }).unknown(false)
  const needs = Joi.object({offSeason: period({flow: decimal(submitted), volume: decimal(submitted)}), season: period({flow: decimal(submitted), volume: decimal(submitted)})}).unknown(false)
  const value = validate(Joi.object({
    meters: submitted ? Joi.array().items(meter).min(1).max(50).required() : Joi.array().items(meter).max(50),
    needs: submitted ? needs.required() : needs,
    comment: Joi.string().trim().allow('').max(20000)
  }).unknown(false), data)
  if (submitted) {
    const fields = {}
    for (const [index, meter] of value.meters.entries()) {
      if (scaledDecimal(meter.offSeason.indexEnd) < scaledDecimal(meter.offSeason.indexStart)) {
        fields[`meters.${index}.offSeason.indexEnd`] = 'L’index du 31 mai 2026 doit être supérieur ou égal à celui du 1er novembre 2025.'
      }
      if (scaledDecimal(meter.season.indexEnd) < scaledDecimal(meter.offSeason.indexEnd)) {
        fields[`meters.${index}.season.indexEnd`] = 'L’index du 31 octobre 2026 doit être supérieur ou égal à celui du 31 mai 2026.'
      }
    }
    if (Object.keys(fields).length) {
      const error = createHttpError(400, 'Les index d’un même compteur doivent rester croissants ou identiques au fil des relevés.')
      error.data = {fields, validationErrors: fields}
      throw error
    }
  }
  return value
}

export function validateResponseWrite(body) {
  return validate(Joi.object({revision: Joi.number().integer().min(0).required(), data: Joi.object().required()}).unknown(false), body)
}

export function validateCampaignId(value) {
  return validate(uuid.required(), value)
}

export function validateCampaignQuery(query) {
  return validate(Joi.object({
    page: Joi.number().integer().min(1).default(1), pageSize: Joi.number().integer().min(1).max(200).default(50),
    q: Joi.string().trim().max(200).allow(''), search: Joi.string().trim().max(200).allow(''),
    status: Joi.string().valid('NOT_STARTED', 'DRAFT', 'SUBMITTED'), collecteurUserId: uuid,
    usageId: uuid, selectAll: Joi.boolean().default(false), view: Joi.string().valid('summary', 'detailed')
  }).unknown(false), query)
}
