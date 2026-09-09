import Joi from 'joi'
import {
  createCampaign, updateCampaign, updateCampaignManagers, listCampaigns, getCampaignDetail, changeCampaignStatus,
  getCampaignContext, getCampaignOptions, listCampaignResponses, saveCampaignResponse,
  submitCampaignResponse, reopenCampaignResponse, manageCampaignMeter, serializeCampaign, getCampaignResponseHistory
} from '../services/campaigns.js'
import {validateCampaignValue} from '../validation/campaigns.js'
import {listCampaignRequests, campaignRequestsQuerySchema} from '../services/campaign-requests.js'

const id = Joi.string().guid({version: ['uuidv4', 'uuidv5', 'uuidv7']})

function params(req) {
  return validateCampaignValue(Joi.object({campaignId: id, targetId: id, associationId: id, kind: Joi.string().valid('INDEX', 'NEEDS')}), req.params)
}

const send = (res, data, status = 200) => res.status(status).send({success: true, data})

export async function listCampaignsHandler(req, res) {
  send(res, await listCampaigns(req.user))
}

export async function listCampaignRequestsHandler(req, res) {
  send(res, await listCampaignRequests(req.user, validateCampaignValue(campaignRequestsQuerySchema, req.query)))
}

export async function createCampaignHandler(req, res) {
  send(res, await createCampaign(req.user, req.body), 201)
}

export async function getCampaignHandler(req, res) {
  send(res, await getCampaignDetail(req.user, params(req).campaignId))
}

export async function updateCampaignHandler(req, res) {
  send(res, await updateCampaign(req.user, params(req).campaignId, req.body))
}

export async function updateCampaignManagersHandler(req, res) {
  send(res, await updateCampaignManagers(req.user, params(req).campaignId, req.body))
}

export async function openCampaignHandler(req, res) {
  send(res, await changeCampaignStatus(req.user, params(req).campaignId, 'OPEN', req.body))
}

export async function closeCampaignHandler(req, res) {
  send(res, await changeCampaignStatus(req.user, params(req).campaignId, 'CLOSED', req.body))
}

export async function getCampaignContextHandler(req, res) {
  const query = validateCampaignValue(Joi.object({preleveurUserId: id}), req.query)
  send(res, await getCampaignContext(req.user, params(req).campaignId, query.preleveurUserId))
}

export async function getCampaignOptionsHandler(req, res) {
  const query = validateCampaignValue(Joi.object({zoneId: id, ownerCollecteurUserId: id, usageId: id, q: Joi.string().max(100).allow(''), cursor: id, limit: Joi.number().integer().min(1).max(500)}), req.query)
  send(res, await getCampaignOptions(req.user, query))
}

export async function listCampaignResponsesHandler(req, res) {
  const result = await listCampaignResponses(req.user, params(req).campaignId)
  const campaign = serializeCampaign(result.campaign, result.permissions)
  send(res, {...result, campaign, targets: campaign.targets})
}

export async function getCampaignResponseHistoryHandler(req, res) {
  const query = validateCampaignValue(Joi.object({preleveurUserId: id.required(), cursor: id}), req.query)
  const {campaignId, kind} = params(req)
  send(res, await getCampaignResponseHistory(req.user, campaignId, kind, query))
}

export async function saveCampaignResponseHandler(req, res) {
  const {campaignId, kind} = params(req)
  send(res, await saveCampaignResponse(req.user, campaignId, kind, req.body))
}

export async function submitCampaignResponseHandler(req, res) {
  const {campaignId, kind} = params(req)
  send(res, await submitCampaignResponse(req.user, campaignId, kind, req.body))
}

export async function reopenCampaignResponseHandler(req, res) {
  const {campaignId, kind} = params(req)
  send(res, await reopenCampaignResponse(req.user, campaignId, kind, req.body))
}

export async function manageCampaignMeterHandler(req, res) {
  const {campaignId, targetId, associationId} = params(req)
  send(res, await manageCampaignMeter(req.user, campaignId, targetId, associationId, req.body))
}
