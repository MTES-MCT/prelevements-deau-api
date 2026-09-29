import {createHash} from 'node:crypto'
import Joi from 'joi'
import {getCommune} from '../../lib/util/cog.js'

const text = Joi.string().trim().min(1).max(250).required()
const date = Joi.string().isoDate().pattern(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/).required()
const schema = Joi.object({
  schemaVersion: Joi.number().valid(1).required(),
  point: Joi.object({
    name: text,
    sourceId: Joi.string().pattern(/^DDT[0-9A-Z]+:[A-Za-z0-9_-]+$/).required(),
    identifiers: Joi.object({DDT: text}).unknown(false).required(),
    coordinatesLambert93: Joi.object({
      x: Joi.number().min(0).max(1_300_000).required(),
      y: Joi.number().min(6_000_000).max(7_200_000).required()
    }).required(),
    waterBodyType: Joi.string().valid('SOUTERRAIN').required(),
    flowType: Joi.string().valid('PRELEVEMENT').required(),
    pointKind: Joi.string().valid('PHYSIQUE').required(),
    nature: Joi.string().valid('NAPPE').required(),
    withdrawalType: Joi.string().valid('SOUTERRAIN').required(),
    isZre: Joi.boolean().valid(false).required(),
    communeCode: Joi.string().pattern(/^[0-9A-Z]{5}$/)
  }).required(),
  preleveur: Joi.object({
    companyName: text,
    email: Joi.string().trim().lowercase().email({tlds: {allow: false}}).required(),
    siret: Joi.string().pattern(/^\d{14}$/).required(),
    firstName: text,
    lastName: text,
    type: Joi.string().valid('PM').required()
  }).required(),
  exploitation: Joi.object({
    usageCode: Joi.string().valid('7E').required(),
    status: Joi.string().valid('EN_ACTIVITE').required()
  }).required(),
  connector: Joi.object({
    type: Joi.string().valid('eveler').required(),
    sourcePointId: text,
    sourceMeterId: Joi.string().pattern(/^[a-f0-9]{24}$/).required(),
    sourceStartDate: date,
    rate: Joi.number().valid(100).required()
  }).required(),
  serviceAccount: Joi.object({existingId: Joi.string().guid().required()})
}).required()

export function normalizeManifest(input) {
  const {error, value} = schema.validate(input, {abortEarly: false, convert: false})
  if (error) {
    throw new Error(`MANIFEST_INVALID: ${error.details.map(item => item.path.join('.')).join(', ')}`)
  }
  const manifest = structuredClone(value)
  manifest.preleveur.email = manifest.preleveur.email.toLowerCase()
  manifest.connector.sourceStartDate = new Date(manifest.connector.sourceStartDate).toISOString()
  if (manifest.point.communeCode) {
    const commune = getCommune(manifest.point.communeCode)
    if (!commune) throw new Error('MANIFEST_COMMUNE_UNKNOWN')
    manifest.point.communeName = commune.nom
  }
  return manifest
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function digest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex')
}
