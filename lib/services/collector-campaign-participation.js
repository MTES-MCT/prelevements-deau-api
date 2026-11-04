import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {validateCampaignId} from '../validation/collection-campaigns.js'
import {validateCampaignParticipationBody, validateCampaignParticipationOptions} from '../validation/collector-campaign-participation-validation.js'
import {assertCollectorPointManagementEnabled} from './collector-point-management.js'
import {campaignDate, isCampaignOpen} from './collection-campaigns.js'
import {isDatabaseWriteConflict} from '../util/database-write-conflict.js'
import {collectorDate, collectorDay} from './collector-calendar.js'

const campaignSelect = {id: true, name: true, status: true, opensOn: true, closesOn: true, closedAt: true, collecteurUserId: true}
const responseSelect = {id: true, campaignId: true, exploitationId: true, preleveurUserId: true,
  revision: true, firstSubmittedAt: true, lastSubmittedAt: true, declarationId: true, publicationStatus: true}
const exploitationSelect = {
  id: true, declarantUserId: true, pointPrelevementId: true, status: true, startDate: true, endDate: true,
  declarant: {select: {declarantRole: true, quickDeclarationEnabled: true, user: {select: {role: true, deletedAt: true}}}},
  pointPrelevement: {select: {deletedAt: true, flowType: true, collectionMode: true}}
}

function participationError(status, code, message) {
  const error = createHttpError(status, message)
  error.data = {code}
  return error
}

function assertOpen(campaign, now) {
  if (!isCampaignOpen(campaign, now)) throw participationError(409, 'CAMPAIGN_NOT_OPEN',
    'Cette campagne n’est plus ouverte. Vos saisies sont conservées : choisissez une autre campagne ou décochez la création du formulaire.')
}

function exploitationBlocker(exploitation, now) {
  const today = collectorDate(now)
  if (!['EN_ACTIVITE', 'NON_RENSEIGNE'].includes(exploitation.status)
    || (exploitation.startDate && campaignDate(exploitation.startDate) > today)
    || (exploitation.endDate && campaignDate(exploitation.endDate) < today)) {
    return 'L’exploitation doit être actuellement en activité pour créer un formulaire.'
  }
  if (exploitation.declarant.declarantRole !== 'PRELEVEUR' || exploitation.declarant.user.role !== 'DECLARANT'
    || exploitation.declarant.user.deletedAt || exploitation.pointPrelevement.deletedAt) {
    return 'Le préleveur ou le point n’est plus disponible pour cette collecte.'
  }
  if (!exploitation.declarant.quickDeclarationEnabled || exploitation.pointPrelevement.flowType !== 'PRELEVEMENT'
    || ![null, 'MANUAL'].includes(exploitation.pointPrelevement.collectionMode)) {
    return 'La saisie manuelle doit être autorisée pour ce préleveur et ce point.'
  }
  return null
}

async function delegatedExploitation(client, user, exploitationId) {
  const exploitation = await client.declarantPointPrelevement.findFirst({
    where: {id: exploitationId, collecteurs: {some: {collecteurUserId: user.id}}}, select: exploitationSelect
  })
  if (!exploitation) throw createHttpError(404, 'Exploitation introuvable dans votre périmètre.')
  return exploitation
}

