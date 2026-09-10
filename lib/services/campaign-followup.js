import createError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {getCampaignAccess, assertCampaignCapability, getCampaignResponseScope, filterCampaignSnapshot} from './campaign-permissions.js'
import {publicTarget} from './campaigns.js'
import {campaignProgressSummary} from './campaign-progress.js'
import {campaignFollowupOverviewQuerySchema, campaignFollowupResultsQuerySchema, validateCampaignValue} from '../validation/campaigns.js'

const kinds = ['INDEX', 'NEEDS']
const metadataSelect = {
  preleveurUserId: true,
  kind: true,
  status: true,
  latestSubmissionId: true,
  latestSubmission: {select: {submittedAt: true}}
}
const iso = value => value ? new Date(value).toISOString() : null
const personLabel = preleveur => preleveur.socialReason || [preleveur.user.firstName, preleveur.user.lastName].filter(Boolean).join(' ')
const searchText = value => String(value ?? '').normalize('NFD').replaceAll(/\p{M}/gu, '').toLocaleLowerCase('fr-FR')

async function followupAccess(user, campaignId, client) {
  const access = await getCampaignAccess(user, campaignId, {client})
  assertCampaignCapability(access, 'canFollowup')
  return access
}

// Le périmètre est résolu avant la lecture. Les campagnes sont limitées à
// 5 000 points : au plus deux petites lignes de métadonnées par préleveur,
// sans charger les brouillons, les index ou les publications pour le suivi.
async function loadMetadata(access, client) {
  const preleveurUserIds = [...new Set(access.targets.map(target => target.preleveurUserId))]
  if (preleveurUserIds.length === 0) {
    return []
  }

  return client.campaignResponse.findMany({
    where: {campaignId: access.campaign.id, preleveurUserId: {in: preleveurUserIds}},
    select: metadataSelect
  })
}

function responseMetadata(response) {
  const received = Boolean(response?.latestSubmissionId)
  return {
    status: response?.status ?? null,
    received,
    correctionPending: received && response.status === 'DRAFT',
    latestSubmissionAt: iso(response?.latestSubmission?.submittedAt)
  }
}

export async function getCampaignResponseSummary(user, campaignId, {client = prisma} = {}) {
  const access = await followupAccess(user, campaignId, client)
  const rows = await loadMetadata(access, client)
  return campaignProgressSummary(access, rows.map(row => {
    const metadata = responseMetadata(row)
    return {kind: row.kind, receivedCount: Number(metadata.received), correctionCount: Number(metadata.correctionPending)}
  }))
}

function overviewItems(targets, rows, query) {
  const responseMap = new Map(rows.map(row => [`${row.preleveurUserId}:${row.kind}`, responseMetadata(row)]))
  const people = new Map()
  for (const target of targets) {
    const userId = target.preleveurUserId
    if (!people.has(userId)) {
      people.set(userId, {
        preleveur: {userId, label: personLabel(target.preleveur)},
        pointCount: 0,
        pointNames: [],
        responses: Object.fromEntries(kinds.map(kind => [kind, responseMap.get(`${userId}:${kind}`) ?? responseMetadata(null)]))
      })
    }

    const person = people.get(userId)
    person.pointCount++
    person.pointNames.push(target.pointPrelevement.name, target.pointPrelevement.usageName)
  }

  const search = searchText(query.q)
  return [...people.values()].filter(person => {
    if (search && !searchText([person.preleveur.label, ...person.pointNames].join(' ')).includes(search)) {
      return false
    }

    const responses = Object.values(person.responses)
    return query.status === 'all'
      || (query.status === 'missing' && responses.some(response => !response.received))
      || (query.status === 'received' && responses.every(response => response.received))
      || (query.status === 'correction' && responses.some(response => response.correctionPending))
  }).sort((a, b) => a.preleveur.label.localeCompare(b.preleveur.label, 'fr') || a.preleveur.userId.localeCompare(b.preleveur.userId))
    .map(({pointNames: _pointNames, ...person}) => person)
}

export async function listCampaignResponseOverview(user, campaignId, {client = prisma, ...input} = {}) {
  const query = validateCampaignValue(campaignFollowupOverviewQuerySchema, input)
  const access = await followupAccess(user, campaignId, client)
  const rows = await loadMetadata(access, client)
  const matching = overviewItems(access.targets, rows, query)
  const cursorIndex = query.cursor ? matching.findIndex(item => item.preleveur.userId === query.cursor) : -1
  if (query.cursor && cursorIndex < 0) {
    throw createError(400, 'Le curseur ne correspond plus à ce suivi. Rechargez la liste des résultats.')
  }

  const items = matching.slice(cursorIndex + 1, cursorIndex + 1 + query.limit)
  const hasMore = cursorIndex + 1 + items.length < matching.length
  return {
    items,
    pagination: {totalCount: matching.length, limit: query.limit, hasMore, nextCursor: hasMore ? items.at(-1).preleveur.userId : null}
  }
}

export async function getCampaignResponseResults(user, campaignId, {client = prisma, ...input} = {}) {
  const {preleveurUserId} = validateCampaignValue(campaignFollowupResultsQuerySchema, input)
  const access = await followupAccess(user, campaignId, client)
  const scope = getCampaignResponseScope(access, user, preleveurUserId)
  const targetIds = scope.targets.map(target => target.id)
  const rows = await client.campaignResponse.findMany({
    where: {campaignId, preleveurUserId},
    select: {
      id: true, kind: true, status: true,
      latestSubmission: {select: {submittedAt: true, snapshot: true, publication: true}}
    }
  })
  const responses = Object.fromEntries(kinds.map(kind => {
    const row = rows.find(response => response.kind === kind)
    if (!row) {
      return [kind, null]
    }

    const latestSubmission = row.latestSubmission
      ? {
        submittedAt: iso(row.latestSubmission.submittedAt),
        snapshot: filterCampaignSnapshot(row.latestSubmission.snapshot, targetIds, scope),
        publication: filterCampaignSnapshot(row.latestSubmission.publication, targetIds, scope)
      }
      : null
    return [kind, {
      id: row.id,
      kind: row.kind,
      status: row.status,
      latestSubmission
    }]
  }))
  return {targets: scope.targets.map(target => publicTarget(target)), responses}
}
