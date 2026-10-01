import createHttpError from 'http-errors'
import {Prisma} from '@prisma/client'
import {prisma} from '../../db/prisma.js'
import {serializeWaterUses} from './sandre-water-uses.js'
import {stableJson, meterBusinessDateBoundary} from './meter-core.js'
import {exploitationAtDateWhere} from './exploitation-periods.js'
import {CAMPAIGN_READING_DATES, CAMPAIGN_MANUAL_PROVIDER} from './campaign-readings.js'
import {campaignSerialKey, findAbsentCampaignSerialNumbers} from './campaign-meter-proposals.js'
import {getCompatibleMetricTypeCodes} from '../constants/metric-type-codes.js'
import {validateCampaignInput, validateCollectionResponseData, COLLECTION_CAMPAIGN_TYPE} from '../validation/collection-campaigns.js'

export {validateCollectionResponseData}
const frenchDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'})
const userFields = {id: true, firstName: true, lastName: true, email: true, deletedAt: true}
const declarantFields = {userId: true, socialReason: true, siret: true, phoneNumber: true, quickDeclarationEnabled: true, user: {select: userFields}, contactEmails: {select: {email: true, isPrimary: true}}}
const exploitationInclude = {declarant: {select: declarantFields}, pointPrelevement: true, usage: true}
const campaignInclude = {collecteur: {select: {userId: true, socialReason: true}}}
const campaignPointFields = ['id', 'name', 'usageName', 'communeCode', 'communeName', 'locationDescription', 'flowType', 'waterBodyType', 'collectionMode', 'deletedAt']
const responseSummarySelect = {
  id: true, campaignId: true, exploitationId: true, preleveurUserId: true, submittedHash: true, revision: true,
  firstSubmittedAt: true, lastSubmittedAt: true, declarationId: true, publicationStatus: true, publicationIssues: true,
  createdAt: true, updatedAt: true,
  exploitation: {select: {id: true, declarantUserId: true, status: true, countingCode: true, usage: true, declarant: {select: declarantFields},
    pointPrelevement: {select: Object.fromEntries(campaignPointFields.map(field => [field, true]))}}}
}

export async function runCollectionTransaction(client, execute, options = {isolationLevel: 'Serializable'}) {
  try {
    return await client.$transaction(execute, options)
  } catch (error) {
    if (error.code === 'P2034') throw createHttpError(409, 'Les données ont changé pendant l’enregistrement. Rechargez le formulaire avant de réessayer.')
    throw error
  }
}

export function assertCampaignAdmin(user) {
  if (user?.role !== 'ADMIN') throw createHttpError(403, 'La gestion des campagnes est réservée aux administrateurs.')
}

export function campaignDate(value) {
  return value ? new Date(value).toISOString().slice(0, 10) : null
}

export function isCampaignOpen(campaign, now = new Date()) {
  const today = frenchDate.format(now)
  return campaign.status === 'OPEN' && !campaign.closedAt && Boolean(campaign.opensOn && campaign.closesOn)
    && campaignDate(campaign.opensOn) <= today && campaignDate(campaign.closesOn) >= today
}

function accessWhere(user) {
  if (user?.role === 'ADMIN') return {}
  if (user?.role !== 'DECLARANT') throw createHttpError(403, 'Vous ne pouvez pas consulter ces campagnes.')
  return {status: {not: 'DRAFT'}, OR: [{collecteurUserId: user.id}, {responses: {some: {preleveurUserId: user.id, exploitation: {declarantUserId: user.id}}}}]}
}

export function campaignResponseAccessWhere(user, campaign) {
  if (user.role === 'ADMIN') return {}
  if (campaign.collecteurUserId === user.id) return {exploitation: {collecteurs: {some: {collecteurUserId: user.id}}}}
  return {preleveurUserId: user.id, exploitation: {declarantUserId: user.id}}
}

// A receipt must not widen access through the legacy declaration feed, whose
// collector delegation deliberately applies to an entire preleveur.
export function campaignReceiptAccessWhere(userId) {
  const user = {id: userId, role: 'DECLARANT'}
  return {campaign: {status: {not: 'DRAFT'}}, OR: [
    {campaign: {collecteurUserId: userId}, ...campaignResponseAccessWhere(user, {collecteurUserId: userId})},
    {campaign: {collecteurUserId: {not: userId}}, ...campaignResponseAccessWhere(user, {})}
  ]}
}

export function campaignDeclarationAccessWhere(userId) {
  return {OR: [{collectionResponse: null}, {collectionResponse: campaignReceiptAccessWhere(userId)}]}
}

async function campaignForUser(user, campaignId, client) {
  const campaign = await client.collectionCampaign.findFirst({where: {id: campaignId, ...accessWhere(user)}, include: campaignInclude})
  if (!campaign) throw createHttpError(404, 'Campagne introuvable.')
  return campaign
}

