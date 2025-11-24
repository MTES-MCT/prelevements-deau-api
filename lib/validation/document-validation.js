import Joi from 'joi'
import {validatePayload} from '../util/payload.js'

export const NATURES_VALIDES = [
  'Autorisation AOT',
  'Autorisation CSP',
  'Autorisation CSP - IOTA',
  'Autorisation hydroélectricité',
  'Autorisation ICPE',
  'Autorisation IOTA',
  'Délibération abandon',
  'Rapport hydrogéologue agréé'
]

function validateNature(nature, helpers) {
  if (!NATURES_VALIDES.includes(nature)) {
    return helpers.message('Cette nature est invalide.')
  }

  return nature
}

function validateDate(date, helpers) {
  if (date === null) {
    return null
  }

  if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return helpers.message('La date est invalide.')
  }

  const parsedDate = new Date(date)

  if (parsedDate.toString() === 'Invalid Date') {
    return helpers.message('La date est invalide.')
  }

  return date
}

function addStringMessages(field, fieldName) {
  return field.messages({
    'string.base': `Le champ "${fieldName}" doit être une chaine de caractères.`,
    'string.empty': `Le champ "${fieldName}" ne peut pas être vide.`,
    'string.min': `Le champ "${fieldName}" doit contenir au moins {#limit} caractères.`,
    'string.max': `Le champ "${fieldName}" doit contenir au maximum {#limit} caractères.`
  })
}

const DOCUMENT_FIELDS = {
  nom_fichier: Joi.string().trim().min(3).max(200),
  reference: Joi.string().trim().min(3).max(200),
  nature: Joi.custom(validateNature),
  date_signature: Joi.custom(validateDate),
  date_fin_validite: Joi.custom(validateDate),
  date_ajout: Joi.custom(validateDate),
  remarque: Joi.string().trim().min(3).max(500)
}

const documentSchemaCreation = Joi.object().keys({
  nom_fichier: addStringMessages(DOCUMENT_FIELDS.nom_fichier.required(), 'nom_fichier'),
  reference: addStringMessages(DOCUMENT_FIELDS.reference.allow(null), 'reference'),
  nature: DOCUMENT_FIELDS.nature.required(),
  date_signature: DOCUMENT_FIELDS.date_signature.required().messages({
    'any.required': 'La date de signature est obligatoire.'
  }),
  date_fin_validite: DOCUMENT_FIELDS.date_fin_validite.allow(null),
  date_ajout: DOCUMENT_FIELDS.date_ajout.required().messages({
    'any.required': 'La date d’ajout est obligatoire.'
  }),
  remarque: addStringMessages(DOCUMENT_FIELDS.remarque.allow(null), 'remarque')
})

const documentSchemaEdition = Joi.object().keys({
  nom_fichier: addStringMessages(DOCUMENT_FIELDS.nom_fichier.allow(null), 'nom_fichier'),
  reference: addStringMessages(DOCUMENT_FIELDS.reference.allow(null), 'reference'),
  nature: DOCUMENT_FIELDS.nature.allow(null),
  date_signature: DOCUMENT_FIELDS.date_signature.allow(null),
  date_fin_validite: DOCUMENT_FIELDS.date_fin_validite.allow(null),
  date_ajout: DOCUMENT_FIELDS.date_ajout.allow(null),
  remarque: addStringMessages(DOCUMENT_FIELDS.remarque.allow(null), 'remarque')
})

function validateDocumentCreation(document) {
  return validatePayload(document, documentSchemaCreation)
}

function validateDocumentChanges(changes) {
  return validatePayload(changes, documentSchemaEdition)
}

export {validateDocumentCreation, validateDocumentChanges}
