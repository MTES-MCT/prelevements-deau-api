import Joi from 'joi'
import createHttpError from 'http-errors'

import {
  listDeclarantContactEmails,
  MAX_DECLARANT_CONTACT_EMAILS,
  replaceDeclarantContactEmails
} from '../models/declarant-contact-email.js'

const contactEmailSchema = Joi.object({
  email: Joi.string().email({tlds: {allow: false}}).lowercase().required(),
  isPrimary: Joi.boolean().required()
}).unknown(false)

const replaceContactEmailsSchema = Joi.object({
  contactEmails: Joi.array()
    .items(contactEmailSchema)
    .max(MAX_DECLARANT_CONTACT_EMAILS)
    .required()
}).unknown(false)

export function validateDeclarantContactEmailsPayload(payload) {
  const {error, value} = replaceContactEmailsSchema.validate(payload, {
    abortEarly: false,
    stripUnknown: false
  })

  if (error) {
    throw createHttpError(400, error.message)
  }

  return value
}

export async function listDeclarantContactEmailsHandler(req, res) {
  const contactEmails = await listDeclarantContactEmails(req.params.declarantId)

  res.status(200).send({contactEmails})
}

export async function replaceDeclarantContactEmailsHandler(req, res) {
  const value = validateDeclarantContactEmailsPayload(req.body)

  const contactEmails = await replaceDeclarantContactEmails(
    req.params.declarantId,
    value.contactEmails
  )

  res.status(200).send({contactEmails})
}
