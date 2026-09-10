import {randomUUID} from 'node:crypto'
import createError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {
  validateCampaignConfig, validateCampaignDraft, validateCampaignValue,
  campaignResponseRequestSchema, campaignSubmitSchema, campaignVersionSchema, campaignMeterSchema, campaignManagersSchema, campaignIndexDraftSchema
} from '../validation/campaigns.js'
import {
  getCampaignAccess, assertCampaignCapability, getCampaignResponseScope, filterCampaignSnapshot, isCampaignResponseWindowOpen
} from './campaign-permissions.js'
import {getPermissionZoneIdsForUser} from './zone-permissions.js'
import {calculateCampaignIndexTotals} from './campaign-index.js'
import {prepareCampaignResponseMeters, publishCampaignResponseMeters} from './campaign-response-meters.js'
import {loadCampaignListProgress} from './campaign-progress.js'
import {loadCampaignExistingReadings, publishCampaignIndexSubmission} from './campaign-publication.js'
import {enqueueCampaignNotifications} from './campaign-delivery.js'
import {getPrimaryDeclarantContactEmail} from './declarant-contact-emails.js'
import {canCollectManually} from './manual-collection.js'
import {OPERATIONAL_EXPLOITATION_STATUSES} from './exploitation-periods.js'

/* eslint-disable no-await-in-loop -- Les écritures sont sérialisées dans une transaction unique. */

export {getCampaignAccess} from './campaign-permissions.js'

const responseInclude = {latestSubmission: true}
const day = value => value ? new Date(value).toISOString().slice(0, 10) : null
const asDate = value => value ? new Date(`${day(value)}T00:00:00.000Z`) : null
const conflict = () => createError(409, 'La campagne ou le brouillon a changé. Rechargez les données avant de poursuivre.')
const declarantLabel = item => item?.socialReason || [item?.user?.firstName, item?.user?.lastName].filter(Boolean).join(' ')
const declarantOption = item => ({userId: item.userId, label: declarantLabel(item)})
const declarantOptionSelect = {userId: true, socialReason: true, user: {select: {firstName: true, lastName: true}}}
const publicUsage = usage => usage ? {id: usage.id, name: usage.label, code: usage.code, color: usage.color} : null

async function transaction(client, callback, {isolationLevel = 'Serializable'} = {}) {
  try {
    return await client.$transaction(callback, {isolationLevel, timeout: 30_000})
  } catch (error) {
    if (['P2034', 'P2002'].includes(error.code)) {
      throw conflict()
    }

    throw error
  }
}

export function publicTarget(target) {
  const {exploitation, pointPrelevement, preleveur, meters, ...rest} = target
  return {
    ...rest,
    usage: publicUsage(exploitation?.usage),
    pointPrelevement: {id: pointPrelevement.id, name: pointPrelevement.name, usageName: pointPrelevement.usageName, collectionMode: pointPrelevement.collectionMode, coordinates: pointPrelevement.coordinates ?? null},
    preleveur: {userId: preleveur.userId, label: preleveur.socialReason || [preleveur.user.firstName, preleveur.user.lastName].filter(Boolean).join(' ')},
    meters: meters.map(meter => ({id: meter.id, associationId: meter.associationId, compteurId: meter.compteurId, compteur: {id: meter.compteur.id, serialNumber: meter.compteur.serialNumber, identifier: meter.compteur.identifier}, startDate: day(meter.startDate), endDate: day(meter.endDate), ...(meter.pending ? {pending: true, pendingEvent: meter.pendingEvent} : {})}))
  }
}

export function serializeCampaign(campaign, {canManage = false} = {}) {
  const {ownerCollecteur, managers, ...publicCampaign} = campaign
  const result = {
    ...publicCampaign,
    owner: {userId: campaign.ownerCollecteurUserId, label: declarantLabel(ownerCollecteur)},
    ownerContact: {label: ownerCollecteur?.socialReason || [ownerCollecteur?.user?.firstName, ownerCollecteur?.user?.lastName].filter(Boolean).join(' '), email: getPrimaryDeclarantContactEmail(ownerCollecteur)},
    periods: campaign.periods.map(period => ({...period, startDate: day(period.startDate), endDate: day(period.endDate), startReadingDate: day(period.startReadingDate), endReadingDate: day(period.endReadingDate)})),
    targets: campaign.targets.map(target => publicTarget(target))
  }
  if (canManage) {
    result.managers = (managers ?? []).map(manager => ({userId: manager.userId, role: manager.role, label: declarantLabel({socialReason: manager.user?.declarant?.socialReason, user: manager.user})}))
  } else {
    delete result.createdByUserId
  }

  return result
}

async function assertConfigurationAuthority(user, config, client, {allowExistingScope = false} = {}) {
  const owner = await client.declarant.findUnique({where: {userId: config.ownerCollecteurUserId}, select: {declarantRole: true, user: {select: {deletedAt: true}}}})
  if (!owner || owner.declarantRole !== 'COLLECTEUR' || owner.user.deletedAt) {
    throw createError(400, 'Le propriétaire doit être un collecteur actif.')
  }

  if (!allowExistingScope && user.role !== 'ADMIN' && !(user.role === 'DECLARANT' && user.id === config.ownerCollecteurUserId)) {
    const zoneIds = await getPermissionZoneIdsForUser(user, 'campaign.manage', {client, zoneIds: [config.zoneId]})
    if (zoneIds.length === 0) {
      throw createError(403, 'Vous ne pouvez pas configurer cette campagne pour ce collecteur et cette zone.')
    }
  }

  const zone = await client.zone.findUnique({where: {id: config.zoneId}, select: {id: true}})
  if (!zone) {
    throw createError(400, 'La zone de campagne est introuvable.')
  }

  await assertActiveCampaignManagers(config.managers, client)
}

