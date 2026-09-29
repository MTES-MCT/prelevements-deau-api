import Joi from 'joi'

// Application-created IDs are v4; replayable imports also create stable v5 IDs.
export const resourceIdSchema = Joi.string().guid({version: ['uuidv4', 'uuidv5']})
