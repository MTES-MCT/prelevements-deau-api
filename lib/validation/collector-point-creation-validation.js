import Joi from 'joi'
import createHttpError from 'http-errors'
import {validatePayload} from '../util/payload.js'
import {validateCreation as validatePointCreation} from './point-validation.js'
import {validateCreation as validatePreleveurCreation} from './preleveur-validation.js'
import {validateCreation as validateExploitationCreation} from './exploitation-validation.js'
import {canonicalizeCollectorCommune} from './collector-point-management-validation.js'

const POINT_FIELDS = [
  'name', 'usageName', 'coordinates', 'communeCode', 'communeName',
  'geometryPrecision', 'waterBodyType', 'flowType', 'nature', 'withdrawalType',
  'commissioningDate', 'locationDescription', 'comment', 'depth',
  'reservoirNominalVolume', 'isWaterBodyConnectedToStream', 'isWaterBodyConnectedToGroundwater'
]
const PRELEVEUR_FIELDS = [
  'declarantType', 'preleveurType', 'civility', 'firstName', 'lastName',
  'email', 'jobTitle', 'socialReason', 'addressLine1', 'addressLine2',
  'poBox', 'postalCode', 'city', 'phoneNumber', 'siret'
]
const EXPLOITATION_FIELDS = ['usageId', 'secondaryUsageIds', 'status', 'startDate', 'endDate']
const fieldsSchema = fields => Joi.object(Object.fromEntries(fields.map(field => [field, Joi.any()])))
const creationSchema = Joi.object({
  requestId: Joi.string().guid().required(),
  point: fieldsSchema(POINT_FIELDS).required(),
  preleveurId: Joi.string().guid(),
  preleveur: fieldsSchema(PRELEVEUR_FIELDS),
  exploitation: fieldsSchema(EXPLOITATION_FIELDS).required(),
  notifyAccountCreation: Joi.boolean().strict().default(false)
}).xor('preleveurId', 'preleveur')

function assertCalendarDate(value) {
  if (value === null || value === undefined) return
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime())
    || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw createHttpError(400, 'La période d’activité contient une date invalide.')
  }
}

export function validateCollectorPointCreation(payload) {
  const value = validatePayload(payload, creationSchema)
  value.point = validatePointCreation({
    ...canonicalizeCollectorCommune(value.point),
    pointKind: 'PHYSIQUE'
  })

  if (value.preleveur) {
    value.preleveur = validatePreleveurCreation({
      ...value.preleveur,
      ...(typeof value.preleveur.email === 'string' ? {email: value.preleveur.email.trim()} : {}),
      declarantRole: 'PRELEVEUR'
    }, {requirePreleveurType: true})
    if (value.preleveur.declarantType === 'LEGAL_PERSON' && !value.preleveur.socialReason) {
      throw createHttpError(400, 'La raison sociale est obligatoire pour une personne morale.')
    }

    if (value.preleveur.declarantType === 'NATURAL_PERSON'
      && (!value.preleveur.firstName || !value.preleveur.lastName)) {
      throw createHttpError(400, 'Le prénom et le nom sont obligatoires pour une personne physique.')
    }

    if (value.preleveur.siret && !/^\d{14}$/.test(value.preleveur.siret)) {
      throw createHttpError(400, 'Le SIRET doit contenir 14 chiffres.')
    }
  }

  if (value.notifyAccountCreation && !value.preleveur?.email) {
    throw createHttpError(400, 'L’invitation est réservée aux nouveaux préleveurs avec une adresse email.')
  }

  assertCalendarDate(value.exploitation.startDate)
  assertCalendarDate(value.exploitation.endDate)
  // Reuse the established exploitation contract; these placeholders only
  // validate fields here and are replaced by server-owned IDs in the service.
  const validatedExploitation = validateExploitationCreation({
    ...value.exploitation,
    declarantUserId: value.requestId,
    pointPrelevementId: value.requestId
  })
  delete validatedExploitation.declarantUserId
  delete validatedExploitation.pointPrelevementId
  if (validatedExploitation.startDate && validatedExploitation.endDate
    && validatedExploitation.startDate > validatedExploitation.endDate) {
    throw createHttpError(400, 'La date de début doit précéder la date de fin.')
  }

  value.exploitation = validatedExploitation
  return value
}
