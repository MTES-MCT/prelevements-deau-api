import Joi from 'joi'
import {validatePayload} from '../util/payload.js'

function addStringMessages(field, fieldName) {
  return field.messages({
    'string.base': `Le champ "${fieldName}" doit être une chaine de caractères.`,
    'string.empty': `Le champ "${fieldName}" ne peut pas être vide.`
  })
}

const PRELEVEUR_FIELDS = {
  raison_sociale: Joi.string().trim().min(3).max(200),
  sigle: Joi.string().trim().min(3).max(200),
  civilite: Joi.string().valid('M.', 'Mme'),
  nom: Joi.string().trim().min(1).max(50),
  prenom: Joi.string().trim().min(2).max(50),
  email: Joi.string().email(),
  adresse_1: Joi.string().trim().min(3).max(200),
  adresse_2: Joi.string().trim().min(3).max(200),
  bp: Joi.string().trim().min(3).max(10),
  code_postal: Joi.string().length(5),
  commune: Joi.string().trim().min(3).max(100),
  numero_telephone: Joi.string().length(10)
}

const preleveurSchema = Joi.object().keys({
  raison_sociale: PRELEVEUR_FIELDS.raison_sociale.allow(null),
  sigle: PRELEVEUR_FIELDS.sigle.allow(null),
  civilite: addStringMessages(PRELEVEUR_FIELDS.civilite.allow(null), 'civilite'),
  nom: PRELEVEUR_FIELDS.nom.allow(null),
  prenom: addStringMessages(PRELEVEUR_FIELDS.prenom.allow(null), 'prenom'),
  email: addStringMessages(PRELEVEUR_FIELDS.email.allow(null), 'email'),
  adresse_1: addStringMessages(PRELEVEUR_FIELDS.adresse_1.allow(null), 'adresse_1'),
  adresse_2: addStringMessages(PRELEVEUR_FIELDS.adresse_2.allow(null), 'adresse_2'),
  bp: addStringMessages(PRELEVEUR_FIELDS.bp.allow(null), 'bp'),
  code_postal: addStringMessages(PRELEVEUR_FIELDS.code_postal.allow(null), 'code_postal'),
  commune: addStringMessages(PRELEVEUR_FIELDS.commune.allow(null), 'commune'),
  numero_telephone: addStringMessages(PRELEVEUR_FIELDS.numero_telephone.allow(null), 'numero_telephone')
}).messages({
  'object.unknown': 'Une clé de l’objet est invalide.'
})

function validateCreation(preleveur) {
  return validatePayload(preleveur, preleveurSchema)
}

function validateChanges(changes) {
  return validatePayload(changes, preleveurSchema)
}

export {validateCreation, validateChanges}