async function assertActiveCampaignManagers(managers, client) {
  const activeManagers = await client.user.findMany({where: {id: {in: managers.map(item => item.userId)}, deletedAt: null, declarant: {declarantRole: 'COLLECTEUR'}}, select: {id: true}})
  if (activeManagers.length !== managers.length) {
    throw createError(400, 'Les gestionnaires délégués doivent être des collecteurs actifs.')
  }
}

async function resolveCampaignTargets(config, client) {
  const exploits = await client.declarantPointPrelevement.findMany({
    where: {id: {in: config.targets.map(target => target.exploitationId)}},
    include: {collecteurs: true, declarant: {select: {declarantRole: true, user: {select: {deletedAt: true}}}}, pointPrelevement: {select: {deletedAt: true, zones: {select: {zoneId: true}}}}}
  })
  if (exploits.length !== config.targets.length || new Set(exploits.map(item => item.pointPrelevementId)).size !== exploits.length) {
    throw createError(400, 'Sélectionnez une seule exploitation explicite par point de la campagne.')
  }

  return config.targets.map(target => {
    const exploitation = exploits.find(item => item.id === target.exploitationId)
    if (exploitation.pointPrelevement.deletedAt || exploitation.declarant.user.deletedAt || exploitation.declarant.declarantRole !== 'PRELEVEUR' || !exploitation.pointPrelevement.zones.some(link => link.zoneId === config.zoneId) || !exploitation.collecteurs.some(link => link.collecteurUserId === config.ownerCollecteurUserId)) {
      throw createError(400, 'Chaque exploitation doit relever de la zone et être déléguée au collecteur propriétaire.')
    }

    return {...target, pointPrelevementId: exploitation.pointPrelevementId, preleveurUserId: exploitation.declarantUserId}
  })
}

function configData(config) {
  const {expectedVersion, periods, targets, managers, ...data} = config
  return data
}

function periodData(period) {
  const {id, ...data} = period
  return {...data, startDate: asDate(period.startDate), endDate: asDate(period.endDate), startReadingDate: asDate(period.startReadingDate), endReadingDate: asDate(period.endReadingDate)}
}

async function bumpCampaign(client, campaign, expectedVersion, data = {}) {
  const changed = await client.campaign.updateMany({where: {id: campaign.id, version: expectedVersion, status: campaign.status}, data: {...data, version: {increment: 1}}})
  if (changed.count !== 1) {
    throw conflict()
  }
}

export async function createCampaign(user, input, {client = prisma} = {}) {
  const config = validateCampaignConfig(input, {create: true})
  const campaignId = await transaction(client, async tx => {
    await assertConfigurationAuthority(user, config, tx)
    const targets = await resolveCampaignTargets(config, tx)
    const campaign = await tx.campaign.create({data: {
      ...configData(config), createdByUserId: user.id,
      periods: {create: config.periods.map(period => periodData(period))},
      targets: {create: targets}, managers: {create: config.managers}
    }})
    return campaign.id
  })
  return getCampaignDetail(user, campaignId, {client})
}

export async function updateCampaign(user, campaignId, input, {client = prisma} = {}) {
  const config = validateCampaignConfig(input)
  await transaction(client, async tx => {
    const access = await getCampaignAccess(user, campaignId, {client: tx})
    assertCampaignCapability(access, 'canManage')
    if (!access.scopeComplete || access.campaign.status !== 'DRAFT') {
      throw createError(409, 'La configuration d’une campagne ouverte est figée.')
    }

    await assertConfigurationAuthority(user, config, tx, {allowExistingScope: access.campaign.ownerCollecteurUserId === config.ownerCollecteurUserId && access.campaign.zoneId === config.zoneId})
    const targets = await resolveCampaignTargets(config, tx)
    await bumpCampaign(tx, access.campaign, config.expectedVersion, configData(config))
    await tx.campaignPeriod.deleteMany({where: {campaignId}})
    await tx.campaignPeriod.createMany({data: config.periods.map(period => ({...periodData(period), campaignId}))})
    await tx.campaignManager.deleteMany({where: {campaignId}})
    await tx.campaignManager.createMany({data: config.managers.map(manager => ({...manager, campaignId}))})
    await tx.campaignTarget.deleteMany({where: {campaignId, exploitationId: {notIn: targets.map(target => target.exploitationId)}}})
    for (const target of targets) {
      await tx.campaignTarget.upsert({where: {campaignId_exploitationId: {campaignId, exploitationId: target.exploitationId}}, create: {campaignId, ...target}, update: target})
    }
  })
  return getCampaignDetail(user, campaignId, {client})
}

