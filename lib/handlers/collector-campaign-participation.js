import {stageAuditMutation} from '../audit/mutations.js'
import {getCollectorCampaignParticipationOptions, addCollectorCampaignParticipation} from '../services/collector-campaign-participation.js'

export async function getCollectorCampaignParticipationOptionsHandler(req, res) {
  res.send(await getCollectorCampaignParticipationOptions(req.user, req.query))
}

export async function addCollectorCampaignParticipationHandler(req, res) {
  const result = await addCollectorCampaignParticipation(req.user, req.params.campaignId, req.body, {
    onAdded: mutation => stageAuditMutation(req, mutation)
  })
  res.status(result.campaignParticipation.created ? 201 : 200).send(result)
}
