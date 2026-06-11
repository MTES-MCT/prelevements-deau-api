import Joi from 'joi'
import {validatePayload} from '../util/payload.js'

export const WATER_BODY_TYPES = ['SURFACE', 'SUPERFICIELLE', 'SOUTERRAIN', 'TRANSITION']

export const POINT_PRELEVEMENT_NATURES = [
  'NAPPE',
  'NAPPE_ACCOMPAGNEMENT',
  'COURS_EAU',
  'SOURCE',
  'PLAN_EAU'
]

export const PRELEVEMENT_TYPES = [
  'LITTORAL',
  'CONTINENTAL',
  'SOUTERRAIN',
  'STOCKAGE'
]

export const GEOMETRY_PRECISIONS = [
  'Repérage carte',
  'Coordonnées précises',
  'Coordonnées précises (ARS)',
  'Coordonnées du centroïde de la commune',
  'Coordonnées précises (rapport HGA)',
  'Coordonnées précises (ARS 2013)',
  'Coordonnées précises (AP)',
  'Coordonnées précises (BSS)',
  'Coordonnées précises (BNPE – accès restreint)',
  'Précision inconnue',
  'Coordonnées estimées (précision du kilomètre)',
  'Coordonnées précises (BNPE)',
  'Coordonnées précises (DEAL)',
  'Coordonnées précises (DLE)'
]

function validateCoordinates(coordinates, helpers) {
  if (!coordinates || coordinates.type !== 'Point') {
    return helpers.message('La géométrie doit être un point.')
  }

  if (!Array.isArray(coordinates.coordinates) || coordinates.coordinates.length !== 2) {
    return helpers.message('Les coordonnées doivent contenir longitude et latitude.')
  }

  const [longitude, latitude] = coordinates.coordinates

  if (
    typeof longitude !== 'number'
    || !Number.isFinite(longitude)
    || longitude < -180
    || longitude > 180
  ) {
    return helpers.message('La longitude est invalide.')
  }

  if (
    typeof latitude !== 'number'
    || !Number.isFinite(latitude)
    || latitude < -90
    || latitude > 90
  ) {
    return helpers.message('La latitude est invalide.')
  }

  return coordinates
}

function addStringMessages(field, fieldName) {
  return field.messages({
    'string.base': `Le champ "${fieldName}" doit être une chaine de caractères.`,
    'string.empty': `Le champ "${fieldName}" ne peut pas être vide.`,
    'string.min': `Le champ "${fieldName}" doit comporter au moins {#limit} caractères.`,
    'string.max': `Le champ "${fieldName}" ne doit pas comporter plus de {#limit} caractères.`
  })
}

const OPTIONAL_TEXT = Joi.string().trim().min(1).max(500)
const LONG_OPTIONAL_TEXT = Joi.string().trim().min(1).max(2000)
const CODE_TEXT = Joi.string().trim().min(1).max(100)

const namesSchema = Joi.array().items(
  Joi.object({
    type: Joi.string().trim().allow(null, ''),
    value: Joi.string().trim().min(1).required(),
    source: Joi.string().trim().allow(null, '')
  }).unknown(true)
)

const POINT_FIELDS = {
  name: Joi.string().trim().min(3).max(200),
  otherNames: LONG_OPTIONAL_TEXT,
  names: namesSchema,
  identifiers: Joi.object().unknown(true),
  codeAIOT: CODE_TEXT,
  codeBSS: CODE_TEXT,
  codeBNPE: CODE_TEXT,
  codeMESO: CODE_TEXT,
  codeMEContinentalesBV: CODE_TEXT,
  codeBDCarthage: CODE_TEXT,
  codeEUMasseDEau: CODE_TEXT,
  codePTP: CODE_TEXT,
  codeOPR: CODE_TEXT,
  codeBDLISA: CODE_TEXT,
  codeBDTopage: CODE_TEXT,
  codeSISPEA: CODE_TEXT,
  codeSISEAUX: CODE_TEXT,
  codeINSEE: CODE_TEXT,
  codeROE: CODE_TEXT,
  waterBodyType: Joi.string().valid(...WATER_BODY_TYPES).messages({
    'any.only': 'Ce type de milieu est invalide.'
  }),
  nature: Joi.string().valid(...POINT_PRELEVEMENT_NATURES).messages({
    'any.only': 'Cette nature de point de prélèvement est invalide.'
  }),
  withdrawalType: Joi.string().valid(...PRELEVEMENT_TYPES).messages({
    'any.only': 'Ce type de prélèvement est invalide.'
  }),
  depth: Joi.number().positive(),
  isZre: Joi.bool(),
  isBiologicalReservoir: Joi.bool(),
  streamName: OPTIONAL_TEXT,
  watershed: OPTIONAL_TEXT,
  underWatershed: OPTIONAL_TEXT,
  resourceName: OPTIONAL_TEXT,
  managementUnit: OPTIONAL_TEXT,
  managementSubUnit: OPTIONAL_TEXT,
  aquiferName: OPTIONAL_TEXT,
  locationDescription: LONG_OPTIONAL_TEXT,
  coordinates: Joi.custom(validateCoordinates),
  geometryPrecision: Joi.string().valid(...GEOMETRY_PRECISIONS).messages({
    'any.only': 'Cette précision géométrique est invalide.'
  }),
  comment: LONG_OPTIONAL_TEXT,
  internalComment: LONG_OPTIONAL_TEXT,
  communeCode: Joi.string().trim().min(1).max(20),
  communeName: OPTIONAL_TEXT
}