export async function updateCampaignManagers(user, campaignId, input, {client = prisma} = {}) {
  const config = validateCampaignValue(campaignManagersSchema, input)
  await transaction(client, async tx => {
    const access = await getCampaignAccess(user, campaignId, {client: tx})
    assertCampaignCapability(access, 'canManageSharing')
    await assertActiveCampaignManagers(config.managers, tx)
    await bumpCampaign(tx, access.campaign, config.expectedVersion)
    await tx.campaignManager.deleteMany({where: {campaignId}})
    await tx.campaignManager.createMany({data: config.managers.map(manager => ({...manager, campaignId}))})
  })
  try {
    return await getCampaignDetail(user, campaignId, {client})
  } catch (error) {
    if (error.statusCode === 403) {
      return {accessRevoked: true, campaign: null, permissions: {canRead: false, canManage: false, canManageSharing: false}, targets: [], managerOptions: []}
    }

    throw error
  }
}

export function assertCampaignOpeningTargets(campaign, targets, bindings) {
  if (targets.length === 0) {
    throw createError(400, 'Sélectionnez des points avant l’ouverture.')
  }

  const start = [...campaign.indexDates].sort()[0]
  const end = [...campaign.indexDates].sort().at(-1)
  for (const target of targets) {
    if (!target.eligibilityConfirmed || !canCollectManually(target.pointPrelevement) || target.pointPrelevement.deletedAt || target.preleveur?.user?.deletedAt || !target.exploitation.collecteurs.some(link => link.collecteurUserId === campaign.ownerCollecteurUserId)) {
      throw createError(409, 'Chaque point doit être confirmé et autorisé à la saisie avant l’ouverture.')
    }

    const {exploitation} = target
    if ((exploitation.startDate && day(exploitation.startDate) > start) || (exploitation.endDate && day(exploitation.endDate) < end) || ['ABANDONNEE', 'TERMINEE'].includes(exploitation.status)) {
      throw createError(409, 'L’exploitation doit couvrir toute la période d’index de la campagne.')
    }

    const meters = bindings.filter(binding => binding.pointPrelevementId === target.pointPrelevementId && !binding.compteur.deletedAt && (!binding.startDate || day(binding.startDate) <= end) && (!binding.endDate || day(binding.endDate) >= start))
    if (meters.length === 0) {
      if (bindings.some(binding => binding.pointPrelevementId === target.pointPrelevementId && !binding.compteur.deletedAt)) {
        throw createError(409, 'Les dates des compteurs renseignés ne couvrent pas les relevés demandés.')
      }

      // L'absence d'inventaire ne bloque pas la collecte des index par point.
      // Aucune fiche compteur n'est créée automatiquement.
      continue
    }

    for (const meter of meters) {
      const competing = bindings.some(binding => binding.compteurId === meter.compteurId && binding.pointPrelevementId !== meter.pointPrelevementId && (!binding.startDate || !meter.endDate || day(binding.startDate) <= day(meter.endDate)) && (!binding.endDate || !meter.startDate || day(binding.endDate) >= day(meter.startDate)))
      if (competing) {
        throw createError(409, 'Un compteur est rattaché simultanément à plusieurs points : corrigez ses périodes d’affectation.')
      }
    }

    for (const date of campaign.indexDates) {
      if (!meters.some(meter => (!meter.startDate || day(meter.startDate) <= date) && (!meter.endDate || day(meter.endDate) >= date))) {
        throw createError(409, 'Les affectations de compteurs doivent couvrir chaque date de relevé attendue.')
      }
    }
  }
}

export async function changeCampaignStatus(user, campaignId, status, input, {client = prisma, now = new Date()} = {}) {
  const {expectedVersion} = validateCampaignValue(campaignVersionSchema, input)
  if (!['OPEN', 'CLOSED'].includes(status)) {
    throw createError(400, 'État de campagne inconnu.')
  }

  await transaction(client, async tx => {
    const access = await getCampaignAccess(user, campaignId, {client: tx})
    assertCampaignCapability(access, 'canManage')
    const {campaign} = access
    if (!access.scopeComplete || campaign.status !== (status === 'OPEN' ? 'DRAFT' : 'OPEN')) {
      throw createError(409, 'Cette transition de campagne n’est pas disponible dans votre périmètre.')
    }

    if (status === 'OPEN') {
      if (campaign.opensAt && now < new Date(campaign.opensAt)) {
        throw createError(409, 'La campagne ne peut pas être ouverte avant la date de début des réponses prévue.')
      }

      if (campaign.closesAt && now >= new Date(campaign.closesAt)) {
        throw createError(409, 'La date limite de réponse est dépassée. Modifiez le calendrier avant d’ouvrir la campagne.')
      }

      const pointBindings = await tx.compteurPointPrelevement.findMany({where: {pointPrelevementId: {in: access.targets.map(target => target.pointPrelevementId)}}, include: {compteur: true}})
      const bindings = await tx.compteurPointPrelevement.findMany({where: {compteurId: {in: pointBindings.map(binding => binding.compteurId)}}, include: {compteur: true}})
      assertCampaignOpeningTargets(campaign, access.targets, bindings)
      for (const target of access.targets) {
        await tx.campaignTargetMeter.deleteMany({where: {targetId: target.id}})
        await tx.campaignTargetMeter.createMany({data: pointBindings.filter(binding => binding.pointPrelevementId === target.pointPrelevementId && !binding.compteur.deletedAt && (!binding.startDate || day(binding.startDate) <= [...campaign.indexDates].sort().at(-1)) && (!binding.endDate || day(binding.endDate) >= [...campaign.indexDates].sort()[0])).map(binding => ({targetId: target.id, associationId: binding.id, compteurId: binding.compteurId, startDate: binding.startDate, endDate: binding.endDate}))})
      }
    }

    await bumpCampaign(tx, campaign, expectedVersion, {status, ...(status === 'OPEN' ? {openedAt: now} : {closedAt: now})})
    if (status === 'OPEN') {
      await enqueueCampaignNotifications(tx, {campaign, kind: 'OPENING', now, preleveurUserIds: [...new Set(access.targets.map(target => target.preleveurUserId))]})
    }
  })
  return getCampaignDetail(user, campaignId, {client})
}