async function lockOwnedCampaign(tx, {user, campaignId}) {
  validateCampaignId(campaignId)
  await assertCollectorPointManagementEnabled(user, {client: tx, lock: true})
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('collection-campaign'), hashtext(${campaignId}))`
  await tx.$queryRaw`SELECT id FROM "CollectionCampaign" WHERE id = ${campaignId}::uuid FOR UPDATE`
  const campaign = await tx.collectionCampaign.findFirst({where: {id: campaignId, collecteurUserId: user.id}, select: campaignSelect})
  if (!campaign) throw createHttpError(404, 'Campagne introuvable dans votre périmètre.')
  return campaign
}

// Call after checking creation idempotency, before locking/creating the point
// and exploitation. All enrollment paths lock collector, campaign, then point.
export async function prepareCollectorCampaignParticipation(tx, {user, campaignId, now = new Date()}) {
  const campaign = await lockOwnedCampaign(tx, {user, campaignId})
  assertOpen(campaign, now)
  return campaign
}

export async function getCollectorCampaignParticipationOptions(user, query = {}, {client = prisma, now = new Date()} = {}) {
  const {exploitationId, page, pageSize} = validateCampaignParticipationOptions(query)
  await assertCollectorPointManagementEnabled(user, {client})
  const exploitation = exploitationId ? await delegatedExploitation(client, user, exploitationId) : null
  const today = collectorDay(now)
  const open = {status: 'OPEN', closedAt: null, opensOn: {lte: today}, closesOn: {gte: today}}
  const where = {collecteurUserId: user.id, ...(exploitationId
    ? {OR: [open, {status: {not: 'DRAFT'}, responses: {some: {exploitationId, preleveurUserId: exploitation.declarantUserId}}}]}
    : open)}
  const [campaigns, total] = await Promise.all([
    client.collectionCampaign.findMany({where, select: {...campaignSelect,
      ...(exploitationId ? {responses: {where: {exploitationId, preleveurUserId: exploitation.declarantUserId}, select: {id: true}}} : {})},
    orderBy: [{closesOn: 'asc'}, {id: 'asc'}], skip: (page - 1) * pageSize, take: pageSize}),
    client.collectionCampaign.count({where})
  ])
  const blocker = exploitation ? exploitationBlocker(exploitation, now) : null
  return {campaigns: campaigns.map(campaign => {
    const responseId = campaign.responses?.[0]?.id
    const reason = responseId ? 'Un formulaire existe déjà pour cette exploitation.' : blocker
    return {id: campaign.id, name: campaign.name, opensOn: campaignDate(campaign.opensOn), closesOn: campaignDate(campaign.closesOn),
      eligible: !responseId && !blocker && isCampaignOpen(campaign, now),
      ...(reason ? {reason} : {}), ...(responseId ? {responseId} : {})}
  }), total, page, pageSize}
}

// The caller owns the transaction. A retry returns the existing response
// without changing its revision, draft, submitted data, or publication state.
export async function appendCollectorCampaignResponse(tx, {user, campaignId, exploitationId, now = new Date()}) {
  validateCampaignParticipationBody({exploitationId})
  const campaign = await lockOwnedCampaign(tx, {user, campaignId})
  await tx.$queryRaw`
    SELECT p.id FROM "PointPrelevement" p JOIN "DeclarantPointPrelevement" e ON e."pointPrelevementId" = p.id
    JOIN "DeclarantCollecteurExploitation" link ON link."exploitationId" = e.id
    WHERE e.id = ${exploitationId}::uuid AND link."collecteurUserId" = ${user.id}::uuid FOR SHARE OF p
  `
  await tx.$queryRaw`
    SELECT e.id FROM "DeclarantPointPrelevement" e
    JOIN "DeclarantCollecteurExploitation" link ON link."exploitationId" = e.id
    JOIN "Declarant" d ON d."userId" = e."declarantUserId" JOIN "User" u ON u.id = d."userId"
    WHERE e.id = ${exploitationId}::uuid AND link."collecteurUserId" = ${user.id}::uuid FOR SHARE OF e, link, d, u
  `
  const exploitation = await delegatedExploitation(tx, user, exploitationId)
  const existing = await tx.collectionResponse.findUnique({where: {campaignId_exploitationId: {campaignId, exploitationId}}, select: responseSelect})
  if (existing) {
    if (existing.preleveurUserId !== exploitation.declarantUserId || campaign.status === 'DRAFT') {
      throw createHttpError(409, 'Le rattachement du formulaire doit être vérifié par un administrateur.')
    }
    return {campaignParticipation: {campaignId, responseId: existing.id, created: false}}
  }
  assertOpen(campaign, now)
  const blocker = exploitationBlocker(exploitation, now)
  if (blocker) throw participationError(409, 'CAMPAIGN_EXPLOITATION_INELIGIBLE', blocker)
  const response = await tx.collectionResponse.create({data: {campaignId, exploitationId, preleveurUserId: exploitation.declarantUserId}, select: responseSelect})
  return {campaignParticipation: {campaignId, responseId: response.id, created: true}, mutation: {
    operation: 'CREATE', entityType: 'COLLECTION_RESPONSE', entityId: response.id,
    after: {...response, pointPrelevementId: exploitation.pointPrelevementId}
  }}
}

export async function addCollectorCampaignParticipation(user, campaignId, body, {client = prisma, now = new Date(), onAdded = () => {}} = {}) {
  const {exploitationId} = validateCampaignParticipationBody(body)
  let result
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop -- Retry the entire transaction; audit runs only after commit.
      result = await client.$transaction(tx => appendCollectorCampaignResponse(tx, {user, campaignId, exploitationId, now}),
        {isolationLevel: 'Serializable', maxWait: 5000, timeout: 20000})
      break
    } catch (error) {
      const duplicateResponse = error.code === 'P2002' && error.meta?.modelName === 'CollectionResponse'
        && Array.isArray(error.meta.target) && error.meta.target.includes('campaignId') && error.meta.target.includes('exploitationId')
      if (isDatabaseWriteConflict(error) || duplicateResponse) {
        if (attempt < 2) continue
        throw participationError(409, 'CAMPAIGN_PARTICIPATION_CONFLICT', 'Les droits ou les données ont changé. Réessayez l’ajout du formulaire.')
      }
      throw error
    }
  }
  if (result.mutation) await onAdded(result.mutation)
  return {campaignParticipation: result.campaignParticipation}
}
