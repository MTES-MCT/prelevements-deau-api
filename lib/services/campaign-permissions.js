import createError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {getPermissionZoneIdsForUser} from './zone-permissions.js'
import {canCollectManually} from './manual-collection.js'

/* eslint-disable no-await-in-loop -- Les droits utilisent le même client transactionnel. */

export const campaignInclude = {
  ownerCollecteur: {select: {socialReason: true, user: {select: {firstName: true, lastName: true, email: true}}, contactEmails: {select: {email: true, isPrimary: true}}}},
  zone: {select: {id: true, name: true, type: true, code: true}},
  periods: {orderBy: [{kind: 'asc'}, {position: 'asc'}]},
  managers: {include: {user: {select: {firstName: true, lastName: true, declarant: {select: {socialReason: true}}}}}},
  targets: {include: {
    exploitation: {include: {collecteurs: true, usage: {select: {id: true, label: true, code: true, color: true}}}},
    pointPrelevement: {select: {id: true, name: true, usageName: true, collectionMode: true, flowType: true, deletedAt: true, zones: {select: {zoneId: true}}}},
    preleveur: {select: {userId: true, socialReason: true, user: {select: {firstName: true, lastName: true, deletedAt: true}}}},
    meters: {include: {compteur: true}}
  }}
}

export function hasCampaignTargetDelegation(user, target) {
  return user?.role === 'DECLARANT' && (target.preleveurUserId === user.id || target.exploitation?.collecteurs?.some(link => link.collecteurUserId === user.id))
}

export function filterCampaignSnapshot(snapshot, targetIds, {complete = true} = {}) {
  if (!snapshot) {
    return snapshot
  }

  const allowed = new Set(targetIds)
  const result = {...snapshot}
  for (const key of ['readings', 'needs', 'meterEvents', 'totals', 'readingReferences', 'eventReadingReferences', 'meterEventReferences']) {
    if (Array.isArray(result[key])) {
      result[key] = result[key].filter(item => allowed.has(item.targetId))
    }
  }

  if (!complete) {
    delete result.comment
    delete result.issues
    delete result.sourceId
    delete result.coverageIds
  }

  return result
}

export async function getCampaignAccess(user, campaignId, {client = prisma} = {}) {
  if (!user) {
    throw createError(401, 'Authentification requise.')
  }

  const campaign = await client.campaign.findUnique({where: {id: campaignId}, include: campaignInclude})
  if (!campaign) {
    throw createError(404, 'Campagne introuvable.')
  }

  if (campaign.status === 'DRAFT') {
    const bindings = await client.compteurPointPrelevement.findMany({where: {pointPrelevementId: {in: campaign.targets.map(target => target.pointPrelevementId)}}, include: {compteur: true}})
    for (const target of campaign.targets) {
      target.meters = bindings.filter(binding => binding.pointPrelevementId === target.pointPrelevementId).map(binding => ({...binding, associationId: binding.id}))
    }
  }

  const admin = user.role === 'ADMIN'
  const owner = user.role === 'DECLARANT' && campaign.ownerCollecteurUserId === user.id
  const grant = campaign.managers.find(item => item.userId === user.id)
  const zonePermissions = {}
  for (const permission of ['campaign.read', 'campaign.manage', 'campaign.export']) {
    zonePermissions[permission] = user.role === 'INSTRUCTOR'
      ? new Set(await getPermissionZoneIdsForUser(user, permission, {client}))
      : new Set()
  }

  const canManage = admin || owner || grant?.role === 'MANAGER' || zonePermissions['campaign.manage'].has(campaign.zoneId)
  const targets = campaign.targets.filter(target => admin || Boolean(grant)
    || hasCampaignTargetDelegation(user, target)
    || target.pointPrelevement.zones.some(({zoneId}) => zonePermissions['campaign.read'].has(zoneId)))
    .map(target => ({...target, usageId: target.exploitation.usageId, flowType: target.pointPrelevement.flowType}))
  const exportTargetIds = targets.filter(target => admin || owner || Boolean(grant)
    || target.pointPrelevement.zones.some(({zoneId}) => zonePermissions['campaign.export'].has(zoneId))).map(target => target.id)
  const canExport = exportTargetIds.length > 0
  const canRead = canManage || targets.length > 0 || Boolean(grant)
  if (!canRead || (campaign.status === 'DRAFT' && !canManage)) {
    throw createError(403, 'Vous n’avez pas accès à cette campagne.')
  }

  const responseTargetCounts = new Map()
  for (const target of campaign.targets) {
    responseTargetCounts.set(target.preleveurUserId, (responseTargetCounts.get(target.preleveurUserId) ?? 0) + 1)
  }

  const scopeComplete = targets.length === campaign.targets.length
  return {
    campaign: {...campaign, targets},
    targets,
    permissions: {canRead, canManage, canManageSharing: canManage && scopeComplete, canExport, exportTargetIds, canRemind: canManage, canFollowup: canManage || canExport || user.role === 'INSTRUCTOR'},
    scopeComplete,
    responseTargetCounts
  }
}

export function assertCampaignCapability(access, capability) {
  if (!access.permissions[capability]) {
    throw createError(403, 'Vous ne disposez pas du droit requis pour cette campagne.')
  }
}

export function isCampaignResponseWindowOpen(campaign, response, now = new Date()) {
  const ordinary = campaign.status === 'OPEN' && (!campaign.opensAt || now >= campaign.opensAt) && (!campaign.closesAt || now < campaign.closesAt)
  return ordinary || (campaign.status !== 'DRAFT' && response?.reopenUntil && now < new Date(response.reopenUntil))
}

export function isCampaignTargetWritable(campaign, target) {
  if (!canCollectManually(target.pointPrelevement) || target.pointPrelevement.deletedAt || target.preleveur?.user?.deletedAt) {
    return false
  }

  const dates = [...(campaign.indexDates ?? [])].sort()
  if (dates.length > 0) {
    const start = target.exploitation.startDate ? new Date(target.exploitation.startDate).toISOString().slice(0, 10) : null
    const end = target.exploitation.endDate ? new Date(target.exploitation.endDate).toISOString().slice(0, 10) : null
    if ((start && start > dates[0]) || (end && end < dates.at(-1))) {
      return false
    }
  }

  return !['ABANDONNEE', 'TERMINEE'].includes(target.exploitation.status)
}

export function getCampaignResponseScope(access, user, preleveurUserId, response) {
  const targets = access.targets.filter(target => target.preleveurUserId === preleveurUserId)
  if (targets.length === 0) {
    throw createError(403, 'Ce préleveur ne fait pas partie de votre périmètre de campagne.')
  }

  const editableTargets = targets.filter(target => hasCampaignTargetDelegation(user, target) && isCampaignTargetWritable(access.campaign, target))
  const complete = targets.length === access.responseTargetCounts.get(preleveurUserId)
  const canEdit = editableTargets.length > 0 && Boolean(isCampaignResponseWindowOpen(access.campaign, response))
  return {
    targets,
    editableTargets,
    complete,
    permissions: {
      ...access.permissions,
      editableTargetIds: editableTargets.map(target => target.id),
      canEdit,
      canSubmit: canEdit && editableTargets.length === access.responseTargetCounts.get(preleveurUserId),
      canReopen: false
    }
  }
}

/* eslint-enable no-await-in-loop */
