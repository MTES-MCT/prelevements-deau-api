import Joi from 'joi'
import {validatePayload} from '../util/payload.js'
import {natures} from '../nomenclature.js'

function validateNature(nature, helpers) {
  if (!Object.values(natures).includes(nature)) {
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
    'string.empty': `Le champ "${fieldName}" ne peut pas être vide.`
  })
}

const documentSchema = Joi.object().keys({
  nom_fichier: addStringMessages(Joi.string().trim().min(3).max(200).required(), 'nom_fichier'),
  reference: addStringMessages(Joi.string().trim().min(3).max(200).allow(null), 'reference'),
  nature: Joi.custom(validateNature).required(),
  date_signature: Joi.custom(validateDate).required().messages({
    'any.required': 'La date de signature est obligatoire.'
  }),
  date_fin_validite: Joi.custom(validateDate).allow(null),
  date_ajout: Joi.custom(validateDate).required().messages({
    'any.required': 'La date d’ajout est obligatoire.'
  }),
  remarque: addStringMessages(Joi.string().trim().min(3).max(500).allow(null), 'remarque')
})

export function validateDocumentCreation(document) {
  return validatePayload(document, documentSchema)
}
