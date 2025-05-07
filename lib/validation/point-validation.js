import Joi from 'joi'
import {validatePayload} from '../util/payload.js'
import {precisionsGeom, typesMilieu} from '../nomenclature.js'

function validateTypeMilieu(typeMilieu, helpers) {
  if (!Object.values(typesMilieu).includes(typeMilieu)) {
    return helpers.message('Ce type de milieu est invalide.')
  }

  return typeMilieu
}

function validatePrecisionGeom(precision_geom, helpers) {
  if (!Object.values(precisionsGeom).includes(precision_geom)) {
    return helpers.message('Cette précision géométrique est invalide.')
  }

  return precision_geom
}

function validateGeom(geom, helpers) {
  if (geom.type !== 'Point') {
    return helpers.message('La géométrie doit être un point.')
  }

  if (geom.coordinates.length !== 2) {
    return helpers.message('Les coordonnées doivent contenir longitude et latitude.')
  }

  if (geom.coordinates[0] < -180 || geom.coordinates[0] > 180) {
    return helpers.message('La longitude est invalide.')
  }

  if (geom.coordinates[1] < -90 || geom.coordinates[1] > 90) {
    return helpers.message('La latitude est invalide.')
  }

  return geom
}

const pointSchemaCreation = Joi.object().keys({
  nom: Joi.string().required().messages({
    'string.base': 'Le nom doit être une chaine de caractères.',
    'string.empty': 'Le nom ne peut pas être vide.'
  }),
  autresNoms: Joi.string().allow(null).messages({
    'string.base': 'Le champ "autres_noms" doit être une chaine de caractères.',
    'string.empty': 'Le champ "autres_noms" ne peut pas être vide.'
  }),
  code_aiot: Joi.string().allow(null).messages({
    'string.base': 'Le code AIOT doit être une chaine de caractères.',
    'string.empty': 'Le code AIOT ne peut pas être vide.'
  }),
  type_milieu: Joi.custom(validateTypeMilieu).required().messages({
    'any.required': 'Le type de milieu est obligatoire.'
  }),
  profondeur: Joi.number().positive().allow(null).messages({
    'number.base': 'La profondeur doit être un nombre.'
  }),
  zre: Joi.bool().allow(null),
  reservoir_biologique: Joi.bool().allow(null),
  cours_eau: Joi.string().allow(null).messages({
    'string.base': 'Le champ "cours_eau" doit être une chaine de caractères.',
    'string.empty': 'Le champ "cours_eau" ne peux pas être vide.'
  }),
  detail_localisation: Joi.string().allow(null).messages({
    'string.base': 'Le champ "detail_localisation" doit être une chaine de caractères.',
    'string.empty': 'Le champ "detail_localisation" ne peux pas être vide.'
  }),
  geom: Joi.custom(validateGeom).required().messages({
    'any.required': 'La géométrie est obligatoire.'
  }),
  precision_geom: Joi.custom(validatePrecisionGeom).required().messages({
    'any.required': 'La précision géométrique est obligatoire.'
  }),
  remarque: Joi.string().allow(null).messages({
    'string.base': 'Le champ "remarque" doit être une chaine de caractères.',
    'string.empty': 'Le champ "remarque" ne peut pas être vide.'
  }),
  bss: Joi.string().allow(null).messages({
    'string.base': 'Le champ "bss" doit être une chaine de caractères.',
    'string.empty': 'Le champ "bss" ne peut pas être vide.'
  }),
  bnpe: Joi.string().allow(null).messages({
    'string.base': 'Le champ "bnpe" doit être une chaine de caractères.',
    'string.empty': 'Le champ "bnpe" ne peut pas être vide.'
  }),
  meso: Joi.string().allow(null).messages({
    'string.base': 'Le champ "meso" doit être une chaine de caractères.',
    'string.empty': 'Le champ "meso" ne peut pas être vide.'
  }),
  meContinentalesBv: Joi.string().allow(null).messages({
    'string.base': 'Le champ "meContinentalesBv" doit être une chaine de caractères.',
    'string.empty': 'Le champ "meContinentalesBv" ne peut pas être vide.'
  }),
  bvBdCarthage: Joi.string().allow(null).messages({
    'string.base': 'Le champ "bvBdCarthage" doit être une chaine de caractères.',
    'string.empty': 'Le champ "bvBdCarthage" ne peut pas être vide.'
  }),
  commune: Joi.string().required().messages({
    'string.base': 'Le champ "commune" doit être une chaine de caractères.',
    'any.required': 'La commune est obligatoire.'
  })
}).messages({
  'object.unknown': 'Une clé de l’objet est invalide'
})

function validateCreation(point) {
  return validatePayload(point, pointSchemaCreation)
}

export {validateCreation}
