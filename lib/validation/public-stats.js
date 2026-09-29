import Joi from 'joi'

export const publicStatsQuerySchema = Joi.object({
  month: Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])$/)
}).unknown(false)
