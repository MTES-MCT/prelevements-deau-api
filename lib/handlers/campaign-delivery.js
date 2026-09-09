import createHttpError from 'http-errors'
import Joi from 'joi'
import {createCampaignExport, getCampaignExport, listCampaignExports, listCampaignNotifications, remindCampaign} from '../services/campaign-delivery.js'

const idSchema = Joi.string().guid().required()

function validatedId(value) {
  const result = idSchema.validate(value)
  if (result.error) {
    throw createHttpError(400, 'Identifiant invalide.')
  }

  return result.value
}

function handler(action, status = 200) {
  return async (req, res, next) => {
    try {
      const campaignId = validatedId(req.params.campaignId)
      const data = await action(req, campaignId)
      res.status(status).send({success: true, data})
    } catch (error) {
      next(error)
    }
  }
}

export const createCampaignExportHandler = handler((req, campaignId) => createCampaignExport(req.user, campaignId), 202)
export const listCampaignExportsHandler = handler((req, campaignId) => listCampaignExports(req.user, campaignId))
export const getCampaignExportHandler = handler((req, campaignId) => getCampaignExport(req.user, campaignId, validatedId(req.params.exportId)))
export const listCampaignNotificationsHandler = handler((req, campaignId) => listCampaignNotifications(req.user, campaignId))
export const remindCampaignHandler = handler((req, campaignId) => remindCampaign(req.user, campaignId), 202)
