import Joi from 'joi'
import {validatePayload} from '../util/payload.js'

function addStringMessages(field, fieldName) {
  return field.messages({
    'string.base': `Le champ "${fieldName}" doit être une chaine de caractères.`,
    'string.empty': `Le champ "${fieldName}" ne peut pas être vide.`,
    'string.min': `Le champ "${fieldName}" doit comporter au moins {#limit} caractères.`,
    'string.max': `Le champ "${fieldName}" ne doit pas comporter plus de {#limit} caractères.`,
    'string.email': `Le champ "${fieldName}" doit être une adresse email valide.`,
    'any.only': `Les valeurs valides pour le champ "${fieldName}" sont {#valids}.`
  })
}

const PRELEVEUR_FIELDS = {
  raison_sociale: Joi.string().trim().min(3).max(200),
  sigle: Joi.string().trim().min(3).max(200),
  civilite: Joi.string().valid('M.', 'Mme'),
  nom: Joi.string().trim().min(1).max(50),
  prenom: Joi.string().trim().min(2).max(50),
  email: Joi.string().email().lowercase(),
  adresse_1: Joi.string().trim().min(3).max(200),
  adresse_2: Joi.string().trim().min(3).max(200),
  bp: Joi.string().trim().min(3).max(10),
  code_postal: Joi.string().length(5),
  commune: Joi.string().trim().min(3).max(100),
  numero_telephone: Joi.string().length(10),
  code_siren: Joi.string().length(9)
}

const preleveurSchema = Joi.object().keys({
  raison_sociale: addStringMessages(PRELEVEUR_FIELDS.raison_sociale.allow(null), 'Raison sociale'),
  sigle: addStringMessages(PRELEVEUR_FIELDS.sigle.allow(null), 'Sigle'),
  civilite: addStringMessages(PRELEVEUR_FIELDS.civilite.allow(null), 'Civilite'),
  nom: addStringMessages(PRELEVEUR_FIELDS.nom.allow(null), 'Nom'),
  prenom: addStringMessages(PRELEVEUR_FIELDS.prenom.allow(null), 'Prenom'),
  email: addStringMessages(PRELEVEUR_FIELDS.email.allow(null), 'Email'),
  adresse_1: addStringMessages(PRELEVEUR_FIELDS.adresse_1.allow(null), 'Adresse ligne 1'),
  adresse_2: addStringMessages(PRELEVEUR_FIELDS.adresse_2.allow(null), 'Adresse ligne 2'),
  bp: addStringMessages(PRELEVEUR_FIELDS.bp.allow(null), 'Boite postale'),
  code_postal: addStringMessages(PRELEVEUR_FIELDS.code_postal.allow(null), 'Code postal'),
  commune: addStringMessages(PRELEVEUR_FIELDS.commune.allow(null), 'Commune'),
  numero_telephone: addStringMessages(PRELEVEUR_FIELDS.numero_telephone.allow(null), 'Numéro de téléphone'),
  code_siren: addStringMessages(PRELEVEUR_FIELDS.code_siren.allow(null), 'Code siren')
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
