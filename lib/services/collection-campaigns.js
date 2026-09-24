import createHttpError from 'http-errors'
import {Prisma} from '@prisma/client'
import {prisma} from '../../db/prisma.js'
import {serializeWaterUses} from './sandre-water-uses.js'
import {stableJson, meterBusinessDateBoundary} from './meter-core.js'
import {exploitationAtDateWhere} from './exploitation-periods.js'
import {CAMPAIGN_READING_DATES, CAMPAIGN_MANUAL_PROVIDER} from './campaign-readings.js'
import {getCompatibleMetricTypeCodes} from '../constants/metric-type-codes.js'
import {validateCampaignInput, validateCollectionResponseData, COLLECTION_CAMPAIGN_TYPE} from '../validation/collection-campaigns.js'

export {validateCollectionResponseData}
const frenchDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'})
const userFields = {id: true, firstName: true, lastName: true, email: true, deletedAt: true}
const declarantFields = {userId: true, socialReason: true, siret: true, phoneNumber: true, quickDeclarationEnabled: true, user: {select: userFields}, contactEmails: {select: {email: true, isPrimary: true}}}
const exploitationInclude = {declarant: {select: declarantFields}, pointPrelevement: true, usage: true}
const campaignInclude = {collecteur: {select: {userId: true, socialReason: true}}}

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
    canDelete: canManage && campaign.status === 'DRAFT' && !progress.submitted && !progress.drafts,
    canOpen: canManage && campaign.status !== 'ARCHIVED' && Boolean(campaign.opensOn && campaign.closesOn) && campaignDate(campaign.closesOn) >= frenchDate.format(new Date())}
}

function publicDeclarant(declarant) {
  if (!declarant) return null
  const {user, ...rest} = declarant
  return {...rest, firstName: user?.firstName, lastName: user?.lastName, email: user?.email ?? null}
}

function publicCampaignPoint(point) {
  if (!point) return null
  const fields = ['id', 'name', 'usageName', 'communeCode', 'communeName', 'locationDescription', 'flowType', 'waterBodyType', 'collectionMode', 'deletedAt']
  return Object.fromEntries(fields.map(key => [key, point[key]]))
}

export function serializeCampaignResponse(response, user, {includeData = false} = {}) {
  const {exploitation, preleveur: _preleveur, draftData, submittedData, ...rest} = response
  const canReadDraft = user.role === 'ADMIN' || user.id === response.preleveurUserId
  const hasDraft = draftData !== null && draftData !== undefined && stableJson(draftData) !== stableJson(submittedData)
  return {...rest, hasDraft, status: response.firstSubmittedAt ? 'SUBMITTED' : (hasDraft ? 'DRAFT' : 'NOT_STARTED'),
    ...(includeData ? {draftData: canReadDraft ? draftData : null, submittedData} : {}),
    exploitation: exploitation ? {id: exploitation.id, countingCode: exploitation.countingCode, usage: exploitation.usage} : undefined,
    preleveur: publicDeclarant(exploitation?.declarant), point: publicCampaignPoint(exploitation?.pointPrelevement),
    countingCode: exploitation?.countingCode ?? null}
}

async function progressForCampaign(user, campaign, client) {
  const rows = await client.collectionResponse.findMany({where: {campaignId: campaign.id, ...campaignResponseAccessWhere(user, campaign)}, select: {firstSubmittedAt: true, draftData: true}})
  const submitted = rows.filter(row => row.firstSubmittedAt).length
  return {total: rows.length, submitted, drafts: rows.filter(row => !row.firstSubmittedAt && row.draftData !== null).length, remaining: rows.length - submitted}
}

export async function getCollectionCampaign(user, campaignId, {client = prisma} = {}) {
  const campaign = await campaignForUser(user, campaignId, client)
  const progress = await progressForCampaign(user, campaign, client)
  const permissions = getCampaignPermissions(user, campaign, progress)
  const exploitationIds = user.role === 'ADMIN' ? (await client.collectionResponse.findMany({where: {campaignId}, select: {exploitationId: true}})).map(row => row.exploitationId) : undefined
  return {campaign: {...campaign, progress, permissions, exploitationIds}, progress, permissions}
}

