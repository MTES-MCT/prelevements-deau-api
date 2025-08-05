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

function addStringMessages(field, fieldName) {
  return field.messages({
    'string.base': `Le champ "${fieldName}" doit être une chaine de caractères.`,
    'string.empty': `Le champ "${fieldName}" ne peut pas être vide.`
  })
}

const POINT_FIELDS = {
  nom: Joi.string().trim().min(3).max(200),
  autresNoms: Joi.string().trim().min(3).max(500),
  code_aiot: Joi.string().trim().min(3).max(200),
  type_milieu: Joi.custom(validateTypeMilieu),
  profondeur: Joi.number().positive(),
  zre: Joi.bool(),
  reservoir_biologique: Joi.bool(),
  cours_eau: Joi.string().trim().min(3).max(200),
  detail_localisation: Joi.string().trim().min(3).max(200),
  geom: Joi.custom(validateGeom),
  precision_geom: Joi.custom(validatePrecisionGeom),
  remarque: Joi.string().trim().min(3).max(500),
  bss: Joi.string().trim().length(10),
  bnpe: Joi.string().trim().length(18),
  meso: Joi.string().trim().length(7),
  meContinentalesBv: Joi.string().trim().min(6).max(7),
  bvBdCarthage: Joi.string().trim().length(8),
  commune: Joi.string().trim().min(3).max(100)
}

const pointSchemaCreation = Joi.object().keys({
  nom: addStringMessages(POINT_FIELDS.nom.required(), 'nom'),
  autresNoms: addStringMessages(POINT_FIELDS.autresNoms.allow(null), 'autresNoms'),
  code_aiot: addStringMessages(POINT_FIELDS.code_aiot.allow(null), 'code_aiot'),
  type_milieu: POINT_FIELDS.type_milieu.required().messages({
    'any.required': 'Le type de milieu est obligatoire.'
  }),
  profondeur: POINT_FIELDS.profondeur.allow(null).messages({
    'number.base': 'La profondeur doit être un nombre.'
  }),
  zre: POINT_FIELDS.zre.allow(null),
  reservoir_biologique: POINT_FIELDS.reservoir_biologique.allow(null),
  cours_eau: addStringMessages(POINT_FIELDS.cours_eau.allow(null), 'cours_eau'),
  detail_localisation: addStringMessages(POINT_FIELDS.detail_localisation.allow(null), 'detail_localisation'),
  geom: POINT_FIELDS.geom.required().messages({
    'any.required': 'La géométrie est obligatoire.'
  }),
  precision_geom: POINT_FIELDS.precision_geom.allow(null),
  remarque: addStringMessages(POINT_FIELDS.remarque.allow(null), 'remarque'),
  bss: addStringMessages(POINT_FIELDS.bss.allow(null), 'bss'),
  bnpe: addStringMessages(POINT_FIELDS.bnpe.allow(null), 'bnpe'),
  meso: addStringMessages(POINT_FIELDS.meso.allow(null), 'meso'),
  meContinentalesBv: addStringMessages(POINT_FIELDS.meContinentalesBv.allow(null), 'meContinentalesBv'),
  bvBdCarthage: addStringMessages(POINT_FIELDS.bvBdCarthage.allow(null), 'bvBdCarthage'),
  commune: POINT_FIELDS.commune.required().messages({
    'string.base': 'Le champ "commune" doit être une chaine de caractères.',
    'any.required': 'La commune est obligatoire.'
  })
}).messages({
  'object.unknown': 'Une clé de l’objet est invalide'
})

const pointSchemaEdition = Joi.object().keys({
  nom: addStringMessages(POINT_FIELDS.nom, 'nom'),
  autresNoms: addStringMessages(POINT_FIELDS.autresNoms.allow(null), 'autresNoms'),
  code_aiot: addStringMessages(POINT_FIELDS.code_aiot.allow(null), 'code_aiot'),
  type_milieu: POINT_FIELDS.type_milieu.allow(null),
  profondeur: POINT_FIELDS.profondeur.allow(null),
  zre: POINT_FIELDS.zre.allow(null),
  reservoir_biologique: POINT_FIELDS.reservoir_biologique.allow(null),
  cours_eau: addStringMessages(POINT_FIELDS.cours_eau.allow(null), 'cours_eau'),
  detail_localisation: addStringMessages(POINT_FIELDS.detail_localisation.allow(null), 'detail_localisation'),
  geom: POINT_FIELDS.geom,
  precision_geom: POINT_FIELDS.precision_geom.allow(null),
  remarque: addStringMessages(POINT_FIELDS.remarque.allow(null), 'remarque'),
  bss: addStringMessages(POINT_FIELDS.bss.allow(null), 'bss'),
  bnpe: addStringMessages(POINT_FIELDS.bnpe.allow(null), 'bnpe'),
  meso: addStringMessages(POINT_FIELDS.meso.allow(null), 'meso'),
  meContinentalesBv: addStringMessages(POINT_FIELDS.meContinentalesBv.allow(null), 'meContinentalesBv'),
  bvBdCarthage: addStringMessages(POINT_FIELDS.bvBdCarthage.allow(null), 'bvBdCarthage'),
  commune: POINT_FIELDS.commune.messages({
    'string.base': 'Le champ "commune" doit être une chaine de caractères.'
  })
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
