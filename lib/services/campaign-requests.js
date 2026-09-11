import {Buffer} from 'node:buffer'
import {Prisma} from '@prisma/client'
import Joi from 'joi'
import createError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {getCampaignResponseScope, hasCampaignTargetDelegation} from './campaign-permissions.js'

const uuid = Joi.string().guid({version: ['uuidv4', 'uuidv5', 'uuidv7']}).required()
const cursorSchema = Joi.object({
  priority: Joi.number().integer().valid(0, 1).required(),
  year: Joi.number().integer().min(2000).max(2200).required(),
  createdAt: Joi.string().isoDate().required(),
  campaignId: uuid,
  preleveurUserId: uuid
})
export const campaignRequestsQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(20),
  actionableOnly: Joi.boolean().default(false),
  cursor: Joi.when('actionableOnly', {is: true, then: Joi.forbidden(), otherwise: Joi.string().pattern(/^[\w-]+$/).max(768)})
})

const iso = value => value ? new Date(value).toISOString() : null
const label = declarant => declarant?.socialReason || [declarant?.user?.firstName, declarant?.user?.lastName].filter(Boolean).join(' ')
const pairKey = pair => `${pair.campaignId}:${pair.preleveurUserId}`

function decodeCursor(cursor) {
  if (!cursor) {
    return null
  }

  try {
    const {value, error} = cursorSchema.validate(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
    if (error) {
      throw error
    }

    return value
  } catch {
    throw createError(400, 'La page demandée est invalide. Rechargez vos demandes.')
  }
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({
    priority: row.priority,
    year: row.year,
    createdAt: iso(row.createdAt),
    campaignId: row.campaignId,
    preleveurUserId: row.preleveurUserId
  })).toString('base64url')
}

// Le tableau de bord doit chercher dans toutes les demandes, pas filtrer une page
// déjà limitée. Les seules lignes hydratées ensuite sont les couples retenus.
async function actionableRequestRows(client, user, isCollecteur, limit) {
  const now = new Date()
  return client.$queryRaw`
    WITH requests AS (
      SELECT campaign.id AS "campaignId", target."preleveurUserId",
        campaign.year, campaign."createdAt", 0 AS priority,
        MIN(CASE
          WHEN campaign.status = 'OPEN'
            AND (campaign."opensAt" IS NULL OR campaign."opensAt" <= ${now})
            AND (campaign."closesAt" IS NULL OR campaign."closesAt" > ${now})
          THEN CASE WHEN campaign."closesAt" IS NULL THEN NULL
            ELSE GREATEST(campaign."closesAt", response."reopenUntil") END
          ELSE response."reopenUntil"
        END) AS "deadlineAt"
      FROM "CampaignTarget" target
      JOIN "Campaign" campaign ON campaign.id = target."campaignId"
      JOIN "PointPrelevement" point ON point.id = target."pointPrelevementId"
      JOIN "DeclarantPointPrelevement" exploitation ON exploitation.id = target."exploitationId"
      JOIN "User" preleveur ON preleveur.id = target."preleveurUserId"
      LEFT JOIN "CampaignResponse" indexes ON indexes."campaignId" = campaign.id
        AND indexes."preleveurUserId" = target."preleveurUserId" AND indexes.kind = 'INDEX'
      LEFT JOIN "CampaignResponse" needs ON needs."campaignId" = campaign.id
        AND needs."preleveurUserId" = target."preleveurUserId" AND needs.kind = 'NEEDS'
      CROSS JOIN LATERAL (VALUES (indexes.status, indexes."reopenUntil"), (needs.status, needs."reopenUntil"))
        response(status, "reopenUntil")
      CROSS JOIN LATERAL (
        SELECT MIN(day) AS first, MAX(day) AS last
        FROM jsonb_array_elements_text(campaign."indexDates") AS dates(day)
      ) dates
      WHERE campaign.status IN ('OPEN', 'CLOSED')
        AND (target."preleveurUserId" = ${user.id}::uuid
          OR (${isCollecteur} AND EXISTS (
            SELECT 1 FROM "DeclarantCollecteurExploitation" delegation
            WHERE delegation."exploitationId" = target."exploitationId"
              AND delegation."collecteurUserId" = ${user.id}::uuid
          )))
        AND point."deletedAt" IS NULL AND preleveur."deletedAt" IS NULL
        AND point."collectionMode" IS DISTINCT FROM 'EXTERNAL'
        AND exploitation.status NOT IN ('ABANDONNEE', 'TERMINEE')
        AND (exploitation."startDate" IS NULL OR dates.first IS NULL OR exploitation."startDate"::text <= dates.first)
        AND (exploitation."endDate" IS NULL OR dates.last IS NULL OR exploitation."endDate"::text >= dates.last)
        AND response.status IS DISTINCT FROM 'SUBMITTED'
        AND ((campaign.status = 'OPEN'
            AND (campaign."opensAt" IS NULL OR campaign."opensAt" <= ${now})
            AND (campaign."closesAt" IS NULL OR campaign."closesAt" > ${now}))
          OR response."reopenUntil" > ${now})
      GROUP BY campaign.id, target."preleveurUserId", campaign.year, campaign."createdAt"
    )
    SELECT *, COUNT(*) OVER()::integer AS total FROM requests
    ORDER BY "deadlineAt" ASC NULLS LAST, year DESC, "createdAt" DESC, "campaignId" ASC, "preleveurUserId" ASC
    LIMIT ${limit}
  `
}

