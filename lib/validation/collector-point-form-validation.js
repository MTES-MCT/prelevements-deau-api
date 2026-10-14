import Joi from 'joi'
import createHttpError from 'http-errors'
import {validatePayload} from '../util/payload.js'
import {normalizeCountingCode} from '../services/exploitation-periods.js'
import {COLLECTOR_POINT_EDITABLE_FIELDS, validateCollectorPointChanges} from './collector-point-management-validation.js'

const serialNumber = Joi.string().trim().max(100)
export const collectorNewMeterSchema = Joi.object({serialNumber: serialNumber.min(1).required()})
export const collectorMeterChangesSchema = Joi.object({
  id: Joi.string().uuid().required(),
  expectedUpdatedAt: Joi.string().isoDate().required(),
  serialNumber: serialNumber.allow('', null).custom(value => value || null).required()
})
export const collectorNewMetersSchema = Joi.array().items(collectorNewMeterSchema).max(100)
const countingCode = Joi.string().trim().max(255).allow('', null).custom(normalizeCountingCode)
const exploitationSchema = Joi.object({
  id: Joi.string().uuid().required(),
  countingCode,
  expectedCountingCode: countingCode,
  meters: Joi.array().items(Joi.alternatives().try(collectorMeterChangesSchema, collectorNewMeterSchema)).min(1).max(100)
}).with('countingCode', 'expectedCountingCode').with('expectedCountingCode', 'countingCode').or('countingCode', 'meters')

export function validateCollectorPointForm(payload) {
  const value = validatePayload(payload, Joi.object({
    expectedUpdatedAt: Joi.string().isoDate().required(),
    point: Joi.object(Object.fromEntries(COLLECTOR_POINT_EDITABLE_FIELDS.map(field => [field, Joi.any()]))).default({}),
    exploitations: Joi.array().items(exploitationSchema).unique('id').max(100).default([])
  }))
  value.point = Object.keys(value.point).length
    ? validateCollectorPointChanges({...value.point, expectedUpdatedAt: value.expectedUpdatedAt}).changes
    : {}
  for (const exploitation of value.exploitations) {
    if (Object.hasOwn(exploitation, 'countingCode')) {
      exploitation.countingCode = normalizeCountingCode(exploitation.countingCode)
      exploitation.expectedCountingCode = normalizeCountingCode(exploitation.expectedCountingCode)
    }
    for (const meter of exploitation.meters ?? []) meter.serialNumber = meter.serialNumber || null
  }
  const meterIds = value.exploitations.flatMap(exploitation => exploitation.meters ?? []).map(meter => meter.id).filter(Boolean)
  if (new Set(meterIds).size !== meterIds.length) throw createHttpError(400, 'Un compteur ne peut être modifié qu’une fois dans cette demande.')
  if (!Object.keys(value.point).length && !value.exploitations.length) throw createHttpError(400, 'Aucun champ à modifier.')
  return value
}
