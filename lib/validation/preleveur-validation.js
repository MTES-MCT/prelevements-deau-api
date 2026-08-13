import Joi from 'joi'
import {ValidationError, validatePayload} from '../util/payload.js'
import {PRELEVEUR_TYPES} from '../services/preleveur-types.js'

function addStringMessages(field, fieldName) {
  return field.messages({
    'string.base': `Le champ "${fieldName}" doit être une chaine de caractères.`,
    'string.empty': `Le champ "${fieldName}" ne peut pas être vide.`,
    'string.min': `Le champ "${fieldName}" doit comporter au moins {#limit} caractères.`,
    'string.max': `Le champ "${fieldName}" ne doit pas comporter plus de {#limit} caractères.`,
    'string.email': `Le champ "${fieldName}" doit être une adresse email valide.`,
    'any.only': `Les valeurs valides pour le champ "${fieldName}" sont {#valids}.`,
    'any.required': `Le champ "${fieldName}" est obligatoire.`
  })
}

const optionalEmail = Joi.alternatives().try(
  Joi.string().email().lowercase(),
  Joi.valid(null)
)

const PRELEVEUR_FIELDS = {
  declarantType: Joi.string().valid('NATURAL_PERSON', 'LEGAL_PERSON'),
  declarantRole: Joi.string().valid('PRELEVEUR', 'COLLECTEUR'),
  preleveurType: Joi.string().valid(...PRELEVEUR_TYPES),
  quickDeclarationEnabled: Joi.boolean(),
  declarationNotificationsEnabled: Joi.boolean(),
  civility: Joi.string().valid('MR', 'MRS'),
  firstName: Joi.string().trim().min(1).max(80),
  lastName: Joi.string().trim().min(1).max(80),
  email: optionalEmail,
  jobTitle: Joi.string().trim().min(2).max(200),
  socialReason: Joi.string().trim().min(3).max(200),
  addressLine1: Joi.string().trim().min(3).max(200),
  addressLine2: Joi.string().trim().min(3).max(200),
  poBox: Joi.string().trim().min(1).max(20),
  postalCode: Joi.string().length(5),
  city: Joi.string().trim().min(2).max(100),
  phoneNumber: Joi.string().length(10),
  siret: Joi.string().length(14),
  sourceId: Joi.string().trim().min(1).max(200)
}

function createSchema({withDefaults}) {
  const schema = Joi.object().keys({
    declarantType: withDefaults
      ? PRELEVEUR_FIELDS.declarantType.default('NATURAL_PERSON')
      : PRELEVEUR_FIELDS.declarantType,
    declarantRole: withDefaults
      ? PRELEVEUR_FIELDS.declarantRole.default('PRELEVEUR')
      : PRELEVEUR_FIELDS.declarantRole,
    preleveurType: addStringMessages(PRELEVEUR_FIELDS.preleveurType.allow(null), 'Type de préleveur'),
    quickDeclarationEnabled: withDefaults
      ? PRELEVEUR_FIELDS.quickDeclarationEnabled.default(true)
      : PRELEVEUR_FIELDS.quickDeclarationEnabled,
    declarationNotificationsEnabled: withDefaults
      ? PRELEVEUR_FIELDS.declarationNotificationsEnabled.default(true)
      : PRELEVEUR_FIELDS.declarationNotificationsEnabled,
    civility: addStringMessages(PRELEVEUR_FIELDS.civility.allow(null), 'Civilité'),
    firstName: addStringMessages(PRELEVEUR_FIELDS.firstName.allow(null), 'Prénom'),
    lastName: addStringMessages(PRELEVEUR_FIELDS.lastName.allow(null), 'Nom'),
    email: addStringMessages(PRELEVEUR_FIELDS.email, 'Email'),
    jobTitle: addStringMessages(PRELEVEUR_FIELDS.jobTitle.allow(null), 'Fonction'),
    socialReason: addStringMessages(PRELEVEUR_FIELDS.socialReason.allow(null), 'Raison sociale'),
    addressLine1: addStringMessages(PRELEVEUR_FIELDS.addressLine1.allow(null), 'Adresse ligne 1'),
    addressLine2: addStringMessages(PRELEVEUR_FIELDS.addressLine2.allow(null), 'Adresse ligne 2'),
    poBox: addStringMessages(PRELEVEUR_FIELDS.poBox.allow(null), 'Boite postale'),
    postalCode: addStringMessages(PRELEVEUR_FIELDS.postalCode.allow(null), 'Code postal'),
    city: addStringMessages(PRELEVEUR_FIELDS.city.allow(null), 'Commune'),
    phoneNumber: addStringMessages(PRELEVEUR_FIELDS.phoneNumber.allow(null), 'Numéro de téléphone'),
    siret: addStringMessages(PRELEVEUR_FIELDS.siret.allow(null), 'SIRET'),
    sourceId: addStringMessages(PRELEVEUR_FIELDS.sourceId.allow(null), 'Identifiant source')
  }).messages({
    'object.unknown': 'Une clé de l’objet est invalide.'
  })

  return schema
}

const changesSchema = createSchema({withDefaults: false})

function validateCreation(preleveur, {requirePreleveurType = false} = {}) {
  const value = validatePayload(preleveur, createSchema({withDefaults: true}))

  if (requirePreleveurType
    && value.declarantRole !== 'COLLECTEUR'
    && !value.preleveurType) {
    throw new ValidationError([{
      path: 'preleveurType',
      type: 'any.required',
      message: 'Le champ "Type de préleveur" est obligatoire.'
    }])
  }

  return value
}

function validateChanges(changes) {
  return validatePayload(changes, changesSchema)
}

export {validateCreation, validateChanges}
