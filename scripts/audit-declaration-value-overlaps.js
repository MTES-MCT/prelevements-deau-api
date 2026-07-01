import '../lib/config/env.js'

import {Prisma} from '@prisma/client'

import {prisma} from '../db/prisma.js'

const VALID_INSTRUCTION_STATUSES = [
  'PENDING',
  'VALIDATED',
  'AUTOMATICALLY_VALIDATED'
]

function toNumber(value) {
  if (value === null || value === undefined) {
    return null
  }

  if (typeof value === 'object' && typeof value.toNumber === 'function') {
    return value.toNumber()
  }

  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function serializeOverlapRow(row) {
  return {
    pointPrelevementId: row.pointPrelevementId,
    metricTypeCode: row.metricTypeCode,
    first: {
      chunkValueId: row.firstChunkValueId,
      chunkId: row.firstChunkId,
      sourceId: row.firstSourceId,
      declarationId: row.firstDeclarationId,
      periodStart: row.firstPeriodStart,
      periodEnd: row.firstPeriodEnd,
      value: toNumber(row.firstValue)
    },
    second: {
      chunkValueId: row.secondChunkValueId,
      chunkId: row.secondChunkId,
      sourceId: row.secondSourceId,
      declarationId: row.secondDeclarationId,
      periodStart: row.secondPeriodStart,
      periodEnd: row.secondPeriodEnd,
      value: toNumber(row.secondValue)
    }
  }
}

function serializeInvalidPeriodRow(row) {
  return {
    chunkValueId: row.chunkValueId,
    chunkId: row.chunkId,
    sourceId: row.sourceId,
    declarationId: row.declarationId,
    pointPrelevementId: row.pointPrelevementId,
    metricTypeCode: row.metricTypeCode,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    value: toNumber(row.value)
  }
}

const overlaps = await prisma.$queryRaw`
  WITH scoped_values AS (
    SELECT
      cv.id AS "chunkValueId",
      cv."metricTypeCode",
      cv."periodStart",
      cv."periodEnd",
      cv.value,
      c.id AS "chunkId",
      c."pointPrelevementId",
      s.id AS "sourceId",
      s."declarationId"
    FROM "ChunkValue" cv
    JOIN "Chunk" c ON c.id = cv."chunkId"
    JOIN "Source" s ON s.id = c."sourceId"
    WHERE c."pointPrelevementId" IS NOT NULL
      AND c."instructionStatus" IN (${Prisma.join(VALID_INSTRUCTION_STATUSES)})
      AND s.status = 'COMPLETED'
  )
  SELECT
    a."pointPrelevementId" AS "pointPrelevementId",
    a."metricTypeCode" AS "metricTypeCode",
    a."chunkValueId" AS "firstChunkValueId",
    a."chunkId" AS "firstChunkId",
    a."sourceId" AS "firstSourceId",
    a."declarationId" AS "firstDeclarationId",
    a."periodStart" AS "firstPeriodStart",
    a."periodEnd" AS "firstPeriodEnd",
    a.value AS "firstValue",
    b."chunkValueId" AS "secondChunkValueId",
    b."chunkId" AS "secondChunkId",
    b."sourceId" AS "secondSourceId",
    b."declarationId" AS "secondDeclarationId",
    b."periodStart" AS "secondPeriodStart",
    b."periodEnd" AS "secondPeriodEnd",
    b.value AS "secondValue"
  FROM scoped_values a
  JOIN scoped_values b
    ON b."pointPrelevementId" = a."pointPrelevementId"
    AND b."metricTypeCode" = a."metricTypeCode"
    AND b."chunkValueId" > a."chunkValueId"
    AND b."periodStart" < a."periodEnd"
    AND b."periodEnd" > a."periodStart"
  ORDER BY a."pointPrelevementId", a."metricTypeCode", a."periodStart", b."periodStart"
`

const invalidPeriods = await prisma.$queryRaw`
  SELECT
    cv.id AS "chunkValueId",
    cv."metricTypeCode",
    cv."periodStart",
    cv."periodEnd",
    cv.value,
    c.id AS "chunkId",
    c."pointPrelevementId",
    s.id AS "sourceId",
    s."declarationId"
  FROM "ChunkValue" cv
  JOIN "Chunk" c ON c.id = cv."chunkId"
  JOIN "Source" s ON s.id = c."sourceId"
  WHERE cv."periodEnd" <= cv."periodStart"
  ORDER BY cv."periodStart", cv.id
`

const serializedOverlaps = overlaps.map(serializeOverlapRow)
const serializedInvalidPeriods = invalidPeriods.map(serializeInvalidPeriodRow)

console.log(JSON.stringify({
  overlapsCount: serializedOverlaps.length,
  invalidPeriodsCount: serializedInvalidPeriods.length,
  overlaps: serializedOverlaps,
  invalidPeriods: serializedInvalidPeriods
}, null, 2))

await prisma.$disconnect()
