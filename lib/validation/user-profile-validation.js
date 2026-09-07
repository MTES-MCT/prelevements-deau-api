import Joi from 'joi'

import {ValidationError, validatePayload} from '../util/payload.js'

function optionalText({max, min = 1} = {}) {
  return Joi.string()
    .trim()
    .empty('')
    .min(min)
    .max(max)
    .allow(null)
    .messages({
      'string.base': 'Cette information doit être du texte.',
      'string.min': `Saisissez au moins ${min} caractère${min > 1 ? 's' : ''}.`,
      'string.max': `Saisissez au maximum ${max} caractères.`
    })
}

const COMMON_FIELDS = {
  firstName: optionalText({max: 80}),
  lastName: optionalText({max: 80})
}

const CONTACT_FIELDS = {
  phoneNumber: Joi.string()
    .trim()
    .empty('')
    .pattern(/^\d{10}$/)
    .allow(null)
    .messages({
      'string.base': 'Le numéro de téléphone doit être du texte.',
      'string.pattern.base': 'Le numéro de téléphone doit contenir exactement 10 chiffres.'
    }),
  jobTitle: optionalText({min: 2, max: 200})
}

const DECLARANT_FIELDS = {
  civility: Joi.string()
    .trim()
    .empty('')
    .valid('MR', 'MRS')
    .allow(null)
    .messages({
      'any.only': 'Sélectionnez une civilité valide.',
      'string.base': 'La civilité doit être du texte.'
    }),
  ...CONTACT_FIELDS,
  addressLine1: optionalText({min: 3, max: 200}),
  addressLine2: optionalText({min: 3, max: 200}),
  poBox: optionalText({max: 20}),
  postalCode: Joi.string()
    .trim()
    .empty('')
    .pattern(/^\d{5}$/)
    .allow(null)
    .messages({
      'string.base': 'Le code postal doit être du texte.',
      'string.pattern.base': 'Le code postal doit contenir exactement 5 chiffres.'
    }),
  city: optionalText({min: 2, max: 100})
}

const REQUIRED_FIELD_MESSAGES = {
  firstName: 'Le prénom est obligatoire.',
  lastName: 'Le nom est obligatoire.',
  socialReason: 'La raison sociale est obligatoire pour une personne morale.'
}

function createChangesSchema(user) {
  const fields = {...COMMON_FIELDS}

  if (user.role === 'DECLARANT') {
    Object.assign(fields, DECLARANT_FIELDS)

    if (user.declarant?.declarantType === 'LEGAL_PERSON') {
      fields.socialReason = optionalText({min: 3, max: 200})
    }
  } else if (user.role === 'INSTRUCTOR') {
    Object.assign(fields, CONTACT_FIELDS)
  }

  return Joi.object(fields).min(1).required().messages({
    'object.base': 'Les modifications doivent être un objet.',
    'object.min': 'Indiquez au moins une information à modifier.',
    'object.unknown': 'Ce champ ne peut pas être modifié depuis Mon compte.'
  })
}

function isPresent(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeEmptyStrings(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return changes
  }

  return Object.fromEntries(
    Object.entries(changes).map(([field, value]) => [
      field,
      typeof value === 'string' && value.trim() === '' ? null : value
    ])
  )
}

function assertRequiredFinalFields(changes, user) {
  const currentProfile = {
    firstName: user.firstName,
    lastName: user.lastName,
    socialReason: user.declarant?.socialReason
  }
  const finalProfile = {...currentProfile, ...changes}
  const requiredFields = user.role === 'DECLARANT'
    && user.declarant?.declarantType === 'LEGAL_PERSON'
    ? ['socialReason']
    : ['firstName', 'lastName']
  const details = requiredFields
    .filter(field => !isPresent(finalProfile[field]))
    .map(field => ({
      path: field,
      type: 'any.required',
      message: REQUIRED_FIELD_MESSAGES[field]
    }))

  if (details.length > 0) {
    throw new ValidationError(details)
  }
}

export function validateUserProfileChanges(changes, user) {
  const value = validatePayload(normalizeEmptyStrings(changes), createChangesSchema(user))

  assertRequiredFinalFields(value, user)

  return value
}