async function campaignDetailFromAccess(access, client) {
  const managerOptions = access.permissions.canManageSharing
    ? await client.declarant.findMany({where: {
      declarantRole: 'COLLECTEUR', user: {deletedAt: null},
      OR: [
        {collecteurExploitations: {some: {exploitation: {pointPrelevement: {zones: {some: {zoneId: access.campaign.zoneId}}}}}}},
        {userId: {in: [access.campaign.ownerCollecteurUserId, ...access.campaign.managers.map(manager => manager.userId)]}}
      ]
    }, select: declarantOptionSelect, orderBy: [{socialReason: 'asc'}, {userId: 'asc'}]})
    : []
  return {campaign: serializeCampaign(access.campaign, access.permissions), permissions: access.permissions, targets: access.targets.map(target => publicTarget(target)), managerOptions: managerOptions.map(declarantOption)}
}

export async function getCampaignDetail(user, campaignId, {client = prisma} = {}) {
  return campaignDetailFromAccess(await getCampaignAccess(user, campaignId, {client}), client)
}

export async function listCampaigns(user, {client = prisma} = {}) {
  const zoneIds = await getPermissionZoneIdsForUser(user, 'campaign.read', {client})
  const managingZoneIds = await getPermissionZoneIdsForUser(user, 'campaign.manage', {client})
  const declarant = user.role === 'DECLARANT' ? await client.declarant.findUnique({where: {userId: user.id}, select: {declarantRole: true}}) : null
  const rows = await client.campaign.findMany({where: user.role === 'ADMIN'
    ? {}
    : {OR: [
      {ownerCollecteurUserId: user.id},
      {managers: {some: {userId: user.id}}},
      {zoneId: {in: [...zoneIds, ...managingZoneIds]}},
      {status: {not: 'DRAFT'}, targets: {some: {OR: [{preleveurUserId: user.id}, {exploitation: {collecteurs: {some: {collecteurUserId: user.id}}}}]}}}
    ]}, select: {id: true}, orderBy: [{year: 'desc'}, {createdAt: 'desc'}], take: 200})
  const items = []
  const accesses = []
  for (const row of rows) {
    const access = await getCampaignAccess(user, row.id, {client})
    accesses.push(access)
    items.push(await campaignDetailFromAccess(access, client))
  }

  const progress = await loadCampaignListProgress(accesses, {client})
  return {items: items.map(item => ({...item, progress: progress.get(item.campaign.id) ?? null})),
    permissions: {canCreate: user.role === 'ADMIN' || declarant?.declarantRole === 'COLLECTEUR' || managingZoneIds.length > 0}}
}

function scopedResponse(response, scope) {
  if (!response) {
    return null
  }

  const targetIds = scope.targets.map(target => target.id)
  return {...response,
    draft: filterCampaignSnapshot(response.draft, targetIds, scope),
    latestSubmission: response.latestSubmission
      ? {...response.latestSubmission,
        snapshot: filterCampaignSnapshot(response.latestSubmission.snapshot, targetIds, scope),
        publication: filterCampaignSnapshot(response.latestSubmission.publication, targetIds, scope)
      }
      : null}
}

async function calculateContext(campaign, targets, draft, client) {
  const existingReadings = await loadCampaignExistingReadings({campaign, targets, client})
  const calculation = calculateCampaignIndexTotals({campaign, targets, readings: draft?.readings ?? [], meterEvents: draft?.meterEvents ?? [], existingReadings})
  return {existingReadings, calculation}
}

export async function loadCampaignTargetCoordinates(targets, client) {
  if (targets.length === 0) {
    return targets
  }

  // Le périmètre du déclarant est résolu avant cette unique requête spatiale.
  const pointIds = [...new Set(targets.map(target => target.pointPrelevementId))]
  const rows = await client.$queryRaw`
    SELECT id, ST_AsGeoJSON(coordinates)::json AS coordinates
    FROM "PointPrelevement"
    WHERE id = ANY(${pointIds}::uuid[])
  `
  const coordinates = new Map(rows.map(row => [row.id, row.coordinates]))
  return targets.map(target => ({...target, pointPrelevement: {...target.pointPrelevement, coordinates: coordinates.get(target.pointPrelevementId) ?? null}}))
}

