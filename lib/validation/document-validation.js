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
  if (date === null || date === '') {
    return null
  }

  if (date instanceof Date && !Number.isNaN(date.getTime())) {
    return date
  }

  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return helpers.message('La date est invalide.')
  }

  const parsedDate = new Date(`${date}T00:00:00.000Z`)

  if (Number.isNaN(parsedDate.getTime())) {
    return helpers.message('La date est invalide.')
  }

  return parsedDate
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
  title: Joi.string().trim().min(3).max(200),
  reference: Joi.string().trim().min(3).max(200),
  nature: Joi.custom(validateNature),
  signatureDate: Joi.any().custom(validateDate),
  validityEndDate: Joi.any().custom(validateDate),
  comment: Joi.string().trim().min(3).max(500),
  declarantPointPrelevementId: Joi.string().guid({version: 'uuidv4'})
}

const documentSchemaCreation = Joi.object().keys({
  title: addStringMessages(DOCUMENT_FIELDS.title.allow(null), 'title'),
  reference: addStringMessages(DOCUMENT_FIELDS.reference.allow(null), 'reference'),
  nature: DOCUMENT_FIELDS.nature.required(),
  signatureDate: DOCUMENT_FIELDS.signatureDate.required().messages({
    'any.required': 'La date de signature est obligatoire.'
  }),
  validityEndDate: DOCUMENT_FIELDS.validityEndDate.allow(null),
  comment: addStringMessages(DOCUMENT_FIELDS.comment.allow(null), 'comment'),
  declarantPointPrelevementId: DOCUMENT_FIELDS.declarantPointPrelevementId.allow(null)
})

const documentSchemaEdition = Joi.object().keys({
  title: addStringMessages(DOCUMENT_FIELDS.title.allow(null), 'title'),
  reference: addStringMessages(DOCUMENT_FIELDS.reference.allow(null), 'reference'),
  nature: DOCUMENT_FIELDS.nature.allow(null),
  signatureDate: DOCUMENT_FIELDS.signatureDate.allow(null),
  validityEndDate: DOCUMENT_FIELDS.validityEndDate.allow(null),
  comment: addStringMessages(DOCUMENT_FIELDS.comment.allow(null), 'comment'),
  declarantPointPrelevementId: DOCUMENT_FIELDS.declarantPointPrelevementId.allow(null)
})

function validateDocumentCreation(document) {
  return validatePayload(document, documentSchemaCreation)
}

function validateDocumentChanges(changes) {
  return validatePayload(changes, documentSchemaEdition)
}

export {validateDocumentCreation, validateDocumentChanges}
