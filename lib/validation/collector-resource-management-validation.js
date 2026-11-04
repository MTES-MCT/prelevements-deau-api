import Joi from 'joi'
import createHttpError from 'http-errors'
import {validatePayload} from '../util/payload.js'
import {validateCreation as validatePreleveurCreation} from './preleveur-validation.js'
import {validateCreation as validateExploitationCreation, validateChanges as validateExploitationChanges} from './exploitation-validation.js'
import {collectorNewMetersSchema, collectorNewMeterSchema, collectorMeterChangesSchema} from './collector-point-form-validation.js'
import {normalizeDeclarantContactEmails} from '../models/declarant-contact-email.js'

export const COLLECTOR_CONTACT_FIELDS = Object.freeze(['phoneNumber', 'addressLine1', 'addressLine2', 'poBox', 'postalCode', 'city'])
export const COLLECTOR_EXPLOITATION_FIELDS = Object.freeze(['usageId', 'secondaryUsageIds', 'status', 'startDate', 'endDate', 'abandonReason', 'countingCode'])
const preleveurFields = ['declarantType', 'preleveurType', 'civility', 'firstName', 'lastName', 'email', 'jobTitle', 'socialReason',
  'addressLine1', 'addressLine2', 'poBox', 'postalCode', 'city', 'phoneNumber', 'siret']
const objectFields = fields => Joi.object(Object.fromEntries(fields.map(field => [field, Joi.any()])))
const version = Joi.string().pattern(/^[a-f\d]{64}$/).required()

export function assertCollectorCalendarDates(value) {
  for (const field of ['startDate', 'endDate']) {
    const date = value[field]
    if (date === null || date === undefined) continue
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || Number.isNaN(new Date(`${date}T00:00:00.000Z`).getTime())
      || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) {
      throw createHttpError(400, 'La période d’activité contient une date invalide.')
    }
  }
}

export function validateCollectorExploitationCreation(payload) {
  const value = validatePayload(payload, Joi.object({
    requestId: Joi.string().uuid().required(),
    preleveurId: Joi.string().uuid(),
    preleveur: objectFields(preleveurFields),
    exploitation: objectFields(COLLECTOR_EXPLOITATION_FIELDS).keys({meters: collectorNewMetersSchema}).required(),
    campaignId: Joi.string().uuid(),
    notifyAccountCreation: Joi.boolean().strict().default(false)
  }).xor('preleveurId', 'preleveur'))
  if (value.preleveur) {
    value.preleveur = validatePreleveurCreation({...value.preleveur,
      ...(typeof value.preleveur.email === 'string' ? {email: value.preleveur.email.trim()} : {}), declarantRole: 'PRELEVEUR'},
    {requirePreleveurType: true})
    if (value.preleveur.declarantType === 'LEGAL_PERSON' ? !value.preleveur.socialReason : (!value.preleveur.firstName || !value.preleveur.lastName)) {
      throw createHttpError(400, 'Renseignez l’identité complète du nouveau préleveur.')
    }
    if (value.preleveur.siret && !/^\d{14}$/.test(value.preleveur.siret)) throw createHttpError(400, 'Le SIRET doit contenir 14 chiffres.')
  }
  if (value.notifyAccountCreation && !value.preleveur?.email) throw createHttpError(400, 'L’invitation est réservée aux nouveaux préleveurs avec une adresse email.')
  assertCollectorCalendarDates(value.exploitation)
  const {meters, ...exploitation} = value.exploitation
  const validated = validateExploitationCreation({...exploitation, declarantUserId: value.requestId, pointPrelevementId: value.requestId})
  delete validated.declarantUserId
  delete validated.pointPrelevementId
  if (validated.startDate && validated.endDate && validated.startDate > validated.endDate) throw createHttpError(400, 'La date de début doit précéder la date de fin.')
  value.exploitation = {...validated, ...(meters ? {meters} : {})}
  return value
}

export function validateCollectorExploitationUpdate(payload) {
  const value = validatePayload(payload, Joi.object({
    version,
    changes: objectFields(COLLECTOR_EXPLOITATION_FIELDS).default({}),
    meters: Joi.array().items(Joi.alternatives().try(collectorMeterChangesSchema, collectorNewMeterSchema)).min(1).max(100)
  }))
  assertCollectorCalendarDates(value.changes)
  value.changes = validateExploitationChanges(value.changes)
  if (!Object.keys(value.changes).length && !value.meters?.length) throw createHttpError(400, 'Aucun champ à modifier.')
  return value
}

const text = (min, max) => Joi.string().trim().min(min).max(max).allow('', null).custom(value => value || null)
export function validateCollectorContactDetails(payload) {
  const value = validatePayload(payload, Joi.object({
    version,
    details: Joi.object({
      phoneNumber: Joi.string().trim().pattern(/^\d{10}$/).allow('', null).custom(value => value || null),
      addressLine1: text(3, 200), addressLine2: text(3, 200), poBox: text(1, 20),
      postalCode: Joi.string().trim().pattern(/^\d{5}$/).allow('', null).custom(value => value || null),
      city: text(2, 100),
      contactEmails: Joi.array().items(Joi.object({email: Joi.string().required(), isPrimary: Joi.boolean().strict()})).max(20)
    }).min(1).required()
  }))
  if (value.details.contactEmails) value.details.contactEmails = normalizeDeclarantContactEmails(value.details.contactEmails)
  return value
}
