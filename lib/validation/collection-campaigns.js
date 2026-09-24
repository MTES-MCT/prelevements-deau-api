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
    const fields = Object.fromEntries(result.error.details.map(detail => [detail.path.join('.'), detail.message]))
    const error = createHttpError(400, 'Vérifiez les champs du formulaire.')
    error.data = {fields, validationErrors: fields}
    throw error
  }
  return result.value
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

export function validateCollectionResponseData(data, {submitted = false} = {}) {
  const required = rule => submitted ? rule.required() : rule.allow('', null)
  const agricultural = {
    usageId: required(uuid), surface: decimal(submitted), crops: required(Joi.string().trim().min(1).max(3000))
  }
  const period = fields => {
    const rule = Joi.object({...agricultural, ...fields}).unknown(false)
    return submitted ? rule.required() : rule
  }
  const meter = Joi.object({
    compteurId: uuid.allow(null), serialNumber: required(Joi.string().trim().min(1).max(100)),
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
        fields[`meters.${index}.offSeason.indexEnd`] = 'L’index du 1er juin 2026 doit être supérieur ou égal à celui du 31 octobre 2025.'
      }
      if (scaledDecimal(meter.season.indexEnd) < scaledDecimal(meter.offSeason.indexEnd)) {
        fields[`meters.${index}.season.indexEnd`] = 'L’index du 31 octobre 2026 doit être supérieur ou égal à celui du 1er juin 2026.'
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
    usageId: uuid, selectAll: Joi.boolean().default(false)
  }).unknown(false), query)
}