export function getCampaignPermissions(user, campaign, progress = {}) {
  const canManage = user.role === 'ADMIN'
  return {canManage, canReadResults: canManage || campaign.collecteurUserId === user.id,
    canRespond: user.role === 'DECLARANT' && campaign.collecteurUserId !== user.id && isCampaignOpen(campaign),
    canRespondForParticipants: isCampaignCollector(user, campaign) && isCampaignOpen(campaign),
    canDelete: canManage && campaign.status === 'DRAFT' && !progress.submitted && !progress.drafts,
    canOpen: canManage && campaign.status !== 'ARCHIVED' && Boolean(campaign.opensOn && campaign.closesOn) && campaignDate(campaign.closesOn) >= frenchDate.format(new Date())}
}

function isCampaignCollector(user, campaign) {
  return user.role === 'DECLARANT' && campaign?.collecteurUserId === user.id
}

// Fetch only the current actor's delegation in the same bounded read as the
// response. Being named on the campaign alone does not grant access to a draft.
function collectorDelegationSelection(user, campaign) {
  return isCampaignCollector(user, campaign)
    ? {collecteurs: {where: {collecteurUserId: user.id}, select: {collecteurUserId: true}}}
    : {}
}

function isResponseCollector({campaign, response, exploitation = response?.exploitation}, user) {
  return isCampaignCollector(user, campaign) && response.preleveurUserId !== user.id
    && response.preleveurUserId === exploitation?.declarantUserId
    && exploitation.collecteurs?.some(link => link.collecteurUserId === user.id) === true
}

function isResponseOwner({response, exploitation = response?.exploitation}, user) {
  return user.role === 'DECLARANT' && user.id === response.preleveurUserId
    && exploitation?.declarantUserId === user.id
}

function canReadResponseDraft(response, user, campaign) {
  return user.role === 'ADMIN' || isResponseOwner({response}, user)
    || isResponseCollector({campaign, response}, user)
}

function responsePermissionState(context, user) {
  const blockers = []
  try { assertCampaignResponseWritable(context, user) } catch (error) { blockers.push(error.message) }
  return {permissions: {canEdit: blockers.length === 0, canSubmit: blockers.length === 0,
    respondingOnBehalf: isResponseCollector(context, user)}, blockers}
}

function publicDeclarant(declarant) {
  if (!declarant) return null
  const {user, ...rest} = declarant
  return {...rest, firstName: user?.firstName, lastName: user?.lastName, email: user?.email ?? null}
}

function publicCampaignPoint(point) {
  if (!point) return null
  return Object.fromEntries(campaignPointFields.map(key => [key, point[key]]))
}

export function serializeCampaignResponse(response, user, {campaign, includeData = false, hasDraft: knownHasDraft} = {}) {
  const {exploitation, preleveur: _preleveur, prefillData: _prefillData, prefillMetadata: _prefillMetadata, draftData, submittedData, ...rest} = response
  const canReadDraft = canReadResponseDraft(response, user, campaign)
  const hasDraft = knownHasDraft ?? (draftData !== null && draftData !== undefined && stableJson(draftData) !== stableJson(submittedData))
  return {...rest, hasDraft, status: response.firstSubmittedAt ? 'SUBMITTED' : (hasDraft ? 'DRAFT' : 'NOT_STARTED'),
    ...(campaign ? {permissions: responsePermissionState({campaign, response, exploitation}, user).permissions} : {}),
    ...(includeData ? {draftData: canReadDraft ? draftData : null, submittedData} : {}),
    exploitation: exploitation ? {id: exploitation.id, countingCode: exploitation.countingCode, usage: exploitation.usage} : undefined,
    preleveur: publicDeclarant(exploitation?.declarant), point: publicCampaignPoint(exploitation?.pointPrelevement),
    countingCode: exploitation?.countingCode ?? null}
}

async function progressForCampaigns(user, campaigns, client) {
  const progress = new Map(campaigns.map(campaign => [campaign.id, {total: 0, submitted: 0, drafts: 0, remaining: 0}]))
  if (!campaigns.length) return progress
  const where = {OR: campaigns.map(campaign => ({campaignId: campaign.id, ...campaignResponseAccessWhere(user, campaign)}))}
  const [totals, drafts] = await Promise.all([
    client.collectionResponse.groupBy({by: ['campaignId'], where, _count: {_all: true, firstSubmittedAt: true}}),
    client.collectionResponse.groupBy({by: ['campaignId'], where: {...where, firstSubmittedAt: null, draftData: {not: Prisma.AnyNull}}, _count: {_all: true}})
  ])
  for (const row of totals) {
    Object.assign(progress.get(row.campaignId), {total: row._count._all, submitted: row._count.firstSubmittedAt,
      remaining: row._count._all - row._count.firstSubmittedAt})
  }
  for (const row of drafts) progress.get(row.campaignId).drafts = row._count._all
  return progress
}

export async function getCollectionCampaign(user, campaignId, {client = prisma} = {}) {
  const campaign = await campaignForUser(user, campaignId, client)
  const [progressByCampaign, responses] = await Promise.all([
    progressForCampaigns(user, [campaign], client),
    user.role === 'ADMIN' ? client.collectionResponse.findMany({where: {campaignId}, select: {exploitationId: true}}) : []
  ])
  const progress = progressByCampaign.get(campaignId)
  const permissions = getCampaignPermissions(user, campaign, progress)
  const exploitationIds = user.role === 'ADMIN' ? responses.map(row => row.exploitationId) : undefined
  return {campaign: {...campaign, progress, permissions, exploitationIds}, progress, permissions}
}

