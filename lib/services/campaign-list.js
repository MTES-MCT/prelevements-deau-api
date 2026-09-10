import createError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {activeInstructorZoneWhere} from './zone-permissions.js'
import {getCampaignScopePermissions} from './campaign-permissions.js'
import {loadCampaignListProgress} from './campaign-progress.js'

const codes = ['campaign.read', 'campaign.manage', 'campaign.export']
const day = value => value ? new Date(value).toISOString().slice(0, 10) : null

async function listAuthority(user, client) {
  if (!user) {
    throw createError(401, 'Authentification requise.')
  }

  const zonePermissions = Object.fromEntries(codes.map(code => [code, new Set()]))
  if (user.role === 'INSTRUCTOR') {
    const assignments = await client.instructorZone.findMany({
      where: {...activeInstructorZoneWhere(user.id), permissions: {some: {permission: {in: codes}}}},
      select: {zoneId: true, permissions: {where: {permission: {in: codes}}, select: {permission: true}}}
    })
    for (const assignment of assignments) {
      for (const {permission} of assignment.permissions) {
        zonePermissions[permission]?.add(assignment.zoneId)
      }
    }
  }

  const declarant = user.role === 'DECLARANT'
    ? await client.declarant.findUnique({where: {userId: user.id}, select: {declarantRole: true}})
    : null
  return {zonePermissions, canCreate: user.role === 'ADMIN' || declarant?.declarantRole === 'COLLECTEUR' || zonePermissions['campaign.manage'].size > 0}
}

function visibleTargetsWhere(user, zonePermissions) {
  if (user.role === 'ADMIN') {
    return {}
  }

  return {OR: [
    {campaign: {managers: {some: {userId: user.id}}}},
    ...(user.role === 'DECLARANT'
      ? [{preleveurUserId: user.id}, {exploitation: {collecteurs: {some: {collecteurUserId: user.id}}}}]
      : []),
    ...(zonePermissions['campaign.read'].size > 0
      ? [{pointPrelevement: {zones: {some: {zoneId: {in: [...zonePermissions['campaign.read']]}}}}}]
      : [])
  ]}
}

function campaignsWhere(user, zonePermissions, targetWhere) {
  if (user.role === 'ADMIN') {
    return {}
  }

  // Filtrer les brouillons non gérables AVANT la limite : ils ne doivent ni
  // prendre une place dans la page, ni faire échouer les campagnes accessibles.
  return {OR: [
    ...(user.role === 'DECLARANT' ? [{ownerCollecteurUserId: user.id}] : []),
    {managers: {some: {userId: user.id, role: 'MANAGER'}}},
    ...(zonePermissions['campaign.manage'].size > 0 ? [{zoneId: {in: [...zonePermissions['campaign.manage']]}}] : []),
    {status: {in: ['OPEN', 'CLOSED']}, OR: [
      {managers: {some: {userId: user.id}}},
      {targets: {some: targetWhere}}
    ]}
  ]}
}

function listSelect(user, targetWhere, zonePermissions) {
  return {
    id: true, name: true, year: true, version: true, status: true,
    ownerCollecteurUserId: true, zoneId: true, indexDates: true,
    opensAt: true, closesAt: true, openedAt: true, closedAt: true, timezone: true, reminderDays: true,
    createdAt: true, updatedAt: true,
    ownerCollecteur: {select: {socialReason: true, user: {select: {firstName: true, lastName: true}}}},
    zone: {select: {id: true, name: true, type: true, code: true}},
    periods: {orderBy: [{kind: 'asc'}, {position: 'asc'}], select: {
      id: true, kind: true, position: true, label: true, startDate: true, endDate: true, startReadingDate: true, endReadingDate: true
    }},
    managers: {where: {userId: user.id}, select: {userId: true, role: true}},
    _count: {select: {targets: true}},
    targets: {where: targetWhere, select: {
      id: true, pointPrelevementId: true, preleveurUserId: true,
      pointPrelevement: {select: {zones: {where: {zoneId: {in: [...zonePermissions['campaign.export']]}}, select: {zoneId: true}}}}
    }}
  }
}

function listItem(access, progress) {
  const {targets, managers: _managers, _count, ownerCollecteur, ...campaign} = access.campaign
  const {exportTargetIds: _exportTargetIds, ...permissions} = access.permissions
  return {
    campaign: {...campaign,
      owner: {userId: campaign.ownerCollecteurUserId, label: ownerCollecteur?.socialReason || [ownerCollecteur?.user?.firstName, ownerCollecteur?.user?.lastName].filter(Boolean).join(' ')},
      periods: campaign.periods.map(period => ({...period,
        startDate: day(period.startDate), endDate: day(period.endDate), startReadingDate: day(period.startReadingDate), endReadingDate: day(period.endReadingDate)}))},
    permissions,
    counts: {pointCount: new Set(targets.map(target => target.pointPrelevementId)).size, preleveurCount: new Set(targets.map(target => target.preleveurUserId)).size},
    progress
  }
}

export async function loadCampaignList(user, {client = prisma} = {}) {
  const {zonePermissions, canCreate} = await listAuthority(user, client)
  const targetWhere = visibleTargetsWhere(user, zonePermissions)
  const campaigns = await client.campaign.findMany({
    where: campaignsWhere(user, zonePermissions, targetWhere), select: listSelect(user, targetWhere, zonePermissions),
    orderBy: [{year: 'desc'}, {createdAt: 'desc'}, {id: 'asc'}], take: 200
  })
  const accesses = campaigns.map(campaign => ({campaign, targets: campaign.targets,
    ...getCampaignScopePermissions(user, campaign, campaign.targets, {zonePermissions, totalTargetCount: campaign._count.targets})}))
    .filter(access => access.permissions.canRead && (access.campaign.status !== 'DRAFT' || access.permissions.canManage))
  const progress = await loadCampaignListProgress(accesses, {client})
  return {items: accesses.map(access => listItem(access, progress.get(access.campaign.id) ?? null)), permissions: {canCreate}}
}
