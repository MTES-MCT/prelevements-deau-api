import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import Joi from 'joi'
import createHttpError from 'http-errors'
import {validatePayload} from '../util/payload.js'
import {validateChanges} from './point-validation.js'

const require = createRequire(import.meta.url)
const communes = JSON.parse(await readFile(require.resolve('@etalab/decoupage-administratif/data/communes.json'), 'utf8'))
// COMD/COMA may share the same code: never use their name for a current commune.
const currentCommunes = new Map(communes.filter(commune => commune.type === 'commune-actuelle').map(commune => [commune.code, commune.nom]))
const normalizeSearch = value => String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('fr').trim()
const searchableCommunes = [...currentCommunes].map(([code, name]) => ({code, name, search: normalizeSearch(name)}))

export function searchCurrentCommunes(query, {limit = 20} = {}) {
  const search = normalizeSearch(query)
  if (search.length < 2) return []
  return searchableCommunes.filter(commune => commune.code.toLowerCase().startsWith(search) || commune.search.includes(search))
    .sort((left, right) => Number(right.code.toLowerCase() === search) - Number(left.code.toLowerCase() === search)
      || left.name.localeCompare(right.name, 'fr'))
    .slice(0, Math.max(0, Math.min(limit, 100)))
    .map(({code, name}) => ({code, name}))
}

export const COLLECTOR_POINT_EDITABLE_FIELDS = Object.freeze([
  'usageName', 'coordinates', 'communeCode', 'communeName', 'geometryPrecision',
  'waterBodyType', 'nature', 'withdrawalType', 'locationDescription', 'comment',
  'commissioningDate', 'depth', 'isWaterBodyConnectedToStream',
  'isWaterBodyConnectedToGroundwater', 'reservoirNominalVolume'
])

export function validateCollectorPointManagement(payload) {
  return validatePayload(payload, Joi.object({
    enabled: Joi.boolean().strict().required(),
    zoneIds: Joi.array().items(Joi.string().uuid()).unique().max(500).required()
  }).custom((value, helpers) => value.enabled && !value.zoneIds.length
    ? helpers.message('Sélectionnez au moins une zone autorisée.') : value))
}

export function canonicalizeCollectorCommune(payload) {
  if (!Object.hasOwn(payload, 'communeCode') && !Object.hasOwn(payload, 'communeName')) return payload
  const name = currentCommunes.get(payload.communeCode)
  if (!name) throw createHttpError(400, 'Sélectionnez une commune dans le référentiel.')
  if (payload.communeName !== undefined && payload.communeName !== name) {
    throw createHttpError(400, 'Le nom et le code de commune ne correspondent pas.')
  }
  return {...payload, communeName: name}
}

export function validateCollectorPointChanges(payload) {
  const {expectedUpdatedAt, ...changes} = validatePayload(payload, Joi.object({
    expectedUpdatedAt: Joi.string().isoDate().required(),
    ...Object.fromEntries(COLLECTOR_POINT_EDITABLE_FIELDS.map(field => [field, Joi.any()]))
  }))
  if (!Object.keys(changes).length) throw createHttpError(400, 'Aucun champ à modifier.')
  return {expectedUpdatedAt, changes: canonicalizeCollectorCommune(validateChanges(changes))}
}