export async function listCollectionCampaigns(user, query = {}, {client = prisma} = {}) {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 50
  const where = accessWhere(user)
  const [rows, total] = await Promise.all([client.collectionCampaign.findMany({where, include: campaignInclude, orderBy: [{createdAt: 'desc'}, {id: 'asc'}], skip: (page - 1) * pageSize, take: pageSize}), client.collectionCampaign.count({where})])
  const progressByCampaign = await progressForCampaigns(user, rows, client)
  const items = rows.map(campaign => {
    const progress = progressByCampaign.get(campaign.id)
    return {...campaign, progress, total: progress.total, submitted: progress.submitted, pending: progress.remaining, permissions: getCampaignPermissions(user, campaign, progress)}
  })
  return {items, total, page, pageSize}
}

export async function getCollectionCampaignSummary(user, {client = prisma} = {}) {
  if (!['DECLARANT', 'ADMIN'].includes(user?.role)) return {hasCampaigns: false, items: []}
  const result = await listCollectionCampaigns(user, {pageSize: 100}, {client})
  return {hasCampaigns: result.total > 0, items: result.items}
}

function candidateWhere(query) {
  const text = query.q || query.search
  const period = exploitationAtDateWhere()
  return {...period, declarant: {declarantRole: 'PRELEVEUR', user: {deletedAt: null}},
    pointPrelevement: {deletedAt: null, flowType: 'PRELEVEMENT', OR: [{collectionMode: null}, {collectionMode: 'MANUAL'}]},
    ...(query.collecteurUserId ? {collecteurs: {some: {collecteurUserId: query.collecteurUserId}}} : {}),
    ...(query.usageId ? {OR: [{usageId: query.usageId}, {secondaryUsageLinks: {some: {usageId: query.usageId}}}]} : {}),
    AND: [...period.AND, ...(text ? [{OR: [{countingCode: {contains: text, mode: 'insensitive'}}, {pointPrelevement: {name: {contains: text, mode: 'insensitive'}}}, {declarant: {socialReason: {contains: text, mode: 'insensitive'}}}]}] : [])]}
}

export async function listCollectionCandidates(user, query, {client = prisma} = {}) {
  assertCampaignAdmin(user)
  const where = candidateWhere(query)
  const [items, total, collecteurs, usages] = await Promise.all([
    client.declarantPointPrelevement.findMany({where, include: exploitationInclude, orderBy: {id: 'asc'}, skip: (query.page - 1) * query.pageSize, take: query.pageSize}),
    client.declarantPointPrelevement.count({where}),
    client.declarant.findMany({where: {declarantRole: 'COLLECTEUR', user: {deletedAt: null}}, select: {userId: true, socialReason: true, user: {select: {firstName: true, lastName: true}}}, orderBy: {socialReason: 'asc'}}),
    client.sandreWaterUse.findMany({where: {kind: 'USAGE'}})
  ])
  if (query.selectAll && total > 5000) throw createHttpError(400, 'Affinez les filtres avant de sélectionner toutes les exploitations (5 000 maximum).')
  const selectedIds = query.selectAll ? (await client.declarantPointPrelevement.findMany({where, select: {id: true}, orderBy: {id: 'asc'}, take: 5000})).map(row => row.id) : undefined
  return {items: items.map(row => ({...row, declarant: publicDeclarant(row.declarant), preleveur: publicDeclarant(row.declarant), point: row.pointPrelevement})), total, page: query.page, pageSize: query.pageSize, collecteurs, usages: serializeWaterUses(usages), selectedIds}
}

async function validatePopulation(data, client) {
  const collecteur = await client.declarant.findFirst({where: {userId: data.collecteurUserId, declarantRole: 'COLLECTEUR', user: {deletedAt: null}}, select: {userId: true}})
  if (!collecteur) throw createHttpError(400, 'Choisissez un collecteur actif.')
  const exploitations = await client.declarantPointPrelevement.findMany({where: {...candidateWhere({collecteurUserId: data.collecteurUserId}), id: {in: data.exploitationIds}}, select: {id: true, declarantUserId: true}})
  if (exploitations.length !== data.exploitationIds.length) throw createHttpError(400, 'Les exploitations doivent autoriser la saisie manuelle et être rattachées à ce collecteur.')
  return exploitations
}

function assertDates(data) {
  if (data.opensOn && data.closesOn && campaignDate(data.opensOn) > campaignDate(data.closesOn)) throw createHttpError(400, 'La fermeture doit être postérieure ou égale à l’ouverture.')
  if (data.closesOn && campaignDate(data.closesOn) < '2026-10-31') throw createHttpError(400, 'La campagne doit rester ouverte au moins jusqu’au relevé du 31 octobre 2026.')
}