export async function listCollectionCampaigns(user, query = {}, {client = prisma} = {}) {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 50
  const where = accessWhere(user)
  const [rows, total] = await Promise.all([client.collectionCampaign.findMany({where, include: campaignInclude, orderBy: [{createdAt: 'desc'}, {id: 'asc'}], skip: (page - 1) * pageSize, take: pageSize}), client.collectionCampaign.count({where})])
  const items = await Promise.all(rows.map(async campaign => {
    const progress = await progressForCampaign(user, campaign, client)
    return {...campaign, progress, total: progress.total, submitted: progress.submitted, pending: progress.remaining, permissions: getCampaignPermissions(user, campaign, progress)}
  }))
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

export async function listCollectionResponses(user, campaignId, query = {}, {client = prisma} = {}) {
  const campaign = await campaignForUser(user, campaignId, client)
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 50
  const text = query.q || query.search
  const where = {campaignId, ...campaignResponseAccessWhere(user, campaign), ...responseFilter(query), ...(text ? {OR: [
    {exploitation: {countingCode: {contains: text, mode: 'insensitive'}}}, {exploitation: {pointPrelevement: {name: {contains: text, mode: 'insensitive'}}}}, {preleveur: {socialReason: {contains: text, mode: 'insensitive'}}}
  ]} : {})}
  const [rows, total] = await Promise.all([client.collectionResponse.findMany({where, include: {exploitation: {include: exploitationInclude}}, orderBy: {id: 'asc'}, skip: (page - 1) * pageSize, take: pageSize}), client.collectionResponse.count({where})])
  const volumes = await getCampaignResponseVolumes(rows, {client})
  return {items: rows.map(row => ({...serializeCampaignResponse(row, user, {includeData: true}), volumes: volumes.get(row.id)})), total, page, pageSize}
}

export function assertCampaignResponseWritable(context, user, {now = new Date(), submitting = false} = {}) {
  const {campaign, response, exploitation} = context
  if (user.role !== 'DECLARANT' || user.id !== response.preleveurUserId || exploitation.declarantUserId !== user.id) throw createHttpError(403, 'Seul le préleveur concerné peut remplir cette réponse.')
  if (!isCampaignOpen(campaign, now)) throw createHttpError(409, 'Cette campagne n’est pas ouverte à la saisie.')
  if (!['EN_ACTIVITE', 'NON_RENSEIGNE'].includes(exploitation.status)) throw createHttpError(409, 'Cette exploitation n’est plus active. Contactez le gestionnaire pour vérifier son bilan.')
  if (exploitation.declarant?.quickDeclarationEnabled === false || exploitation.pointPrelevement?.collectionMode === 'EXTERNAL' || exploitation.pointPrelevement?.deletedAt || exploitation.declarant?.user?.deletedAt) throw createHttpError(403, 'La saisie manuelle est indisponible pour cette exploitation.')
  if (submitting && frenchDate.format(now) < '2026-10-31') throw createHttpError(409, 'Le bilan pourra être envoyé à partir du 31 octobre 2026. Vous pouvez enregistrer un brouillon.')
}

export function buildInitialCampaignData(meters, values = [], usages = []) {
  const allowedUsages = new Set(usages.map(usage => usage.id))
  const reading = (compteurId, date) => {
    const candidates = values.filter(value => value.chunk.compteurId === compteurId && campaignDate(value.periodStart) === date
      && new Date(value.periodStart).toISOString() === `${date}T00:00:00.000Z`)
    if (!candidates.length || new Set(candidates.map(value => String(value.value))).size !== 1) return null
    const usageIds = new Set(candidates.map(value => value.chunk.usageId))
    return {value: String(candidates[0].value), usageId: usageIds.size === 1 && allowedUsages.has(candidates[0].chunk.usageId) ? candidates[0].chunk.usageId : undefined}
  }
  return {meters: meters.map(meter => {
    const [start, middle, end] = CAMPAIGN_READING_DATES.map(date => reading(meter.compteurId, date))
    return {compteurId: meter.compteurId, serialNumber: meter.serialNumber ?? '',
      offSeason: {...(start ? {indexStart: start.value} : {}), ...(middle ? {indexEnd: middle.value} : {}), ...((middle?.usageId ?? start?.usageId) ? {usageId: middle?.usageId ?? start?.usageId} : {})},
      season: {...(end ? {indexEnd: end.value} : {}), ...(end?.usageId ? {usageId: end.usageId} : {})}}
  }), needs: {offSeason: {}, season: {}}, comment: ''}
}

export async function getAuthorizedCampaignResponseContext(user, campaignId, responseId, {client = prisma} = {}) {
  const campaign = await campaignForUser(user, campaignId, client)
  const response = await client.collectionResponse.findFirst({where: {id: responseId, campaignId, ...campaignResponseAccessWhere(user, campaign)}, include: {exploitation: {include: exploitationInclude}}})
  if (!response || response.preleveurUserId !== response.exploitation.declarantUserId) throw createHttpError(404, 'Réponse introuvable.')
  const exploitation = {...response.exploitation, pointPrelevement: publicCampaignPoint(response.exploitation.pointPrelevement)}
  const [allocations, usages, coordinates] = await Promise.all([
    client.meterAllocation.findMany({where: {exploitationId: exploitation.id}, include: {compteur: {select: {id: true, serialNumber: true, deletedAt: true, meterAllocations: {select: {exploitationId: true}}}}}}),
    client.sandreWaterUse.findMany({where: {kind: 'SUB_USAGE'}}),
    client.$queryRaw`SELECT ST_X(coordinates) AS longitude, ST_Y(coordinates) AS latitude FROM "PointPrelevement" WHERE id = ${exploitation.pointPrelevementId}::uuid`
  ])
  const meters = [...new Map(allocations.filter(row => !row.compteur.deletedAt).map(row => [row.compteurId, {compteurId: row.compteurId, id: row.compteurId, serialNumber: row.compteur.serialNumber, shared: new Set(row.compteur.meterAllocations.map(item => item.exploitationId)).size > 1}])).values()]
  let canEdit = true
  let canSubmit = true
  const blockers = []
  try { assertCampaignResponseWritable({campaign, response, exploitation}, user) } catch (error) { canEdit = false; canSubmit = false; blockers.push(error.message) }
  if (canSubmit) try { assertCampaignResponseWritable({campaign, response, exploitation}, user, {submitting: true}) } catch (error) { canSubmit = false; blockers.push(error.message) }
  const permissions = {...getCampaignPermissions(user, campaign), canEdit, canSubmit}
  const publicResponse = serializeCampaignResponse(response, user, {includeData: true})
  publicResponse.volumes = (await getCampaignResponseVolumes([response], {client})).get(response.id)
  let data = publicResponse.draftData ?? publicResponse.submittedData
  if (!data) {
    const exactValues = await client.chunkValue.findMany({where: {valueKind: 'DECLARED', metricTypeCode: {in: getCompatibleMetricTypeCodes('index')},
      periodStart: {in: CAMPAIGN_READING_DATES.map(date => new Date(`${date}T00:00:00Z`))},
      chunk: {exploitationId: exploitation.id, preleveurUserId: response.preleveurUserId, compteurId: {in: meters.map(meter => meter.compteurId)},
        calculationStrategy: 'GENERIC', instructionStatus: {not: 'REJECTED'}, source: {status: 'COMPLETED'}}},
    select: {periodStart: true, value: true, chunk: {select: {compteurId: true, usageId: true}}}})
    data = buildInitialCampaignData(meters, exactValues, usages)
  }
  return {campaign, response: publicResponse, exploitation, permissions, meters, waterUses: serializeWaterUses(usages), data, blockers,
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
  const result = await listCollectionResponses(user, campaignId, {...query, status: 'SUBMITTED'}, {client})
  const rows = await client.collectionResponse.findMany({where: {campaignId, ...campaignResponseAccessWhere(user, campaign), firstSubmittedAt: {not: null}},
    select: {id: true, campaignId: true, exploitationId: true, declarationId: true, firstSubmittedAt: true, publicationStatus: true, submittedData: true}})
  const waterUses = serializeWaterUses(await client.sandreWaterUse.findMany({where: {kind: 'SUB_USAGE'}}))
  const expected = await client.collectionResponse.count({where: {campaignId, ...campaignResponseAccessWhere(user, campaign)}})
  const volumes = [...(await getCampaignResponseVolumes(rows, {client})).values()]
  const sumPublished = key => volumes.some(row => row[key] !== null) ? volumes.reduce((sum, row) => sum + (row[key] ?? 0), 0) : null
  return {...result, waterUses, totals: {submitted: rows.length, total: expected,
    requestedSeasonVolume: rows.reduce((sum, row) => sum + Number(row.submittedData?.needs?.season?.volume ?? 0), 0),
    requestedOffSeasonVolume: rows.reduce((sum, row) => sum + Number(row.submittedData?.needs?.offSeason?.volume ?? 0), 0),
    publishedVolumes: {offSeason: sumPublished('offSeason'), season: sumPublished('season'), total: sumPublished('total'), partial: rows.length < expected || volumes.some(row => row.partial || row.publicationStatus !== 'PUBLISHED')}},
  warnings: ['Les volumes demandés ne sont pas des volumes prélevés.', 'Les volumes publiés ne couvrent pas les réponses encore en attente de validation.']}
}
