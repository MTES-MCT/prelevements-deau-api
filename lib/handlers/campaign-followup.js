import Joi from 'joi'
import {getCampaignResponseSummary, listCampaignResponseOverview, getCampaignResponseResults} from '../services/campaign-followup.js'
import {campaignFollowupOverviewQuerySchema, campaignFollowupResultsQuerySchema, validateCampaignValue} from '../validation/campaigns.js'

const paramsSchema = Joi.object({campaignId: Joi.string().guid({version: ['uuidv4', 'uuidv5', 'uuidv7']}).required()})
const send = (res, data) => res.set('Cache-Control', 'no-store').status(200).send({success: true, data})

export function createCampaignFollowupHandlers({getSummary = getCampaignResponseSummary, listOverview = listCampaignResponseOverview, getResults = getCampaignResponseResults} = {}) {
  return {
    async getCampaignResponseSummaryHandler(req, res) {
      const {campaignId} = validateCampaignValue(paramsSchema, req.params)
      validateCampaignValue(Joi.object({}), req.query)
      send(res, await getSummary(req.user, campaignId))
    },
    async listCampaignResponseOverviewHandler(req, res) {
      const {campaignId} = validateCampaignValue(paramsSchema, req.params)
      const query = validateCampaignValue(campaignFollowupOverviewQuerySchema, req.query)
      send(res, await listOverview(req.user, campaignId, query))
    },
    async getCampaignResponseResultsHandler(req, res) {
      const {campaignId} = validateCampaignValue(paramsSchema, req.params)
      const query = validateCampaignValue(campaignFollowupResultsQuerySchema, req.query)
      send(res, await getResults(req.user, campaignId, query))
    }
  }
}

export const {getCampaignResponseSummaryHandler, listCampaignResponseOverviewHandler, getCampaignResponseResultsHandler} = createCampaignFollowupHandlers()