export async function getCampaignContext(user, campaignId, requestedPreleveurUserId, {client = prisma} = {}) {
  const access = await getCampaignAccess(user, campaignId, {client})
  const availablePreleveurs = [...new Map(access.targets.map(target => [target.preleveurUserId, {userId: target.preleveurUserId, label: publicTarget(target).preleveur.label}])).values()]
  const preleveurUserId = requestedPreleveurUserId || (availablePreleveurs.some(item => item.userId === user.id) ? user.id : availablePreleveurs[0]?.userId)
  if (!preleveurUserId) {
    return {campaign: serializeCampaign({...access.campaign, targets: []}, access.permissions), targets: [], availablePreleveurs, preleveurUserId: null, permissions: {...access.permissions, canEdit: false, canSubmit: false, canReopen: false}, responses: {INDEX: null, NEEDS: null}, existingReadings: [], calculation: {totals: [], issues: []}}
  }

  const scope = getCampaignResponseScope(access, user, preleveurUserId)
  const responseRows = await client.campaignResponse.findMany({where: {campaignId, preleveurUserId}, include: responseInclude})
  const responses = Object.fromEntries(['INDEX', 'NEEDS'].map(kind => {
    const row = responseRows.find(item => item.kind === kind)
    const responseScope = getCampaignResponseScope(access, user, preleveurUserId, row)
    return [kind, {...(scopedResponse(row, responseScope) ?? {kind, version: 0, status: 'DRAFT', draft: {}, latestSubmission: null}), permissions: responseScope.permissions}]
  }))
  const prepared = prepareCampaignResponseMeters(scope.targets, responses.INDEX?.draft, {campaign: access.campaign})
  const [context, targets] = await Promise.all([
    calculateContext(access.campaign, prepared.targets, prepared.draft, client),
    loadCampaignTargetCoordinates(prepared.targets, client)
  ])
  return {campaign: serializeCampaign({...access.campaign, targets}, scope.permissions), permissions: {...scope.permissions, canEdit: responses.INDEX.permissions.canEdit || responses.NEEDS.permissions.canEdit, canSubmit: responses.INDEX.permissions.canSubmit || responses.NEEDS.permissions.canSubmit}, editableTargetIds: scope.editableTargets.map(target => target.id), targets: targets.map(target => publicTarget(target)), preleveurUserId, availablePreleveurs, responses, ...context}
}

export async function listCampaignResponses(user, campaignId, {client = prisma} = {}) {
  const access = await getCampaignAccess(user, campaignId, {client})
  if (!access.permissions.canManage && !access.permissions.canExport && user.role !== 'INSTRUCTOR') {
    throw createError(403, 'Le suivi de campagne est réservé aux gestionnaires autorisés.')
  }

  const rows = await client.campaignResponse.findMany({where: {campaignId, preleveurUserId: {in: [...new Set(access.targets.map(target => target.preleveurUserId))]}}, include: responseInclude})
  return {campaign: access.campaign, permissions: access.permissions, targets: access.targets,
    responses: rows.map(row => scopedResponse(row, getCampaignResponseScope(access, user, row.preleveurUserId)))}
}

export async function getCampaignResponseHistory(user, campaignId, kind, {preleveurUserId, cursor, client = prisma} = {}) {
  if (!['INDEX', 'NEEDS'].includes(kind)) {
    throw createError(400, 'Volet de campagne inconnu.')
  }

  const access = await getCampaignAccess(user, campaignId, {client})
  const scope = getCampaignResponseScope(access, user, preleveurUserId)
  const response = await client.campaignResponse.findUnique({where: {campaignId_preleveurUserId_kind: {campaignId, preleveurUserId, kind}}, select: {id: true}})
  if (!response) {
    return {items: [], nextCursor: null}
  }

  if (cursor && !await client.campaignSubmission.findFirst({where: {id: cursor, responseId: response.id}, select: {id: true}})) {
    throw createError(400, 'Le curseur ne correspond pas à cet historique.')
  }

  const rows = await client.campaignSubmission.findMany({where: {responseId: response.id},
    orderBy: [{submittedAt: 'desc'}, {id: 'desc'}], take: 51,
    ...(cursor ? {cursor: {id: cursor}, skip: 1} : {}),
    select: {id: true, version: true, submittedAt: true, createdByUserId: true, createdBy: {select: {firstName: true, lastName: true}}, snapshot: true, publication: true}
  })
  const targetIds = scope.targets.map(target => target.id)
  return {items: rows.slice(0, 50).map(row => ({...row,
    createdBy: {...row.createdBy, label: [row.createdBy.firstName, row.createdBy.lastName].filter(Boolean).join(' ')},
    snapshot: filterCampaignSnapshot(row.snapshot, targetIds, scope),
    publication: filterCampaignSnapshot(row.publication, targetIds, scope)
  })), nextCursor: rows.length > 50 ? rows[49].id : null}
}

function assertResponseWindow(campaign, response) {
  if (!isCampaignResponseWindowOpen(campaign, response)) {
    throw createError(409, 'Cette campagne n’est pas ouverte à la saisie.')
  }
}

function assertResponseEditable(response, expectedVersion) {
  if ((response?.version ?? 0) !== expectedVersion) {
    throw conflict()
  }
}

export function mergeCampaignDraft(current, incoming, editableTargetIds, complete) {
  if (complete) {
    return incoming
  }

  const allowed = new Set(editableTargetIds)
  const merged = {...current}
  for (const key of ['readings', 'needs', 'meterEvents']) {
    if (Array.isArray(incoming[key])) {
      merged[key] = [...(current[key] ?? []).filter(item => !allowed.has(item.targetId)), ...incoming[key]]
    }
  }

  return merged
}

export function normalizePublishedCampaignDraft(snapshot, publication) {
  const references = new Map((publication?.readingReferences ?? []).map(reading => [`${reading.targetId}:${reading.compteurId}:${reading.readingDate}`, reading]))
  return {...snapshot, readings: snapshot.readings.map(reading => {
    const reference = references.get(`${reading.targetId}:${reading.compteurId}:${reading.readingDate}`)
    if (!reference?.chunkValueId || !reference.sourceValueUpdatedAt) {
      return reading
    }

    const result = {...reading, sourceChunkValueId: reference.chunkValueId, sourceValueUpdatedAt: new Date(reference.sourceValueUpdatedAt).toISOString()}
    delete result.correctionOfChunkValueId
    delete result.correctionReason
    return result
  })}
}