const nullableTextField = (key, label = key) => addStringMessages(POINT_FIELDS[key].allow(null), label)

const sharedCreationFields = {
  otherNames: nullableTextField('otherNames'),
  names: POINT_FIELDS.names.allow(null),
  identifiers: POINT_FIELDS.identifiers.allow(null),
  codeAIOT: nullableTextField('codeAIOT'),
  codeBSS: nullableTextField('codeBSS'),
  codeBNPE: nullableTextField('codeBNPE'),
  codeMESO: nullableTextField('codeMESO'),
  codeMEContinentalesBV: nullableTextField('codeMEContinentalesBV'),
  codeBDCarthage: nullableTextField('codeBDCarthage'),
  codeEUMasseDEau: nullableTextField('codeEUMasseDEau'),
  codePTP: nullableTextField('codePTP'),
  codeOPR: nullableTextField('codeOPR'),
  codeBDLISA: nullableTextField('codeBDLISA'),
  codeBDTopage: nullableTextField('codeBDTopage'),
  codeSISPEA: nullableTextField('codeSISPEA'),
  codeSISEAUX: nullableTextField('codeSISEAUX'),
  codeINSEE: nullableTextField('codeINSEE'),
  codeROE: nullableTextField('codeROE'),
  nature: POINT_FIELDS.nature.allow(null),
  withdrawalType: POINT_FIELDS.withdrawalType.allow(null),
  depth: POINT_FIELDS.depth.allow(null).messages({
    'number.base': 'La profondeur doit être un nombre.'
  }),
  isZre: POINT_FIELDS.isZre.allow(null),
  isBiologicalReservoir: POINT_FIELDS.isBiologicalReservoir.allow(null),
  streamName: nullableTextField('streamName'),
  watershed: nullableTextField('watershed'),
  underWatershed: nullableTextField('underWatershed'),
  resourceName: nullableTextField('resourceName'),
  managementUnit: nullableTextField('managementUnit'),
  managementSubUnit: nullableTextField('managementSubUnit'),
  aquiferName: nullableTextField('aquiferName'),
  locationDescription: nullableTextField('locationDescription'),
  geometryPrecision: POINT_FIELDS.geometryPrecision.allow(null),
  comment: nullableTextField('comment'),
  internalComment: nullableTextField('internalComment'),
  communeCode: nullableTextField('communeCode'),
  communeName: nullableTextField('communeName')
}

const pointSchemaCreation = Joi.object().keys({
  name: addStringMessages(POINT_FIELDS.name.required(), 'name'),
  waterBodyType: POINT_FIELDS.waterBodyType.required().messages({
    'any.required': 'Le type de milieu est obligatoire.'
  }),
  coordinates: POINT_FIELDS.coordinates.required().messages({
    'any.required': 'La géométrie est obligatoire.'
  }),
  ...sharedCreationFields
}).messages({
  'object.unknown': 'Une clé de l’objet est invalide'
})

const pointSchemaEdition = Joi.object().keys({
  name: addStringMessages(POINT_FIELDS.name, 'name'),
  waterBodyType: POINT_FIELDS.waterBodyType.allow(null),
  coordinates: POINT_FIELDS.coordinates,
  ...sharedCreationFields
}).messages({
  'object.unknown': 'Une clé de l’objet est invalide'
})

function validateCreation(point) {
  return validatePayload(point, pointSchemaCreation)
}

function validateChanges(changes) {
  return validatePayload(changes, pointSchemaEdition)
}

export {validateCreation, validateChanges}
