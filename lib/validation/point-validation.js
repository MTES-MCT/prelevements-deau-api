import Joi from 'joi'
import {validatePayload} from '../util/payload.js'

export const WATER_BODY_TYPES = ['SURFACE', 'SOUTERRAIN', 'TRANSITION']

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

function validateWaterBodyType(waterBodyType, helpers) {
  if (!WATER_BODY_TYPES.includes(waterBodyType)) {
    return helpers.message('Ce type de milieu est invalide.')
  }

  return waterBodyType
}

function validateGeometryPrecision(geometryPrecision, helpers) {
  if (!GEOMETRY_PRECISIONS.includes(geometryPrecision)) {
    return helpers.message('Cette précision géométrique est invalide.')
  }

  return geometryPrecision
}

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

const POINT_FIELDS = {
  name: Joi.string().trim().min(3).max(200),
  otherNames: OPTIONAL_TEXT,
  codeAIOT: OPTIONAL_TEXT,
  codeBSS: OPTIONAL_TEXT,
  codeBNPE: OPTIONAL_TEXT,
  codeMESO: OPTIONAL_TEXT,
  codeMEContinentalesBV: OPTIONAL_TEXT,
  codeBDCarthage: OPTIONAL_TEXT,
  codeEUMasseDEau: OPTIONAL_TEXT,
  codePTP: OPTIONAL_TEXT,
  codeOPR: OPTIONAL_TEXT,
  codeBDLISA: OPTIONAL_TEXT,
  codeBDTopage: OPTIONAL_TEXT,
  codeSISPEA: OPTIONAL_TEXT,
  waterBodyType: Joi.custom(validateWaterBodyType),
  depth: Joi.number().positive(),
  isZre: Joi.bool(),
  isBiologicalReservoir: Joi.bool(),
  streamName: OPTIONAL_TEXT,
  locationDescription: OPTIONAL_TEXT,
  coordinates: Joi.custom(validateCoordinates),
  geometryPrecision: Joi.custom(validateGeometryPrecision),
  comment: OPTIONAL_TEXT,
  internalComment: OPTIONAL_TEXT,
  communeCode: Joi.string().trim().min(1).max(20),
  communeName: OPTIONAL_TEXT
}

const pointSchemaCreation = Joi.object().keys({
  name: addStringMessages(POINT_FIELDS.name.required(), 'name'),
  otherNames: addStringMessages(POINT_FIELDS.otherNames.allow(null), 'otherNames'),
  codeAIOT: addStringMessages(POINT_FIELDS.codeAIOT.allow(null), 'codeAIOT'),
  codeBSS: addStringMessages(POINT_FIELDS.codeBSS.allow(null), 'codeBSS'),
  codeBNPE: addStringMessages(POINT_FIELDS.codeBNPE.allow(null), 'codeBNPE'),
  codeMESO: addStringMessages(POINT_FIELDS.codeMESO.allow(null), 'codeMESO'),
  codeMEContinentalesBV: addStringMessages(POINT_FIELDS.codeMEContinentalesBV.allow(null), 'codeMEContinentalesBV'),
  codeBDCarthage: addStringMessages(POINT_FIELDS.codeBDCarthage.allow(null), 'codeBDCarthage'),
  codeEUMasseDEau: addStringMessages(POINT_FIELDS.codeEUMasseDEau.allow(null), 'codeEUMasseDEau'),
  codePTP: addStringMessages(POINT_FIELDS.codePTP.allow(null), 'codePTP'),
  codeOPR: addStringMessages(POINT_FIELDS.codeOPR.allow(null), 'codeOPR'),
  codeBDLISA: addStringMessages(POINT_FIELDS.codeBDLISA.allow(null), 'codeBDLISA'),
  codeBDTopage: addStringMessages(POINT_FIELDS.codeBDTopage.allow(null), 'codeBDTopage'),
  codeSISPEA: addStringMessages(POINT_FIELDS.codeSISPEA.allow(null), 'codeSISPEA'),
  waterBodyType: POINT_FIELDS.waterBodyType.required().messages({
    'any.required': 'Le type de milieu est obligatoire.'
  }),
  depth: POINT_FIELDS.depth.allow(null).messages({
    'number.base': 'La profondeur doit être un nombre.'
  }),
  isZre: POINT_FIELDS.isZre.allow(null),
  isBiologicalReservoir: POINT_FIELDS.isBiologicalReservoir.allow(null),
  streamName: addStringMessages(POINT_FIELDS.streamName.allow(null), 'streamName'),
  locationDescription: addStringMessages(POINT_FIELDS.locationDescription.allow(null), 'locationDescription'),
  coordinates: POINT_FIELDS.coordinates.required().messages({
    'any.required': 'La géométrie est obligatoire.'
  }),
  geometryPrecision: POINT_FIELDS.geometryPrecision.allow(null),
  comment: addStringMessages(POINT_FIELDS.comment.allow(null), 'comment'),
  internalComment: addStringMessages(POINT_FIELDS.internalComment.allow(null), 'internalComment'),
  communeCode: addStringMessages(POINT_FIELDS.communeCode.allow(null), 'communeCode'),
  communeName: addStringMessages(POINT_FIELDS.communeName.allow(null), 'communeName')
}).messages({
  'object.unknown': 'Une clé de l’objet est invalide'
})