export async function saveCampaignResponse(user, campaignId, kind, input, {client = prisma} = {}) {
  const request = validateCampaignValue(campaignResponseRequestSchema, input)
  await transaction(client, async tx => {
    const access = await getCampaignAccess(user, campaignId, {client: tx})
    const where = {campaignId_preleveurUserId_kind: {campaignId, preleveurUserId: request.preleveurUserId, kind}}
    const current = await tx.campaignResponse.findUnique({where})
    assertResponseWindow(access.campaign, current)
    const scope = getCampaignResponseScope(access, user, request.preleveurUserId, current)
    if (!scope.permissions.canEdit) {
      throw createError(403, 'Vous ne pouvez pas saisir les données de ce préleveur.')
    }

    assertResponseEditable(current, request.expectedVersion)
    const raw = kind === 'INDEX' ? validateCampaignValue(campaignIndexDraftSchema, request.data) : request.data
    const prepared = kind === 'INDEX' ? prepareCampaignResponseMeters(scope.editableTargets, raw, {campaign: access.campaign, previousDraft: current?.draft}) : {targets: scope.editableTargets}
    const incoming = validateCampaignDraft(kind, prepared.draftForSave ?? raw, {campaign: access.campaign, targets: prepared.targets,
      previousDraft: filterCampaignSnapshot(current?.draft, scope.editableTargets.map(target => target.id), {complete: scope.permissions.canSubmit})})
    const draft = mergeCampaignDraft(current?.draft ?? {}, incoming, scope.editableTargets.map(target => target.id), scope.permissions.canSubmit)
    if (current) {
      const changed = await tx.campaignResponse.updateMany({where: {id: current.id, version: request.expectedVersion, status: current.status}, data: {draft, status: 'DRAFT', version: {increment: 1}}})
      if (changed.count !== 1) {
        throw conflict()
      }
    } else {
      await tx.campaignResponse.create({data: {campaignId, preleveurUserId: request.preleveurUserId, kind, draft, version: 1}})
    }
  })
  const context = await getCampaignContext(user, campaignId, request.preleveurUserId, {client})
  return {response: context.responses[kind], calculation: context.calculation, targets: context.targets}
}

export async function submitCampaignResponse(user, campaignId, kind, input, {client = prisma} = {}) {
  const request = validateCampaignValue(campaignSubmitSchema, input)
  if (!['INDEX', 'NEEDS'].includes(kind)) {
    throw createError(400, 'Volet de campagne inconnu.')
  }

  const committedSubmission = await transaction(client, async tx => {
    const access = await getCampaignAccess(user, campaignId, {client: tx})
    const current = await tx.campaignResponse.findUnique({where: {campaignId_preleveurUserId_kind: {campaignId, preleveurUserId: request.preleveurUserId, kind}}})
    const scope = getCampaignResponseScope(access, user, request.preleveurUserId, current)
    if (scope.editableTargets.length === 0 || scope.editableTargets.length !== access.responseTargetCounts.get(request.preleveurUserId)) {
      throw createError(403, 'La transmission complète doit être faite par le préleveur ou un mandataire autorisé sur tous les points de cette campagne.')
    }

    if (!current) {
      throw createError(409, 'Enregistrez votre brouillon avant de le transmettre.')
    }

    const replay = await tx.campaignSubmission.findUnique({where: {responseId_idempotencyKey: {responseId: current.id, idempotencyKey: request.idempotencyKey}}})
    if (replay) {
      if (replay.version !== request.expectedVersion + 1 || replay.createdByUserId !== user.id) {
        throw conflict()
      }

      return replay
    }

    assertResponseWindow(access.campaign, current)
    if (current.status !== 'DRAFT') {
      throw createError(409, 'Cette réponse a déjà été transmise. Enregistrez une correction avant une nouvelle transmission.')
    }

    assertResponseEditable(current, request.expectedVersion)
    const prepared = kind === 'INDEX' ? prepareCampaignResponseMeters(scope.editableTargets, current.draft, {campaign: access.campaign}) : {targets: scope.editableTargets, draft: current.draft}
    validateCampaignDraft(kind, current.draft, {campaign: access.campaign, targets: prepared.targets, complete: true})
    const publicationContext = kind === 'INDEX' ? await publishCampaignResponseMeters(prepared.targets, prepared.draft, tx) : prepared
    const snapshot = validateCampaignDraft(kind, publicationContext.draft, {campaign: access.campaign, targets: publicationContext.targets, complete: true})
    const submission = await tx.campaignSubmission.create({data: {id: randomUUID(), responseId: current.id, version: current.version + 1, idempotencyKey: request.idempotencyKey, createdByUserId: user.id, snapshot}})
    let draft = snapshot
    if (kind === 'NEEDS') {
      await tx.campaignNeedLine.createMany({data: snapshot.needs.map(need => ({...need, requestedFlow: need.requestedFlow || null, submissionId: submission.id}))})
    } else {
      const publication = await publishCampaignIndexSubmission({submission, campaign: access.campaign, targets: publicationContext.targets, actorUserId: user.id, client: tx})
      await tx.campaignSubmission.update({where: {id: submission.id}, data: {publication}})
      submission.publication = publication
      draft = normalizePublishedCampaignDraft(snapshot, publication)
    }

    const changed = await tx.campaignResponse.updateMany({where: {id: current.id, version: request.expectedVersion, status: 'DRAFT'}, data: {status: 'SUBMITTED', version: {increment: 1}, latestSubmissionId: submission.id, draft}})
    if (changed.count !== 1) {
      throw conflict()
    }

    await enqueueCampaignNotifications(tx, {campaign: access.campaign, submission, kind: 'RECEIPT', preleveurUserIds: [request.preleveurUserId]})
    return submission
  }, {isolationLevel: 'ReadCommitted'})
  const context = await getCampaignContext(user, campaignId, request.preleveurUserId, {client})
  return {response: context.responses[kind], calculation: context.calculation, submission: committedSubmission, targets: context.targets}
}

