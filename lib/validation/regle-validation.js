import Joi from 'joi'
import {validatePayload} from '../util/payload.js'

export const PARAMETERS_VALIDES = [
  'volume prélevé',
  'relevé d\'index',
  'débit prélevé',
  'débit réservé',
  'chlorures',
  'nitrates',
  'sulfates',
  'température',
  'niveau piézométrique',
  'conductivité',
  'pH'
]

export const UNITS_VALIDES = [
  'm³',
  'L/s',
  'm³/h',
  'mg/L',
  'degrés Celsius',
  'm NGR',
  'µS/cm'
]

export const CONSTRAINTS_VALIDES = [
  'MIN',
  'MAX'
]

export const FREQUENCIES_VALIDES = [
  '1 day',
  '1 month',
  '1 year'
]

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
    'string.min': `Le champ "${fieldName}" doit comporter au moins {#limit} caractères.`,
    'string.max': `Le champ "${fieldName}" ne doit pas comporter plus de {#limit} caractères.`
  })
}

const REGLE_FIELDS = {
  parameter: Joi.string().valid(...PARAMETERS_VALIDES),
  frequency: Joi.string().valid(...FREQUENCIES_VALIDES),
  unit: Joi.string().valid(...UNITS_VALIDES),
  value: Joi.number(),
  constraint: Joi.string().valid(...CONSTRAINTS_VALIDES),
  validityStartDate: Joi.any().custom(validateDate),
  validityEndDate: Joi.any().custom(validateDate),
  annualPeriodStartDate: Joi.any().custom(validateDate),
  annualPeriodEndDate: Joi.any().custom(validateDate),
  comment: Joi.string().trim().min(3).max(500),
  documentId: Joi.string().guid({version: 'uuidv4'}),
  exploitationIds: Joi.array().items(Joi.string().guid({version: 'uuidv4'}))
}

export const regleSchemaCreation = Joi.object().keys({
  parameter: REGLE_FIELDS.parameter.required().messages({
    'any.required': 'Le paramètre est obligatoire.'
  }),
  frequency: Joi.when('parameter', {
    is: 'volume prélevé',
    then: REGLE_FIELDS.frequency.required().messages({ // eslint-disable-line unicorn/no-thenable -- Joi.when() utilise 'then' pour la validation conditionnelle
      'any.required': 'La fréquence est obligatoire pour le paramètre "volume prélevé".'
    }),
    otherwise: REGLE_FIELDS.frequency.allow(null).optional()
  }),
  unit: REGLE_FIELDS.unit.required().messages({
    'any.required': 'L\'unité est obligatoire.'
  }),
  value: REGLE_FIELDS.value.required().messages({
    'any.required': 'La valeur est obligatoire.',
    'number.base': 'La valeur doit être un nombre.'
  }),
  constraint: REGLE_FIELDS.constraint.required().messages({
    'any.required': 'La contrainte est obligatoire.'
  }),
  validityStartDate: REGLE_FIELDS.validityStartDate.required().messages({
    'any.required': 'La date de début de validité est obligatoire.'
  }),
  validityEndDate: REGLE_FIELDS.validityEndDate.allow(null),
  annualPeriodStartDate: REGLE_FIELDS.annualPeriodStartDate.allow(null),
  annualPeriodEndDate: REGLE_FIELDS.annualPeriodEndDate.allow(null),
  comment: addStringMessages(REGLE_FIELDS.comment.allow(null), 'comment'),
  documentId: REGLE_FIELDS.documentId.allow(null),
  exploitationIds: REGLE_FIELDS.exploitationIds.required().min(1).messages({
    'array.base': 'Les exploitations doivent être dans un tableau.',
    'any.required': 'Au moins une exploitation est obligatoire.',
    'array.min': 'Au moins une exploitation est obligatoire.'
  })
}).messages({
  'object.unknown': 'Une clé de l’objet est invalide.'
})

export const regleSchemaEdition = Joi.object().keys({
  parameter: REGLE_FIELDS.parameter,
  frequency: REGLE_FIELDS.frequency.allow(null),
  unit: REGLE_FIELDS.unit,
  value: REGLE_FIELDS.value.messages({
    'number.base': 'La valeur doit être un nombre.'
  }),
  constraint: REGLE_FIELDS.constraint,
  validityStartDate: REGLE_FIELDS.validityStartDate,
  validityEndDate: REGLE_FIELDS.validityEndDate.allow(null),
  annualPeriodStartDate: REGLE_FIELDS.annualPeriodStartDate.allow(null),
  annualPeriodEndDate: REGLE_FIELDS.annualPeriodEndDate.allow(null),
  comment: addStringMessages(REGLE_FIELDS.comment.allow(null), 'comment'),
  documentId: REGLE_FIELDS.documentId.allow(null),
  exploitationIds: REGLE_FIELDS.exploitationIds
}).messages({
  'object.unknown': 'Une clé de l’objet est invalide.'
})

export function validateRegleCreation(regle) {
  return validatePayload(regle, regleSchemaCreation)
}

export function validateRegleChanges(changes) {
  return validatePayload(changes, regleSchemaEdition)
}
