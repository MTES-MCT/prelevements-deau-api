import Joi from 'joi'
import {validatePayload} from '../util/payload.js'

export const PARAMETRES_VALIDES = [
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

export const UNITES_VALIDES = [
  'm³',
  'L/s',
  'm³/h',
  'mg/L',
  'degrés Celsius',
  'm NGR',
  'µS/cm'
]

export const CONTRAINTES_VALIDES = [
  'min',
  'max'
]

export const FREQUENCES_VALIDES = [
  '1 day',
  '1 month',
  '1 year'
]

function validateDate(date, helpers) {
  if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return helpers.message('La date est invalide.')
  }

  const parsedDate = new Date(date)

  if (parsedDate.toString() === 'Invalid Date') {
    return helpers.message('La date est invalide.')
  }

  return date
}

function validateParametre(parametre, helpers) {
  if (!PARAMETRES_VALIDES.includes(parametre)) {
    return helpers.message('Le paramètre est invalide.')
  }

  return parametre
}

function validateUnite(unite, helpers) {
  if (!UNITES_VALIDES.includes(unite)) {
    return helpers.message('L\'unité est invalide.')
  }

  return unite
}

function validateContrainte(contrainte, helpers) {
  if (!CONTRAINTES_VALIDES.includes(contrainte)) {
    return helpers.message('La contrainte est invalide.')
  }

  return contrainte
}

function validateFrequence(frequence, helpers) {
  if (!FREQUENCES_VALIDES.includes(frequence)) {
    return helpers.message('La fréquence est invalide.')
  }

  return frequence
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
  parametre: Joi.custom(validateParametre),
  frequence: Joi.custom(validateFrequence),
  unite: Joi.custom(validateUnite),
  valeur: Joi.number(),
  contrainte: Joi.custom(validateContrainte),
  debut_validite: Joi.custom(validateDate),
  fin_validite: Joi.custom(validateDate),
  debut_periode: Joi.custom(validateDate),
  fin_periode: Joi.custom(validateDate),
  remarque: Joi.string().trim().min(3).max(500),
  document: Joi.string().length(24).hex(),
  exploitations: Joi.array().items(Joi.string().length(24).hex())
}

export const regleSchemaCreation = Joi.object().keys({
  parametre: REGLE_FIELDS.parametre.required().messages({
    'any.required': 'Le paramètre est obligatoire'
  }),
  frequence: Joi.when('parametre', {
    is: 'volume prélevé',
    then: REGLE_FIELDS.frequence.required().messages({ // eslint-disable-line unicorn/no-thenable -- Joi.when() utilise 'then' pour la validation conditionnelle
      'any.required': 'La fréquence est obligatoire pour le paramètre "volume prélevé".'
    }),
    otherwise: REGLE_FIELDS.frequence.allow(null).optional()
  }),
  unite: REGLE_FIELDS.unite.required().messages({
    'any.required': 'L\'unité est obligatoire.'
  }),
  valeur: REGLE_FIELDS.valeur.required().messages({
    'any.required': 'La valeur est obligatoire.',
    'number.base': 'La valeur doit être un nombre.'
  }),
  contrainte: REGLE_FIELDS.contrainte.required().messages({
    'any.required': 'La contrainte est obligatoire.'
  }),
  debut_validite: REGLE_FIELDS.debut_validite.required().messages({
    'any.required': 'La date de début de validité est obligatoire.'
  }),
  fin_validite: REGLE_FIELDS.fin_validite.allow(null),
  debut_periode: REGLE_FIELDS.debut_periode.allow(null),
  fin_periode: REGLE_FIELDS.fin_periode.allow(null),
  remarque: addStringMessages(REGLE_FIELDS.remarque.allow(null), 'remarque'),
  document: REGLE_FIELDS.document.allow(null),
  exploitations: REGLE_FIELDS.exploitations.required().min(1).messages({
    'array.base': 'Les exploitations doivent être dans un tableau.',
    'any.required': 'Au moins une exploitation est obligatoire.',
    'array.min': 'Au moins une exploitation est obligatoire.'
  })
})

export const regleSchemaEdition = Joi.object().keys({
  parametre: REGLE_FIELDS.parametre,
  frequence: REGLE_FIELDS.frequence.allow(null),
  unite: REGLE_FIELDS.unite,
  valeur: REGLE_FIELDS.valeur.messages({
    'number.base': 'La valeur doit être un nombre.'
  }),
  contrainte: REGLE_FIELDS.contrainte,
  debut_validite: REGLE_FIELDS.debut_validite,
  fin_validite: REGLE_FIELDS.fin_validite.allow(null),
  debut_periode: REGLE_FIELDS.debut_periode.allow(null),
  fin_periode: REGLE_FIELDS.fin_periode.allow(null),
  remarque: addStringMessages(REGLE_FIELDS.remarque.allow(null), 'remarque'),
  document: REGLE_FIELDS.document.allow(null),
  exploitations: REGLE_FIELDS.exploitations
})

export function validateRegleCreation(regle) {
  return validatePayload(regle, regleSchemaCreation)
}

export function validateRegleChanges(changes) {
  return validatePayload(changes, regleSchemaEdition)
}