export async function reopenCampaignResponse() {
  // Route conservée pour les anciens clients, sans lire ni modifier les données.
  // Les anciens délais et l’édition ordinaire restent gérés indépendamment.
  throw createError(410, 'La réouverture manuelle des réponses n’est plus disponible.')
}

export async function manageCampaignMeter(user, campaignId, targetId, associationId, input, {client = prisma} = {}) {
  const config = validateCampaignValue(campaignMeterSchema, input)
  if (config.startDate && config.endDate && config.startDate > config.endDate) {
    throw createError(400, 'La fin d’affectation du compteur doit suivre son début.')
  }

  await transaction(client, async tx => {
    const access = await getCampaignAccess(user, campaignId, {client: tx})
    assertCampaignCapability(access, 'canManage')
    const target = access.targets.find(item => item.id === targetId)
    if (!target) {
      throw createError(403, 'Ce point n’appartient pas à votre périmètre de campagne.')
    }

    if (access.campaign.status === 'CLOSED' || (access.campaign.status === 'OPEN' && associationId)) {
      throw createError(409, 'Les affectations existantes sont figées après ouverture ; un nouveau compteur daté peut être ajouté pendant la campagne.')
    }

    if (access.campaign.status === 'OPEN' && target.meters.length === 0) {
      throw createError(409, 'Les relevés de ce point sont collectés sans fiche compteur pour cette campagne. Renseignez le compteur avant une prochaine campagne.')
    }

    if (access.campaign.status === 'OPEN' && (!config.startDate || config.startDate < [...access.campaign.indexDates].sort()[0] || config.startDate > [...access.campaign.indexDates].sort().at(-1))) {
      throw createError(400, 'Renseignez une date de mise en service du nouveau compteur dans la période de campagne.')
    }

    const period = {startDate: asDate(config.startDate), endDate: asDate(config.endDate)}
    let {compteurId} = config
    if (associationId) {
      const existing = await tx.compteurPointPrelevement.findUnique({where: {id: associationId}, include: {campaignMeters: {select: {target: {select: {campaign: {select: {status: true}}}}}}}})
      if (!existing || existing.pointPrelevementId !== target.pointPrelevementId) {
        throw createError(404, 'Affectation de compteur introuvable.')
      }

      if (existing.campaignMeters.some(meter => meter.target.campaign.status !== 'DRAFT') || (compteurId && compteurId !== existing.compteurId)) {
        throw createError(409, 'Cette affectation est déjà utilisée par une campagne ouverte ou par un autre compteur.')
      }

      compteurId = existing.compteurId
    } else if (!compteurId) {
      if (!config.serialNumber && !config.identifier) {
        throw createError(400, 'Indiquez le numéro de série ou l’identifiant du nouveau compteur.')
      }

      const compteur = await tx.compteur.create({data: {serialNumber: config.serialNumber, identifier: config.identifier}})
      compteurId = compteur.id
    }

    const compteur = await tx.compteur.findUnique({where: {id: compteurId}})
    if (!compteur || compteur.deletedAt) {
      throw createError(400, 'Le compteur sélectionné est introuvable ou archivé.')
    }

    const overlaps = await tx.compteurPointPrelevement.count({where: {
      compteurId,
      ...(associationId ? {id: {not: associationId}} : {}),
      AND: [
        ...(period.endDate ? [{OR: [{startDate: null}, {startDate: {lte: period.endDate}}]}] : []),
        ...(period.startDate ? [{OR: [{endDate: null}, {endDate: {gte: period.startDate}}]}] : [])
      ]
    }})
    if (overlaps > 0) {
      throw createError(409, 'Le compteur possède déjà une affectation sur cette période.')
    }

    await bumpCampaign(tx, access.campaign, config.expectedVersion)
    if (associationId) {
      await tx.compteurPointPrelevement.update({where: {id: associationId}, data: period})
    } else {
      const association = await tx.compteurPointPrelevement.create({data: {...period, compteurId, pointPrelevementId: target.pointPrelevementId}})
      if (access.campaign.status === 'OPEN') {
        await tx.campaignTargetMeter.create({data: {targetId, associationId: association.id, compteurId, ...period}})
      }
    }
  })
  return getCampaignDetail(user, campaignId, {client})
}