/** Lecture du suivi personnel, sans charger les réponses ni calculer les volumes. */
export async function listCampaignRequests(user, {limit = 20, cursor, actionableOnly = false, client = prisma} = {}) {
  if (!user) {
    throw createError(401, 'Authentification requise.')
  }

  if (user.role !== 'DECLARANT') {
    throw createError(403, 'Ces demandes sont réservées aux déclarants concernés.')
  }

  const query = campaignRequestsQuerySchema.validate({limit, cursor, actionableOnly})
  if (query.error) {
    throw createError(400, 'La page demandée est invalide.')
  }

  const after = decodeCursor(query.value.cursor)
  const actor = await client.declarant.findUnique({where: {userId: user.id}, select: {declarantRole: true, user: {select: {deletedAt: true}}}})
  if (!actor || actor.user?.deletedAt) {
    throw createError(403, 'Ce compte ne peut pas consulter les demandes.')
  }

  const isCollecteur = actor.declarantRole === 'COLLECTEUR'
  const delegatedTarget = {
    OR: [
      {preleveurUserId: user.id},
      ...(isCollecteur ? [{exploitation: {collecteurs: {some: {collecteurUserId: user.id}}}}] : [])
    ]
  }
  // La pagination porte sur les couples campagne/préleveur, pas sur les points.
  // Ni le rôle de propriétaire ni un partage de suivi ne constituent un mandat.
  const page = query.value.actionableOnly
    ? await actionableRequestRows(client, user, isCollecteur, query.value.limit)
    : await client.$queryRaw`
    WITH requests AS (
      SELECT DISTINCT campaign.id AS "campaignId", target."preleveurUserId",
        campaign.year, campaign."createdAt",
        CASE WHEN campaign.status = 'OPEN' THEN 0 ELSE 1 END AS priority
      FROM "CampaignTarget" target
      JOIN "Campaign" campaign ON campaign.id = target."campaignId"
      WHERE campaign.status IN ('OPEN', 'CLOSED')
        AND (target."preleveurUserId" = ${user.id}::uuid
          OR (${isCollecteur} AND EXISTS (
            SELECT 1 FROM "DeclarantCollecteurExploitation" delegation
            WHERE delegation."exploitationId" = target."exploitationId"
              AND delegation."collecteurUserId" = ${user.id}::uuid
          )))
    )
    SELECT * FROM requests
    WHERE ${after
      ? Prisma.sql`
        (priority, -year, -EXTRACT(EPOCH FROM "createdAt"), "campaignId", "preleveurUserId")
        > (${after.priority}, ${-after.year}, -EXTRACT(EPOCH FROM ${after.createdAt}::timestamptz), ${after.campaignId}::uuid, ${after.preleveurUserId}::uuid)
      `
      : Prisma.sql`TRUE`}
    ORDER BY priority ASC, year DESC, "createdAt" DESC, "campaignId" ASC, "preleveurUserId" ASC
    LIMIT ${query.value.limit + 1}
  `
  const rows = page.slice(0, query.value.limit)
  const total = query.value.actionableOnly ? Number(page[0]?.total ?? 0) : undefined
  const pagination = {
    limit: query.value.limit,
    hasMore: query.value.actionableOnly ? total > rows.length : page.length > query.value.limit,
    nextCursor: !query.value.actionableOnly && page.length > query.value.limit ? encodeCursor(rows.at(-1)) : null
  }
  if (rows.length === 0) {
    return {items: [], pagination, ...(query.value.actionableOnly ? {total} : {})}
  }

  const pairs = rows.map(({campaignId, preleveurUserId}) => ({campaignId, preleveurUserId}))
  const [campaigns, responses, targetCounts] = await Promise.all([
    client.campaign.findMany({where: {id: {in: [...new Set(rows.map(row => row.campaignId))]}, status: {in: ['OPEN', 'CLOSED']}}, select: {
      id: true, name: true, year: true, status: true, ownerCollecteurUserId: true, opensAt: true, closesAt: true, timezone: true, indexDates: true,
      ownerCollecteur: {select: {socialReason: true, user: {select: {firstName: true, lastName: true}}}},
      targets: {where: {AND: [delegatedTarget, {OR: pairs}]}, select: {
        id: true, preleveurUserId: true,
        pointPrelevement: {select: {collectionMode: true, deletedAt: true}},
        exploitation: {select: {status: true, startDate: true, endDate: true, collecteurs: {where: {collecteurUserId: user.id}, select: {collecteurUserId: true}}}},
        preleveur: {select: {socialReason: true, user: {select: {firstName: true, lastName: true, deletedAt: true}}}}
      }}
    }}),
    client.campaignResponse.findMany({where: {OR: pairs}, select: {
      campaignId: true, preleveurUserId: true, kind: true, status: true, reopenUntil: true,
      latestSubmission: {select: {submittedAt: true}}
    }}),
    client.campaignTarget.groupBy({by: ['campaignId', 'preleveurUserId'], where: {OR: pairs}, _count: {_all: true}})
  ])
  const campaignMap = new Map(campaigns.map(campaign => [campaign.id, campaign]))
  const responseMap = new Map(responses.map(response => [`${pairKey(response)}:${response.kind}`, response]))
  const countMap = new Map(targetCounts.map(count => [pairKey(count), count._count._all]))
  const items = []
  for (const row of rows) {
    const campaign = campaignMap.get(row.campaignId)
    if (!campaign || !['OPEN', 'CLOSED'].includes(campaign.status)) {
      continue
    }

    const targets = campaign.targets.filter(target => target.preleveurUserId === row.preleveurUserId
      && (target.preleveurUserId === user.id || (isCollecteur && hasCampaignTargetDelegation(user, target))))
    if (targets.length === 0) {
      continue
    }

    const access = {
      campaign, targets, permissions: {canManage: false},
      responseTargetCounts: new Map([[row.preleveurUserId, countMap.get(pairKey(row))]])
    }
    const summaries = Object.fromEntries(['INDEX', 'NEEDS'].map(kind => {
      const response = responseMap.get(`${pairKey(row)}:${kind}`)
      const {permissions} = getCampaignResponseScope(access, user, row.preleveurUserId, response)
      return [kind, {
        status: response?.status ?? null,
        latestSubmissionAt: iso(response?.latestSubmission?.submittedAt),
        reopenUntil: iso(response?.reopenUntil),
        canEdit: permissions.canEdit,
        canSubmit: permissions.canSubmit
      }]
    }))
    // Les droits sont revérifiés avec les règles partagées, notamment si un
    // mandat ou une réponse a changé entre la sélection SQL et cette lecture.
    if (query.value.actionableOnly && !Object.values(summaries).some(response => response.canEdit && response.status !== 'SUBMITTED')) {
      continue
    }

    items.push({
      campaign: {
        id: campaign.id, name: campaign.name, year: campaign.year, status: campaign.status,
        owner: {userId: campaign.ownerCollecteurUserId, label: label(campaign.ownerCollecteur)},
        opensAt: iso(campaign.opensAt), closesAt: iso(campaign.closesAt), timezone: campaign.timezone
      },
      preleveur: {userId: row.preleveurUserId, label: label(targets[0].preleveur)},
      pointCount: targets.length,
      ...(query.value.actionableOnly ? {deadlineAt: iso(row.deadlineAt)} : {}),
      responses: summaries
    })
  }

  return {items, pagination, ...(query.value.actionableOnly ? {total} : {})}
}
