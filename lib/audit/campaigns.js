import {createHash} from 'node:crypto'
import {CAMPAIGN_MANUAL_PROVIDER} from '../services/campaign-readings.js'

export const CAMPAIGN_AUDIT_LABELS = Object.freeze({
  COLLECTION_CAMPAIGN: 'Campagne de collecte',
  COLLECTION_RESPONSE: 'Réponse de campagne',
  COLLECTION_METER: 'Publication d’un compteur de campagne'
})

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const responseFields = {id: true, campaignId: true, exploitationId: true, preleveurUserId: true,
  revision: true, firstSubmittedAt: true, lastSubmittedAt: true, declarationId: true, publicationStatus: true}

export async function loadCampaignAuditSnapshot(client, entityType, entityId, params) {
  if (entityType === 'COLLECTION_CAMPAIGN') {
    const campaign = await client.collectionCampaign.findUnique({where: {id: entityId}, select: {
      id: true, type: true, status: true, opensOn: true, closesOn: true, closedAt: true,
      collecteurUserId: true, createdByUserId: true,
      responses: {select: {exploitationId: true, preleveurUserId: true}, orderBy: {exploitationId: 'asc'}}
    }})
    if (!campaign) return null
    const {responses, ...snapshot} = campaign
    return {...snapshot, exploitationCount: responses.length, populationHash: hash(responses)}
  }

  if (entityType === 'COLLECTION_RESPONSE') {
    return client.collectionResponse.findFirst({where: {id: entityId, campaignId: params.campaignId}, select: responseFields})
  }

  const meter = await client.compteur.findUnique({where: {id: entityId}, select: {id: true}})
  if (!meter || !params.campaignId) return null
  const where = {compteurId: entityId, provider: CAMPAIGN_MANUAL_PROVIDER, scope: params.campaignId}
  const [streams, allocations, publications, responses] = await Promise.all([
    client.meterStream.findMany({where, select: {id: true, enabled: true, activatedAt: true}, orderBy: {id: 'asc'}}),
    client.meterAllocation.findMany({where, select: {id: true, exploitationId: true,
      versions: {select: {id: true, version: true, percentage: true, startDate: true, endDate: true,
        enabled: true, additive: true, usageId: true}, orderBy: {version: 'asc'}}}, orderBy: {id: 'asc'}}),
    client.meterPublication.findMany({where: {compteurId: entityId, active: true,
      stream: {provider: CAMPAIGN_MANUAL_PROVIDER, scope: params.campaignId}}, select: {id: true}, orderBy: {id: 'asc'}}),
    client.collectionResponse.findMany({where: {campaignId: params.campaignId,
      submittedData: {path: ['meters'], array_contains: [{compteurId: entityId}]}},
    select: {id: true, revision: true, publicationStatus: true, lastSubmittedAt: true}, orderBy: {id: 'asc'}})
  ])
  // Counts and fingerprints describe publication changes without retaining
  // questionnaire answers, physical index values, percentages or contact data.
  return {id: entityId, campaignId: params.campaignId, compteurId: entityId,
    streamIds: streams.map(stream => stream.id), enabled: streams.some(stream => stream.enabled), streamStateHash: hash(streams),
    allocationVersionCount: allocations.reduce((count, allocation) => count + allocation.versions.length, 0), allocationStateHash: hash(allocations),
    activePublicationCount: publications.length, publicationIds: publications.map(publication => publication.id),
    responseCount: responses.length, responseStateHash: hash(responses)}
}
