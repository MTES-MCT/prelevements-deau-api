import createHttpError from 'http-errors'

import Joi from 'joi'
import {createApiImport} from '../models/api-imports.js'
import {addJobProcessApiImport} from '../queues/jobs.js'

const jsonObjectSchema = Joi.object().custom((value, helpers) => {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    return helpers.error('any.invalid')
  }

  return value
}, 'JSON root object validation')

export const createApiImportSchema = Joi.object({
  payload: jsonObjectSchema.required()
}).required()

export async function createApiImportHandler(req, res) {
  const declarantUserId = req.user?.id

  if (!declarantUserId) {
    throw createHttpError(401, 'Utilisateur non authentifié')
  }

  const {error, value} = createApiImportSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true
  })

  if (error) {
    throw createHttpError(400, error.details.map(detail => detail.message).join(', '))
  }

  const apiImport = await createApiImport({
    declarantUserId,
    rawPayload: value.payload,
    status: 'PENDING'
  })

  await addJobProcessApiImport(apiImport.id)

  res.status(201).json(apiImport)
}