const pointSchemaEdition = Joi.object().keys({
  name: addStringMessages(POINT_FIELDS.name, 'name'),
  otherNames: addStringMessages(POINT_FIELDS.otherNames.allow(null), 'otherNames'),
  codeAIOT: addStringMessages(POINT_FIELDS.codeAIOT.allow(null), 'codeAIOT'),
  codeBSS: addStringMessages(POINT_FIELDS.codeBSS.allow(null), 'codeBSS'),
  codeBNPE: addStringMessages(POINT_FIELDS.codeBNPE.allow(null), 'codeBNPE'),
  codeMESO: addStringMessages(POINT_FIELDS.codeMESO.allow(null), 'codeMESO'),
  codeMEContinentalesBV: addStringMessages(POINT_FIELDS.codeMEContinentalesBV.allow(null), 'codeMEContinentalesBV'),
  codeBDCarthage: addStringMessages(POINT_FIELDS.codeBDCarthage.allow(null), 'codeBDCarthage'),
  codeEUMasseDEau: addStringMessages(POINT_FIELDS.codeEUMasseDEau.allow(null), 'codeEUMasseDEau'),
  codePTP: addStringMessages(POINT_FIELDS.codePTP.allow(null), 'codePTP'),
  codeOPR: addStringMessages(POINT_FIELDS.codeOPR.allow(null), 'codeOPR'),
  codeBDLISA: addStringMessages(POINT_FIELDS.codeBDLISA.allow(null), 'codeBDLISA'),
  codeBDTopage: addStringMessages(POINT_FIELDS.codeBDTopage.allow(null), 'codeBDTopage'),
  codeSISPEA: addStringMessages(POINT_FIELDS.codeSISPEA.allow(null), 'codeSISPEA'),
  waterBodyType: POINT_FIELDS.waterBodyType.allow(null),
  depth: POINT_FIELDS.depth.allow(null),
  isZre: POINT_FIELDS.isZre.allow(null),
  isBiologicalReservoir: POINT_FIELDS.isBiologicalReservoir.allow(null),
  streamName: addStringMessages(POINT_FIELDS.streamName.allow(null), 'streamName'),
  locationDescription: addStringMessages(POINT_FIELDS.locationDescription.allow(null), 'locationDescription'),
  coordinates: POINT_FIELDS.coordinates,
  geometryPrecision: POINT_FIELDS.geometryPrecision.allow(null),
  comment: addStringMessages(POINT_FIELDS.comment.allow(null), 'comment'),
  internalComment: addStringMessages(POINT_FIELDS.internalComment.allow(null), 'internalComment'),
  communeCode: addStringMessages(POINT_FIELDS.communeCode.allow(null), 'communeCode'),
  communeName: addStringMessages(POINT_FIELDS.communeName.allow(null), 'communeName')
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
