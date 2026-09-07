import Joi from 'joi'

import {
  ADMIN_AGENT_ACCESS_STATUSES,
  ADMIN_AGENT_ACCOUNT_STATUS_FILTERS,
  ADMIN_AGENT_SORT_FIELDS
} from '../constants/admin-agents.js'
import {ZONE_PERMISSION_CODES} from '../constants/zone-permissions.js'

export const adminAgentIdSchema = Joi.string().guid({version: 'uuidv4'})

export const adminAgentsListQuerySchema = Joi.object({
  query: Joi.string().trim().max(200).allow('', null).default(''),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().valid(10, 25, 50).default(25),
  accountStatus: Joi.string().uppercase()
    .valid(...ADMIN_AGENT_ACCOUNT_STATUS_FILTERS)
    .allow('', null)
    .default('ACTIVE'),
  zoneIds: Joi.array().items(adminAgentIdSchema).max(100).unique().default([]),
  accessStatuses: Joi.array()
    .items(Joi.string().uppercase().valid(...ADMIN_AGENT_ACCESS_STATUSES))
    .unique()
    .default([]),
  sort: Joi.string().uppercase()
    .valid(...ADMIN_AGENT_SORT_FIELDS)
    .allow('', null)
    .default(null),
  order: Joi.string().uppercase().valid('ASC', 'DESC').default('ASC')
})

const optionalText = ({max, min = 1} = {}) => Joi.string()
  .trim()
  .empty('')
  .min(min)
  .max(max)
  .allow(null)
  .default(null)

export const adminAgentCreationSchema = Joi.object({
  email: Joi.string().trim().email({tlds: {allow: false}}).max(320).required(),
  firstName: Joi.string().trim().min(1).max(80).required(),
  lastName: Joi.string().trim().min(1).max(80).required(),
  phoneNumber: Joi.string()
    .trim()
    .empty('')
    .pattern(/^\d{10}$/)
    .allow(null)
    .default(null),
  jobTitle: optionalText({min: 2, max: 200}),
  zoneId: adminAgentIdSchema.required(),
  startDate: Joi.date().iso().required(),
  endDate: Joi.date().iso().allow(null).default(null),
  permissions: Joi.array()
    .items(Joi.string().valid(...ZONE_PERMISSION_CODES))
    .min(1)
    .unique()
    .required(),
  notifyAccountCreation: Joi.boolean().default(false),
  notifyZoneAttachment: Joi.boolean().default(false)
}).custom((value, helpers) => {
  if (value.endDate && value.startDate > value.endDate) {
    return helpers.error('date.range')
  }

  return value
}, 'cohérence de la période')
