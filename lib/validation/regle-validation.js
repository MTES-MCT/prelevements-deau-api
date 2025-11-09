import Joi from 'joi'
import {validatePayload} from '../util/payload.js'
import {contraintes, parametres, unites} from '../nomenclature.js'

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
  if (!Object.values(parametres).includes(parametre)) {
    return helpers.message('Le paramètre est invalide.')
  }

  return parametre
}

function validateUnite(unite, helpers) {
  if (!Object.values(unites).includes(unite)) {
    return helpers.message('L\'unité est invalide.')
  }

  return unite
}

function validateContrainte(contrainte, helpers) {
  if (!Object.values(contraintes).includes(contrainte)) {
    return helpers.message('La contrainte est invalide.')
  }

  return contrainte
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
