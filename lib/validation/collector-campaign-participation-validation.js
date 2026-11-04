import Joi from 'joi'
import {validatePayload} from '../util/payload.js'

const uuid = Joi.string().guid()

export function validateCampaignParticipationOptions(query) {
  return validatePayload(query, Joi.object({
    exploitationId: uuid,
    page: Joi.number().integer().min(1).default(1),
    pageSize: Joi.number().integer().min(1).max(100).default(50)
  }))
}

export function validateCampaignParticipationBody(payload) {
  return validatePayload(payload, Joi.object({exploitationId: uuid.required()}))
}
