import {Prisma} from '@prisma/client'

import {meterBusinessDateBoundary} from './meter-core.js'

export const FEED_KINDS = ['MANUAL', 'SPREADSHEET', 'TELEMETRY', 'NONE']

function normalizeSearch(value) {
  return (value ?? '').normalize('NFD').replaceAll(/\p{Diacritic}/gu, '').toLowerCase().trim()
}

export function normalizeFeedCode(value) {
  return normalizeSearch(value).replaceAll(/[^a-z\d]/g, '')
}

// Resolve identities, not history rows. Every subsequent query still intersects
// these matches with the existing declaration/chunk access predicates.
export async function findFeedDeclarantMatches(name, client) {
  const terms = normalizeSearch(name).split(/\s+/).filter(Boolean)
  return Promise.all(terms.map(async term => {
    const rows = await client.$queryRaw(Prisma.sql`
      SELECT d."userId" AS id FROM "Declarant" d
      JOIN "User" u ON u.id = d."userId"
      WHERE strpos(lower(public.unaccent(concat_ws(' ', d."socialReason", u."firstName", u."lastName", u.email))), ${term}) > 0
    `)
    return rows.map(row => row.id)
  }))
}

function declarationPeriodWhere({dateFrom, dateTo}) {
  if (!dateFrom && !dateTo) return null
  const bounds = [
    ...(dateFrom ? [{maxDate: {gte: new Date(dateFrom)}}] : []),
    ...(dateTo ? [{minDate: {lte: new Date(dateTo)}}] : [])
  ]
  const createdAt = {
    ...(dateFrom ? {gte: new Date(`${dateFrom}T00:00:00.000Z`)} : {}),
    ...(dateTo ? {lte: new Date(`${dateTo}T23:59:59.999Z`)} : {})
  }
  // Separate bounds preserve the list's source-wide period when chunks have gaps.
  return {OR: [
    {source: {is: {AND: bounds.map(bound => ({chunks: {some: bound}}))}}},
    {AND: [
      {OR: [{source: null}, {source: {is: {chunks: {none: {}}}}}]},
      {createdAt}
    ]}
  ]}
}

export function buildFeedDeclarationFilters({kinds, declarationCode, dateFrom, dateTo, pointsToAssociateOnly}, declarantMatches) {
  const filters = []
  if (kinds !== undefined) {
    const types = kinds.filter(kind => kind !== 'NONE').map(kind => kind === 'TELEMETRY' ? 'API' : kind)
    filters.push({OR: [
      ...(types.length ? [{dataSourceType: {in: types}}] : []),
      ...(kinds.includes('NONE') ? [{dataSourceType: 'NONE'}, {dataSourceType: null}] : [])
    ]})
  }
  if (declarationCode) filters.push({code: {contains: normalizeFeedCode(declarationCode), mode: 'insensitive'}})
  for (const ids of declarantMatches) {
    filters.push({OR: [{declarantUserId: {in: ids}}, {createdByDeclarantUserId: {in: ids}}]})
  }
  const period = declarationPeriodWhere({dateFrom, dateTo})
  if (period) filters.push(period)
  if (pointsToAssociateOnly) filters.push({
    dataSourceType: 'SPREADSHEET',
    processingStatus: 'COMPLETED',
    source: {is: {
      status: 'COMPLETED',
      globalInstructionStatus: {in: ['TO_INSTRUCT', 'INSTRUCTION_IN_PROGRESS', 'PARTIALLY_VALIDATED']},
      chunks: {some: {pointPrelevementId: null}}
    }}
  })
  return filters
}