export async function getCampaignOptions(user, {zoneId, ownerCollecteurUserId, usageId, q = '', cursor, limit = 500, client = prisma} = {}) {
  const isAdmin = user.role === 'ADMIN'
  const zoneIds = isAdmin ? [] : await getPermissionZoneIdsForUser(user, 'campaign.manage', {client})
  const declarant = user.role === 'DECLARANT' ? await client.declarant.findUnique({where: {userId: user.id}, select: {declarantRole: true}}) : null
  const isCollecteur = declarant?.declarantRole === 'COLLECTEUR'
  if (!isAdmin && !isCollecteur && zoneIds.length === 0) {
    throw createError(403, 'Vous ne pouvez pas configurer de campagne.')
  }

  const activePreleveur = {declarantRole: 'PRELEVEUR', user: {deletedAt: null}}
  const activeCollecteur = {declarantRole: 'COLLECTEUR', user: {deletedAt: null}}
  // Une zone n’a pas de statut propre. Elle est proposée si une exploitation
  // encore utilisable relie un point, un préleveur et un collecteur actifs.
  const activeExploitation = {status: {in: OPERATIONAL_EXPLOITATION_STATUSES}, declarant: activePreleveur}
  const zones = await client.zone.findMany({
    where: {
      ...(!isAdmin && !isCollecteur ? {id: {in: zoneIds}} : {}),
      pointPrelevementZones: {some: {pointPrelevement: {
        deletedAt: null,
        declarants: {some: {...activeExploitation, collecteurs: {some: {...(isCollecteur ? {collecteurUserId: user.id} : {}), collecteur: activeCollecteur}}}}
      }}}
    },
    select: {id: true, name: true, type: true, code: true}, orderBy: {name: 'asc'}
  })
  const effectiveZoneId = zoneId || zones[0]?.id
  if (effectiveZoneId && !zones.some(zone => zone.id === effectiveZoneId)) {
    throw createError(403, 'Cette zone n’appartient pas à votre périmètre.')
  }

  const territoryCollecteur = effectiveZoneId && {...activeCollecteur, collecteurExploitations: {some: {exploitation: {
    ...activeExploitation, pointPrelevement: {deletedAt: null, zones: {some: {zoneId: effectiveZoneId}}}
  }}}}
  const collecteurs = territoryCollecteur
    ? await client.declarant.findMany({where: {...territoryCollecteur, ...(isCollecteur ? {userId: user.id} : {})}, select: declarantOptionSelect, take: 200})
    : []
  const selectedOwner = ownerCollecteurUserId || collecteurs[0]?.userId
  if (selectedOwner && !collecteurs.some(owner => owner.userId === selectedOwner)) {
    throw createError(403, 'Ce collecteur ne fait pas partie de votre périmètre de configuration.')
  }

  const scope = effectiveZoneId && selectedOwner
    ? {
      collecteurs: {some: {collecteurUserId: selectedOwner}},
      pointPrelevement: {deletedAt: null, zones: {some: {zoneId: effectiveZoneId}}},
      declarant: activePreleveur
    }
    : null
  const terms = q.trim().slice(0, 100).split(/\s+/).filter(Boolean)
  const where = scope && {
    ...scope,
    ...(usageId ? {usageId} : {}),
    ...(terms.length > 0
      ? {AND: terms.map(term => {
        const contains = {contains: term, mode: 'insensitive'}
        return {OR: [
          {pointPrelevement: {name: contains}},
          {pointPrelevement: {usageName: contains}},
          {declarant: {socialReason: contains}},
          {declarant: {user: {firstName: contains}}},
          {declarant: {user: {lastName: contains}}}
        ]}
      })}
      : {})
  }
  if (cursor && (!where || !await client.declarantPointPrelevement.findFirst({where: {...where, id: cursor}, select: {id: true}}))) {
    throw createError(400, 'La liste des points a changé. Relancez la recherche.')
  }

  const [rows, total, uses, points] = scope
    ? await Promise.all([
      client.declarantPointPrelevement.findMany({where, include: {
        usage: {select: {id: true, label: true, code: true, color: true}},
        pointPrelevement: {select: {id: true, name: true, usageName: true, collectionMode: true, compteurs: {include: {compteur: true}}}},
        declarant: {select: declarantOptionSelect}
      }, orderBy: [{pointPrelevement: {name: 'asc'}}, {id: 'asc'}], take: limit + 1, ...(cursor ? {cursor: {id: cursor}, skip: 1} : {})}),
      client.declarantPointPrelevement.count({where}),
      client.sandreWaterUse.findMany({where: {exploitations: {some: scope}}, select: {id: true, label: true, code: true, color: true}, orderBy: [{label: 'asc'}, {id: 'asc'}]}),
      client.declarantPointPrelevement.groupBy({by: ['pointPrelevementId'], where: scope, _count: {_all: true}})
    ])
    : [[], 0, [], []]
  const ambiguousPoints = new Set(points.filter(point => point._count._all > 1).map(point => point.pointPrelevementId))
  const exploitations = rows.slice(0, limit).map(exploitation => ({...exploitation, usage: publicUsage(exploitation.usage), ambiguousPoint: ambiguousPoints.has(exploitation.pointPrelevementId)}))
  const managers = territoryCollecteur
    ? await client.declarant.findMany({where: territoryCollecteur, select: declarantOptionSelect, take: 200})
    : []
  return {
    zones, collecteurs: collecteurs.map(declarantOption), managers: managers.map(declarantOption), exploitations, usages: uses.map(publicUsage),
    pagination: {total, limit, hasMore: rows.length > limit, nextCursor: rows.length > limit ? exploitations.at(-1).id : null}
  }
}

/* eslint-enable no-await-in-loop */
