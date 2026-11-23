import {Prisma} from '@prisma/client'

// Older quick declarations predate the actor and exploitation foreign keys.
// Only the declaration itself may establish their beneficiary. The submitter
// can be a collector and a point can belong to several beneficiaries.
export const manualQuickChunkSql = Prisma.sql`(s.type = 'DECLARATION' AND s.metadata->>'manualQuickDeclaration' = 'true')`
export const quickSeriesOwnerSql = Prisma.sql`COALESCE(c."preleveurUserId", CASE WHEN ${manualQuickChunkSql}
  THEN (SELECT d."declarantUserId" FROM "Declaration" d WHERE d.id = s."declarationId") END)`

// A single possible exploitation must cover the entire period. A partial
// match or a change of operator during that period cannot identify a series.
function uniqueExploitationSql(owner, point, start, end) {
  return Prisma.sql`(SELECT (array_agg(e.id))[1] FROM "DeclarantPointPrelevement" e
    WHERE e."declarantUserId" = ${owner} AND e."pointPrelevementId" = ${point}
      AND (e."startDate" IS NULL OR e."startDate" <= ${end})
      AND (e."endDate" IS NULL OR e."endDate" >= ${start})
    HAVING COUNT(*) = 1 AND bool_and((e."startDate" IS NULL OR e."startDate" <= ${start})
      AND (e."endDate" IS NULL OR e."endDate" >= ${end})))`
}

export const quickSeriesExploitationSql = Prisma.sql`COALESCE(c."exploitationId", CASE WHEN ${manualQuickChunkSql} AND s."declarationId" IS NOT NULL
  THEN ${uniqueExploitationSql(quickSeriesOwnerSql, Prisma.sql`c."pointPrelevementId"`, Prisma.sql`c."minDate"`, Prisma.sql`c."maxDate"`)} END)`

export async function resolveHistoricalQuickExploitation(tx, {pointPrelevementId, declarantUserId, periodStartDate, periodEndDate}) {
  const [row] = await tx.$queryRaw`SELECT ${uniqueExploitationSql(Prisma.sql`${declarantUserId}::uuid`, Prisma.sql`${pointPrelevementId}::uuid`,
    Prisma.sql`${periodStartDate}::date`, Prisma.sql`${periodEndDate}::date`)} AS id`
  return row.id
}
