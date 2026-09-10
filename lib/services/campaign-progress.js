import {prisma} from '../../db/prisma.js'

const kinds = ['INDEX', 'NEEDS']

export function campaignProgressSummary(access, counts = []) {
  const preleveurCount = new Set(access.targets.map(target => target.preleveurUserId)).size
  const byKind = Object.fromEntries(kinds.map(kind => [kind, {expectedCount: preleveurCount, receivedCount: 0, correctionCount: 0}]))
  for (const count of counts) {
    const summary = byKind[count.kind]
    if (summary) {
      summary.receivedCount += count.receivedCount
      summary.correctionCount += count.correctionCount
    }
  }

  return {
    preleveurCount,
    expectedCount: preleveurCount * kinds.length,
    receivedCount: kinds.reduce((total, kind) => total + byKind[kind].receivedCount, 0),
    correctionCount: kinds.reduce((total, kind) => total + byKind[kind].correctionCount, 0),
    scopeComplete: access.scopeComplete,
    byKind
  }
}

// Réutilise les accès déjà résolus par la liste. Une seule agrégation renvoie
// au plus deux lignes par campagne, jamais les brouillons ni les publications.
export async function loadCampaignListProgress(accesses, {client = prisma} = {}) {
  const eligible = accesses.filter(access => access.permissions.canFollowup && ['OPEN', 'CLOSED'].includes(access.campaign.status))
  const progress = new Map(eligible.map(access => [access.campaign.id, campaignProgressSummary(access)]))
  const scopes = eligible.map(access => ({campaignId: access.campaign.id, preleveurUserIds: [...new Set(access.targets.map(target => target.preleveurUserId))]}))
    .filter(scope => scope.preleveurUserIds.length > 0)
  if (scopes.length === 0) {
    return progress
  }

  // Le JSON est un paramètre SQL, pas du SQL interpolé. Il évite un paramètre
  // par identifiant et conserve les couples exacts campagne / préleveur.
  const counts = await client.$queryRaw`
    WITH scope AS (
      SELECT campaigns."campaignId", people."userId"::uuid AS "preleveurUserId"
      FROM jsonb_to_recordset(${JSON.stringify(scopes)}::jsonb)
        AS campaigns("campaignId" uuid, "preleveurUserIds" jsonb)
      CROSS JOIN LATERAL jsonb_array_elements_text(campaigns."preleveurUserIds") AS people("userId")
    )
    SELECT response."campaignId", response.kind::text AS kind,
      COUNT(*)::integer AS "receivedCount",
      COUNT(*) FILTER (WHERE response.status = 'DRAFT')::integer AS "correctionCount"
    FROM "CampaignResponse" response
    INNER JOIN scope ON scope."campaignId" = response."campaignId"
      AND scope."preleveurUserId" = response."preleveurUserId"
    WHERE response."latestSubmissionId" IS NOT NULL AND response.kind IN ('INDEX', 'NEEDS')
    GROUP BY response."campaignId", response.kind
  `
  const byCampaign = new Map()
  for (const count of counts) {
    const rows = byCampaign.get(count.campaignId) ?? []
    rows.push(count)
    byCampaign.set(count.campaignId, rows)
  }

  for (const access of eligible) {
    progress.set(access.campaign.id, campaignProgressSummary(access, byCampaign.get(access.campaign.id)))
  }

  return progress
}