function asDatabaseDate(value) { return value ? new Date(`${campaignDate(value)}T00:00:00Z`) : null }

export async function createCollectionCampaign(data, {user, client = prisma} = {}) {
  assertCampaignAdmin(user)
  const value = validateCampaignInput(data)
  assertDates(value)
  const execute = async tx => {
    const exploitations = await validatePopulation(value, tx)
    return tx.collectionCampaign.create({data: {
      sourceId: value.sourceId, name: value.name, type: COLLECTION_CAMPAIGN_TYPE, status: 'DRAFT',
      opensOn: asDatabaseDate(value.opensOn), closesOn: asDatabaseDate(value.closesOn), collecteurUserId: value.collecteurUserId,
      createdByUserId: user.id, responses: {create: exploitations.map(exploitation => ({exploitationId: exploitation.id, preleveurUserId: exploitation.declarantUserId}))}
    }, include: campaignInclude})
  }
  return client === prisma ? runCollectionTransaction(prisma, execute) : execute(client)
}

async function lockCampaign(tx, campaignId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('collection-campaign'), hashtext(${campaignId}))`
  await tx.$queryRaw`SELECT id FROM "CollectionCampaign" WHERE id = ${campaignId}::uuid FOR UPDATE`
}

export async function updateCollectionCampaign(user, campaignId, body, {client = prisma} = {}) {
  assertCampaignAdmin(user)
  const value = validateCampaignInput(body, {partial: true})
  if (Object.hasOwn(value, 'sourceId')) throw createHttpError(400, 'L’origine de la campagne ne peut pas être modifiée.')
  return runCollectionTransaction(client, async tx => {
    await lockCampaign(tx, campaignId)
    const campaign = await campaignForUser(user, campaignId, tx)
    if (campaign.status === 'ARCHIVED') throw createHttpError(409, 'Cette campagne est archivée.')
    const next = {...campaign, ...value}
    assertDates(next)
    if (campaign.status !== 'DRAFT' && (value.exploitationIds || value.collecteurUserId)) throw createHttpError(409, 'La population et le collecteur sont figés après le lancement.')
    if (campaign.status === 'OPEN' && (!next.opensOn || !next.closesOn)) throw createHttpError(400, 'Les dates sont obligatoires pour une campagne ouverte.')
    if (value.exploitationIds || value.collecteurUserId) {
      const existing = await tx.collectionResponse.findMany({where: {campaignId}})
      if (existing.some(row => row.firstSubmittedAt || row.draftData)) throw createHttpError(409, 'Une réponse a déjà été commencée.')
      const exploitations = await validatePopulation({...next, exploitationIds: value.exploitationIds ?? existing.map(row => row.exploitationId)}, tx)
      await tx.collectionResponse.deleteMany({where: {campaignId}})
      await tx.collectionResponse.createMany({data: exploitations.map(row => ({campaignId, exploitationId: row.id, preleveurUserId: row.declarantUserId}))})
    }
    return tx.collectionCampaign.update({where: {id: campaignId}, data: {name: next.name, opensOn: asDatabaseDate(next.opensOn), closesOn: asDatabaseDate(next.closesOn), collecteurUserId: next.collecteurUserId}, include: campaignInclude})
  }, {isolationLevel: 'Serializable'})
}

export async function transitionCollectionCampaign(user, campaignId, action, {client = prisma} = {}) {
  assertCampaignAdmin(user)
  return runCollectionTransaction(client, async tx => {
    await lockCampaign(tx, campaignId)
    const campaign = await campaignForUser(user, campaignId, tx)
    if (campaign.status === 'ARCHIVED') throw createHttpError(409, 'Cette campagne est archivée.')
    if (action === 'open') {
      if (!campaign.opensOn || !campaign.closesOn) throw createHttpError(400, 'Renseignez les dates d’ouverture et de fermeture avant le lancement.')
      if (campaignDate(campaign.closesOn) < frenchDate.format(new Date())) throw createHttpError(400, 'La date de fermeture est dépassée.')
      const rows = await tx.collectionResponse.findMany({where: {campaignId}, select: {exploitationId: true}})
      await validatePopulation({...campaign, exploitationIds: rows.map(row => row.exploitationId)}, tx)
      return tx.collectionCampaign.update({where: {id: campaignId}, data: {status: 'OPEN', closedAt: null}})
    }
    if (action === 'close') {
      if (campaign.status !== 'OPEN') throw createHttpError(409, 'La campagne n’est pas ouverte.')
      const today = new Date(`${frenchDate.format(new Date())}T00:00:00Z`)
      return tx.collectionCampaign.update({where: {id: campaignId}, data: {closedAt: new Date(), ...(campaign.opensOn <= today ? {closesOn: today} : {})}})
    }
    if (action === 'archive') return tx.collectionCampaign.update({where: {id: campaignId}, data: {status: 'ARCHIVED'}})
    if (action === 'delete') {
      const rows = await tx.collectionResponse.findMany({where: {campaignId}})
      if (campaign.status !== 'DRAFT' || rows.some(row => row.firstSubmittedAt || row.draftData)) throw createHttpError(409, 'Une campagne lancée ou renseignée doit être archivée, pas supprimée.')
      await tx.collectionResponse.deleteMany({where: {campaignId}})
      await tx.collectionCampaign.delete({where: {id: campaignId}})
      return {id: campaignId}
    }
    throw createHttpError(400, 'Action inconnue.')
  }, {isolationLevel: 'Serializable'})
}

function responseFilter(query) {
  if (query.status === 'SUBMITTED') return {firstSubmittedAt: {not: null}}
  if (query.status === 'DRAFT') return {firstSubmittedAt: null, draftData: {not: Prisma.DbNull}}
  if (query.status === 'NOT_STARTED') return {firstSubmittedAt: null, draftData: {equals: Prisma.DbNull}}
  return {}
}

export async function getCampaignResponseVolumes(responses, {client = prisma} = {}) {
  const summaries = new Map(responses.map(response => [response.id, {offSeason: null, season: null, total: null, publicationStatus: response.publicationStatus, partial: true}]))
  const submitted = responses.filter(response => response.declarationId && response.firstSubmittedAt)
  if (!submitted.length) return summaries
  const byDeclaration = new Map(submitted.map(response => [response.declarationId, response]))
  const byResponse = new Map(submitted.map(response => [response.id, response]))
  const [ordinary, contributions] = await Promise.all([
    client.chunkValue.findMany({where: {metricTypeCode: {in: getCompatibleMetricTypeCodes('volume')}, chunk: {
      calculationStrategy: 'GENERIC', autoCalculateVolumes: true, instructionStatus: {not: 'REJECTED'},
      source: {status: 'COMPLETED', declarationId: {in: [...byDeclaration.keys()]}}}},
    select: {value: true, periodEnd: true, chunk: {select: {exploitationId: true, source: {select: {declarationId: true}}}}}}),
    client.meterVolumeContribution.findMany({where: {
      publication: {active: true, stream: {provider: CAMPAIGN_MANUAL_PROVIDER, scope: {in: [...new Set(submitted.map(response => response.campaignId))]}}},
      allocationVersion: {allocation: {exploitationId: {in: submitted.map(response => response.exploitationId)}}},
      chunkValue: {chunk: {instructionStatus: {not: 'REJECTED'}, source: {status: 'COMPLETED'}}}},
    select: {volume: true, publication: {select: {periodEnd: true, stream: {select: {scope: true}}}},
      allocationVersion: {select: {metadata: true, allocation: {select: {exploitationId: true}}}},
      chunkValue: {select: {chunk: {select: {exploitationId: true}}}}}})
  ])
  const add = (responseId, period, volume) => {
    if (!period) return
    const summary = summaries.get(responseId)
    summary[period] = (summary[period] ?? 0) + Number(volume)
  }
  for (const row of ordinary) {
    const response = byDeclaration.get(row.chunk.source.declarationId)
    if (response.exploitationId !== row.chunk.exploitationId) continue
    const date = campaignDate(row.periodEnd)
    add(response.id, date === CAMPAIGN_READING_DATES[1] ? 'offSeason' : (date === CAMPAIGN_READING_DATES[2] ? 'season' : null), row.value)
  }
  const middle = meterBusinessDateBoundary(CAMPAIGN_READING_DATES[1]).getTime()
  const end = meterBusinessDateBoundary(CAMPAIGN_READING_DATES[2]).getTime()
  for (const row of contributions) {
    const response = byResponse.get(row.allocationVersion.metadata?.collectionResponseId)
    if (!response || response.campaignId !== row.publication.stream.scope
      || response.exploitationId !== row.allocationVersion.allocation.exploitationId || response.exploitationId !== row.chunkValue.chunk.exploitationId) continue
    const instant = row.publication.periodEnd.getTime()
    add(response.id, instant === middle ? 'offSeason' : (instant === end ? 'season' : null), row.volume)
  }
  for (const summary of summaries.values()) {
    summary.partial = summary.offSeason === null || summary.season === null
    if (summary.offSeason !== null || summary.season !== null) summary.total = (summary.offSeason ?? 0) + (summary.season ?? 0)
  }
  return summaries
}

async function readCollectionResponsePage(user, campaign, query, client) {
  const campaignId = campaign.id
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 50
  const text = query.q || query.search
  const where = {campaignId, ...campaignResponseAccessWhere(user, campaign), ...responseFilter(query), ...(text ? {OR: [
    {exploitation: {countingCode: {contains: text, mode: 'insensitive'}}},
    ...['name', 'usageName', 'communeName'].map(field => ({exploitation: {pointPrelevement: {[field]: {contains: text, mode: 'insensitive'}}}})),
    {preleveur: {socialReason: {contains: text, mode: 'insensitive'}}}
  ]} : {})}
  const summary = query.view === 'summary'
  const delegation = collectorDelegationSelection(user, campaign)
  const [rows, total] = await Promise.all([client.collectionResponse.findMany({where,
    ...(summary ? {select: {...responseSummarySelect, exploitation: {select: {...responseSummarySelect.exploitation.select, ...delegation}}}}
      : {include: {exploitation: {include: {...exploitationInclude, ...delegation}}}}),
    orderBy: {id: 'asc'}, skip: (page - 1) * pageSize, take: pageSize}), client.collectionResponse.count({where})])
  const summaries = summary ? await readCollectionResponseSummaries(rows, client) : null
  return {rows, total, page, pageSize, summaries}
}

async function readCollectionResponseSummaries(rows, client) {
  if (!rows.length) return new Map()
  // Only the IDs selected with current response permissions above are projected.
  // Compare JSON in PostgreSQL without transferring private drafts or crop arrays.
  const summaries = await client.$queryRaw(Prisma.sql`
    SELECT r.id, ST_AsGeoJSON(p.coordinates)::json AS coordinates,
      (r."draftData" IS NOT NULL AND r."draftData" <> 'null'::jsonb
        AND r."draftData" IS DISTINCT FROM r."submittedData") AS "hasDraft",
      CASE WHEN r."submittedData" IS NULL OR r."submittedData" = 'null'::jsonb THEN NULL
        ELSE jsonb_build_object(
          'season', jsonb_build_object('flow', r."submittedData" #> '{needs,season,flow}', 'volume', r."submittedData" #> '{needs,season,volume}'),
          'offSeason', jsonb_build_object('flow', r."submittedData" #> '{needs,offSeason,flow}', 'volume', r."submittedData" #> '{needs,offSeason,volume}')
        ) END AS "submittedNeeds"
    FROM "CollectionResponse" r
    JOIN "DeclarantPointPrelevement" e ON e.id = r."exploitationId"
    JOIN "PointPrelevement" p ON p.id = e."pointPrelevementId"
    WHERE r.id IN (${Prisma.join(rows.map(row => Prisma.sql`${row.id}::uuid`))})
  `)
  return new Map(summaries.map(row => [row.id, row]))
}

function serializeCollectionResponsePage({rows, total, page, pageSize, summaries}, user, volumes, campaign) {
  return {items: rows.map(row => {
    const response = serializeCampaignResponse(row, user, {campaign, includeData: !summaries, hasDraft: summaries?.get(row.id)?.hasDraft})
    return {...response,
      ...(summaries ? {submittedNeeds: summaries.get(row.id)?.submittedNeeds ?? null,
        point: response.point ? {...response.point, coordinates: summaries.get(row.id)?.coordinates ?? null} : null} : {}),
      ...(volumes ? {volumes: volumes.get(row.id)} : {})}
  }), total, page, pageSize}
}

export async function listCollectionResponses(user, campaignId, query = {}, {client = prisma} = {}) {
  const campaign = await campaignForUser(user, campaignId, client)
  const page = await readCollectionResponsePage(user, campaign, query, client)
  const volumes = query.view === 'summary' ? null : await getCampaignResponseVolumes(page.rows, {client})
  return serializeCollectionResponsePage(page, user, volumes, campaign)
}

export function assertCampaignResponseWritable(context, user, {now = new Date()} = {}) {
  const {campaign, exploitation} = context
  if (!isResponseOwner(context, user) && !isResponseCollector(context, user)) throw createHttpError(403, 'Seuls le préleveur concerné ou le collecteur de la campagne encore rattaché à cette exploitation peuvent remplir cette réponse.')
  if (!isCampaignOpen(campaign, now)) throw createHttpError(409, 'Cette campagne n’est pas ouverte à la saisie.')
  if (!['EN_ACTIVITE', 'NON_RENSEIGNE'].includes(exploitation.status)) throw createHttpError(409, 'Cette exploitation n’est plus active. Contactez le gestionnaire pour vérifier son bilan.')
  if (exploitation.declarant?.quickDeclarationEnabled === false || exploitation.pointPrelevement?.collectionMode === 'EXTERNAL' || exploitation.pointPrelevement?.deletedAt || exploitation.declarant?.user?.deletedAt) throw createHttpError(403, 'La saisie manuelle est indisponible pour cette exploitation.')
}

function availableUnallocatedProposal(meters, absentSerialNumbers) {
  const proposal = meters?.length === 1 ? meters[0] : null
  const serial = campaignSerialKey(proposal?.serialNumber)
  return proposal && !proposal.compteurId && (!serial || absentSerialNumbers.some(value => campaignSerialKey(value) === serial)) ? proposal : null
}

export function buildInitialCampaignData(meters, values = [], usages = [], prefillData = null, {hasMeterAllocations = meters.length > 0, absentSerialNumbers = []} = {}) {
  const allowedUsages = new Set(usages.map(usage => usage.id))
  const proposals = prefillData ? validateCollectionResponseData(prefillData) : {}
  const proposalPeriod = period => {
    const {usageId, ...fields} = period ?? {}
    return {...fields, ...(allowedUsages.has(usageId) ? {usageId} : {})}
  }
  const reading = (compteurId, date) => {
    const candidates = values.filter(value => value.chunk.compteurId === compteurId && campaignDate(value.periodStart) === date
      && new Date(value.periodStart).toISOString() === `${date}T00:00:00.000Z`)
    if (!candidates.length) return null
    if (new Set(candidates.map(value => String(value.value))).size !== 1) return {conflicting: true}
    const usageIds = new Set(candidates.map(value => value.chunk.usageId))
    return {value: String(candidates[0].value), usageId: usageIds.size === 1 && allowedUsages.has(candidates[0].chunk.usageId) ? candidates[0].chunk.usageId : undefined}
  }
  const initialMeters = meters.map(meter => {
    // Match existing allocations by ID only. Stale/duplicate proposals must not
    // add meters, override their serial number or resolve an observed conflict.
    const candidates = (proposals.meters ?? []).filter(proposal => proposal.compteurId === meter.compteurId)
    const proposal = candidates.length === 1 ? candidates[0] : {}
    const [start, middle, end] = CAMPAIGN_READING_DATES.map(date => reading(meter.compteurId, date))
    const offSeason = proposalPeriod(proposal.offSeason)
    const season = proposalPeriod(proposal.season)
    for (const [period, key, observed] of [[offSeason, 'indexStart', start], [offSeason, 'indexEnd', middle], [season, 'indexEnd', end]]) {
      if (observed?.conflicting) delete period[key]
      else if (observed) period[key] = observed.value
    }
    return {compteurId: meter.compteurId, serialNumber: meter.serialNumber ?? '',
      offSeason: {...offSeason, ...((middle?.usageId ?? start?.usageId) ? {usageId: middle?.usageId ?? start?.usageId} : {})},
      season: {...season, ...(end?.usageId ? {usageId: end.usageId} : {})}}
  })
  const unallocated = availableUnallocatedProposal(proposals.meters, absentSerialNumbers)
  const hasObservedStart = values.some(value => new Date(value.periodStart).toISOString() === `${CAMPAIGN_READING_DATES[0]}T00:00:00.000Z`)
  if (!hasMeterAllocations && !meters.length && !hasObservedStart && unallocated) {
    initialMeters.push({compteurId: null, serialNumber: unallocated.serialNumber ?? null,
      offSeason: proposalPeriod(unallocated.offSeason), season: proposalPeriod(unallocated.season)})
  }
  return {meters: initialMeters, needs: {offSeason: proposalPeriod(proposals.needs?.offSeason), season: proposalPeriod(proposals.needs?.season)}, comment: ''}
}

function campaignPrefillContext(response, user, campaign) {
  if (!canReadResponseDraft(response, user, campaign)) return null
  return {
    active: response.revision === 0 && !response.firstSubmittedAt && !response.lastSubmittedAt && !response.declarationId && !response.submittedHash
      && response.draftData == null && response.submittedData == null && Boolean(response.prefillData),
    noAuthorizedOffSeasonUsage: response.prefillMetadata?.noAuthorizedOffSeasonUsage === true
  }
}

export async function getAuthorizedCampaignResponseContext(user, campaignId, responseId, {client = prisma} = {}) {
  const campaign = await campaignForUser(user, campaignId, client)
  const response = await client.collectionResponse.findFirst({where: {id: responseId, campaignId, ...campaignResponseAccessWhere(user, campaign)},
    include: {exploitation: {include: {...exploitationInclude, ...collectorDelegationSelection(user, campaign)}}}})
  if (!response || response.preleveurUserId !== response.exploitation.declarantUserId) throw createHttpError(404, 'Réponse introuvable.')
  const exploitation = {...response.exploitation, pointPrelevement: publicCampaignPoint(response.exploitation.pointPrelevement)}
  const [allocations, usages, coordinates] = await Promise.all([
    client.meterAllocation.findMany({where: {exploitationId: exploitation.id}, include: {compteur: {select: {id: true, serialNumber: true, deletedAt: true, meterAllocations: {select: {exploitationId: true}}}}}}),
    client.sandreWaterUse.findMany(),
    client.$queryRaw`SELECT ST_X(coordinates) AS longitude, ST_Y(coordinates) AS latitude FROM "PointPrelevement" WHERE id = ${exploitation.pointPrelevementId}::uuid`
  ])
  const meters = [...new Map(allocations.filter(row => !row.compteur.deletedAt).map(row => [row.compteurId, {compteurId: row.compteurId, id: row.compteurId, serialNumber: row.compteur.serialNumber, shared: new Set(row.compteur.meterAllocations.map(item => item.exploitationId)).size > 1}])).values()]
  const {permissions: responsePermissions, blockers} = responsePermissionState({campaign, response, exploitation}, user)
  const permissions = {...getCampaignPermissions(user, campaign), ...responsePermissions}
  const publicResponse = serializeCampaignResponse(response, user, {campaign, includeData: true})
  publicResponse.volumes = (await getCampaignResponseVolumes([response], {client})).get(response.id)
  let data = publicResponse.draftData ?? publicResponse.submittedData
  const prefill = campaignPrefillContext(response, user, campaign)
  if (!data) {
    const exactValues = await client.chunkValue.findMany({where: {valueKind: 'DECLARED', metricTypeCode: {in: getCompatibleMetricTypeCodes('index')},
      periodStart: {in: CAMPAIGN_READING_DATES.map(date => new Date(`${date}T00:00:00Z`))},
      chunk: {exploitationId: exploitation.id, preleveurUserId: response.preleveurUserId,
        ...(allocations.length ? {compteurId: {in: meters.map(meter => meter.compteurId)}} : {}),
        calculationStrategy: 'GENERIC', instructionStatus: {not: 'REJECTED'}, source: {status: 'COMPLETED'}}},
    select: {periodStart: true, value: true, chunk: {select: {compteurId: true, usageId: true}}}})
    data = buildInitialCampaignData(meters, exactValues, usages)
    if (prefill?.active) {
      const proposedMeters = response.prefillData?.meters ?? []
      const absentSerialNumbers = !allocations.length && proposedMeters.length === 1 && !proposedMeters[0].compteurId
        ? await findAbsentCampaignSerialNumbers(client, [proposedMeters[0].serialNumber]) : []
      const proposed = buildInitialCampaignData(meters, exactValues, usages, response.prefillData, {hasMeterAllocations: allocations.length > 0, absentSerialNumbers})
      // An informational source flag or a stale proposal alone is not an
      // actual prefilled answer. Only announce values used in this form.
      prefill.active = stableJson(proposed) !== stableJson(data)
      data = proposed
    }
  }
  return {campaign, response: publicResponse, exploitation, permissions, meters, waterUses: serializeWaterUses(usages), data, blockers,
    prefill,
    context: {exploitation: {id: exploitation.id, countingCode: exploitation.countingCode}, preleveur: publicDeclarant(exploitation.declarant), point: {...exploitation.pointPrelevement, coordinates: coordinates[0]?.longitude === null ? null : [coordinates[0]?.longitude, coordinates[0]?.latitude]}, meters, usageOptions: serializeWaterUses(usages)}}
}

export async function saveCollectionResponseDraft(user, campaignId, responseId, body, {client = prisma} = {}) {
  const data = validateCollectionResponseData(body.data)
  return runCollectionTransaction(client, async tx => {
    await lockCampaign(tx, campaignId)
    const context = await getAuthorizedCampaignResponseContext(user, campaignId, responseId, {client: tx})
    assertCampaignResponseWritable(context, user)
    const updated = await tx.collectionResponse.updateMany({where: {id: responseId, revision: body.revision}, data: {draftData: data, revision: {increment: 1}}})
    if (updated.count !== 1) throw createHttpError(409, 'La réponse a été modifiée dans une autre fenêtre. Rechargez-la avant d’enregistrer.')
    return getAuthorizedCampaignResponseContext(user, campaignId, responseId, {client: tx})
  }, {isolationLevel: 'Serializable'})
}

export async function getCollectionResults(user, campaignId, query, {client = prisma} = {}) {
  const campaign = await campaignForUser(user, campaignId, client)
  if (!getCampaignPermissions(user, campaign).canReadResults) throw createHttpError(403, 'Les résultats sont réservés au collecteur de la campagne.')
  const where = {campaignId, ...campaignResponseAccessWhere(user, campaign)}
  const [page, rows, usages, expected] = await Promise.all([
    readCollectionResponsePage(user, campaign, {...query, status: 'SUBMITTED'}, client),
    client.collectionResponse.findMany({where: {...where, firstSubmittedAt: {not: null}},
      select: {id: true, campaignId: true, exploitationId: true, declarationId: true, firstSubmittedAt: true, publicationStatus: true, submittedData: true}}),
    client.sandreWaterUse.findMany(),
    client.collectionResponse.count({where})
  ])
  // Include page rows as well if a response was submitted between the two reads.
  // Global totals still cover exactly the rows returned by the totals query.
  const volumeRows = [...new Map([...rows, ...page.rows].map(row => [row.id, row])).values()]
  const volumesByResponse = await getCampaignResponseVolumes(volumeRows, {client})
  const result = serializeCollectionResponsePage(page, user, volumesByResponse, campaign)
  const waterUses = serializeWaterUses(usages)
  const volumes = rows.map(row => volumesByResponse.get(row.id))
  const sumPublished = key => volumes.some(row => row[key] !== null) ? volumes.reduce((sum, row) => sum + (row[key] ?? 0), 0) : null
  return {...result, waterUses, totals: {submitted: rows.length, total: expected,
    requestedSeasonVolume: rows.reduce((sum, row) => sum + Number(row.submittedData?.needs?.season?.volume ?? 0), 0),
    requestedOffSeasonVolume: rows.reduce((sum, row) => sum + Number(row.submittedData?.needs?.offSeason?.volume ?? 0), 0),
    publishedVolumes: {offSeason: sumPublished('offSeason'), season: sumPublished('season'), total: sumPublished('total'), partial: rows.length < expected || volumes.some(row => row.partial || row.publicationStatus !== 'PUBLISHED')}},
  warnings: ['Les volumes demandés ne sont pas des volumes prélevés.', 'Les volumes publiés ne couvrent pas les réponses encore en attente de validation.']}
}
