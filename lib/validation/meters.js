import Joi from 'joi'
import {parseMeterInstant} from '../services/meter-core.js'

const instant = Joi.string().custom((value, helpers) => parseMeterInstant(value) ? value : helpers.message('Un instant ISO avec offset explicite est requis.'))
const provider = Joi.string().min(1).max(100).pattern(/\S/).required()
const scope = Joi.string().min(1).max(250).pattern(/\S/).required()
const annotation = Joi.string().max(250).allow(null)
const readingSchema = Joi.object({
  externalId: Joi.string().min(1).max(250).allow(null).required(),
  observedAt: instant.allow(null).required(),
  index: Joi.string().pattern(/^\d{1,16}(?:\.\d{1,4})?$/).allow(null).required(),
  status: Joi.string().valid('VALID', 'INVALID').required(),
  reason: annotation,
  quality: annotation,
  origin: annotation,
  raw: Joi.any().allow(null)
}).unknown(false).custom((value, helpers) => {
  if (value.status === 'VALID' && (value.externalId === null || value.observedAt === null || value.index === null)) {
    return helpers.message('Une observation valide exige un identifiant, un instant et un index normalisés.')
  }
  return value
})

export const meterStreamQuerySchema = Joi.object({provider, scope}).unknown(false)

export const meterIngestionSchema = Joi.object({
  provider,
  scope,
  batchId: Joi.string().trim().min(1).max(250).required(),
  mode: Joi.string().valid('LIVE', 'OFFLINE').default('LIVE'),
  fetchedAt: instant.required(),
  windowStart: instant.required(),
  windowEnd: instant.required(),
  complete: Joi.boolean().valid(true).required(),
  // Producers wrap malformed source rows in an INVALID normalized envelope.
  readings: Joi.array().items(readingSchema).max(50_000).required()
}).unknown(false).custom((value, helpers) => {
  const start = new Date(value.windowStart)
  const end = new Date(value.windowEnd)
  if (end <= start || end - start > 32 * 86_400_000) return helpers.message('La fenêtre doit être positive et ne pas dépasser 32 jours.')
  if (end > new Date(value.fetchedAt)) return helpers.message('La fenêtre ne peut pas dépasser la date de récupération.')
  if (new Date(value.fetchedAt) > Date.now() + 300_000) return helpers.message('La date de récupération ne peut pas être future.')
  return value
})

export const meterReadingsQuerySchema = Joi.object({
  cursor: Joi.string().uuid(),
  limit: Joi.number().integer().min(1).max(200).default(50)
})