function uuidList(ids) {
  return ids.length ? Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`)) : Prisma.sql`NULL::uuid`
}

// SQL counterpart of getMeterChunkAccessWhere, used only for a filtered page of
// IDs. The hydrated page re-applies the canonical Prisma access predicate.
function meterChunkAccessSql(user) {
  if (user?.role === 'ADMIN') return Prisma.sql`TRUE`
  if (!user?.id || (user.role && user.role !== 'DECLARANT')) return Prisma.sql`FALSE`
  const own = Prisma.sql`c."preleveurUserId" = ${user.id}::uuid`
  if (user.declarant?.declarantRole !== 'COLLECTEUR') return own
  return Prisma.sql`(${own} OR EXISTS (
    SELECT 1 FROM "ChunkValue" cv
    JOIN "MeterVolumeContribution" mvc ON mvc."chunkValueId" = cv.id
    JOIN "MeterAllocationVersion" mav ON mav.id = mvc."allocationVersionId"
    JOIN "MeterAllocation" ma ON ma.id = mav."allocationId"
    JOIN "DeclarantCollecteurExploitation" dce ON dce."exploitationId" = ma."exploitationId"
    WHERE cv."chunkId" = c.id AND dce."collecteurUserId" = ${user.id}::uuid
  ))`
}

function visibleChunkSql(user) {
  return Prisma.sql`(c."calculationStrategy" <> 'METER' OR ${meterChunkAccessSql(user)})`
}

function chunkPeriodSql({dateFrom, dateTo}, user) {
  const predicates = []
  for (const [date, lower] of [[dateFrom, true], [dateTo, false]]) {
    if (!date) continue
    const ordinary = lower
      ? Prisma.sql`c."maxDate" >= ${new Date(date)}`
      : Prisma.sql`c."minDate" <= ${new Date(date)}`
    const exact = lower
      ? Prisma.sql`cv."periodEnd" > ${meterBusinessDateBoundary(date)}`
      : Prisma.sql`cv."periodStart" < ${meterBusinessDateBoundary(date, true)}`
    predicates.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "Chunk" c WHERE c."sourceId" = s.id AND ${visibleChunkSql(user)}
      AND ((c."calculationStrategy" <> 'METER' AND ${ordinary})
        OR (c."calculationStrategy" = 'METER' AND c."instructionStatus" <> 'REJECTED'
          AND EXISTS (SELECT 1 FROM "ChunkValue" cv WHERE cv."chunkId" = c.id AND ${exact})))
    )`)
  }
  return predicates
}

// Filter and authorize BEFORE LIMIT. A number search includes the displayed
// six-digit telemetry code derived from the UUID, without materializing all
// matching IDs or loading all pages in either the API or the browser.
export async function findFilteredTelemetryIds({user, declarantUserIds, filters, declarantMatches, cursor, take, client}) {
  const predicates = [Prisma.sql`s.type = 'API'`, Prisma.sql`EXISTS (
    SELECT 1 FROM "Chunk" c WHERE c."sourceId" = s.id AND (
      (c."calculationStrategy" <> 'METER' AND EXISTS (
        SELECT 1 FROM "DeclarantPointPrelevement" dpp
        WHERE dpp."pointPrelevementId" = c."pointPrelevementId"
          AND dpp."declarantUserId" IN (${uuidList(declarantUserIds)})
      ))
      OR (c."calculationStrategy" = 'METER' AND ${meterChunkAccessSql(user)})
    )
  )`]
  if (filters.declarationCode) {
    const code = normalizeFeedCode(filters.declarationCode)
    predicates.push(Prisma.sql`(
      (length(regexp_replace(s.id::text, '[^0-9]', '', 'g')) >= 6
        AND strpos(substring(regexp_replace(s.id::text, '[^0-9]', '', 'g') FROM 1 FOR 6), ${code}) > 0)
      OR EXISTS (SELECT 1 FROM "Declaration" d WHERE d.id = s."declarationId" AND strpos(lower(d.code), ${code}) > 0)
    )`)
  }
  for (const ids of declarantMatches) {
    predicates.push(Prisma.sql`(
      EXISTS (SELECT 1 FROM "Declaration" d WHERE d.id = s."declarationId"
        AND (d."declarantUserId" IN (${uuidList(ids)}) OR d."createdByDeclarantUserId" IN (${uuidList(ids)})))
      OR EXISTS (SELECT 1 FROM "Chunk" c WHERE c."sourceId" = s.id AND ${visibleChunkSql(user)} AND (
        (c."calculationStrategy" = 'METER' AND c."preleveurUserId" IN (${uuidList(ids)}))
        OR (c."calculationStrategy" <> 'METER' AND EXISTS (
          SELECT 1 FROM "DeclarantPointPrelevement" dpp
          WHERE dpp."pointPrelevementId" = c."pointPrelevementId"
            AND dpp."declarantUserId" IN (${uuidList(declarantUserIds)})
            AND dpp."declarantUserId" IN (${uuidList(ids)})
        ))
      ))
    )`)
  }
  predicates.push(...chunkPeriodSql(filters, user))
  if (cursor) {
    predicates.push(cursor.type === 'DECLARATION'
      ? Prisma.sql`s."createdAt" <= ${cursor.createdAt}`
      : Prisma.sql`(s."createdAt" < ${cursor.createdAt} OR (s."createdAt" = ${cursor.createdAt} AND s.id < ${cursor.id}::uuid))`)
  }
  const rows = await client.$queryRaw(Prisma.sql`
    SELECT s.id FROM "Source" s WHERE ${Prisma.join(predicates, ' AND ')}
    ORDER BY s."createdAt" DESC, s.id DESC LIMIT ${take}
  `)
  return rows.map(row => row.id)
}
