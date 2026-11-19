import {Prisma} from '@prisma/client'
import {NON_REJECTED_CHUNK_INSTRUCTION_STATUSES} from '../constants/chunk-statuses.js'
import {getCompatibleMetricTypeCodes, METRIC_TYPE_CODES} from '../constants/metric-type-codes.js'

const indexCodes = getCompatibleMetricTypeCodes(METRIC_TYPE_CODES.INDEX)
const volumeCodes = getCompatibleMetricTypeCodes(METRIC_TYPE_CODES.VOLUME)
const indexFilter = {valueKind: 'DECLARED', metricTypeCode: {in: indexCodes}}
const volumeFilter = {valueKind: {in: ['DECLARED', 'COMPUTED']}, metricTypeCode: {in: volumeCodes}}
const select = {
  id: true, value: true, valueKind: true, metricTypeCode: true, unit: true,
  periodStart: true, periodEnd: true, chunk: {select: {metadata: true}}
}
const orderBy = [{periodEnd: 'desc'}, {createdAt: 'desc'}, {id: 'desc'}]
const historyLimit = 60
const followingLimit = 12

function endDay(row) {
  if (row.readingDate || row.periodEndDate) return row.readingDate ?? row.periodEndDate
  const directVolume = row.valueKind === 'DECLARED' && volumeCodes.includes(row.metricTypeCode)
  return new Date(+row.periodEnd - (directVolume ? 1 : 0)).toISOString().slice(0, 10)
}

async function readFollowing(client, chunkWhere, sourceId, end, isIndex, cutoffDay) {
  const rows = await client.chunkValue.findMany({
    where: {
      chunk: {...chunkWhere, sourceId: {not: sourceId}},
      OR: [
        {...indexFilter, periodEnd: isIndex ? {gt: end} : {gte: end}},
        {...volumeFilter, periodEnd: {gt: end}}
      ]
    },
    select, orderBy: [{periodEnd: 'asc'}, {createdAt: 'desc'}, {id: 'desc'}], take: followingLimit + 1
  })
  // If the window cuts through one closing instant, leave that entire group out
  // so the final computed volume and its closing index are shown together.
  const boundary = rows[followingLimit]?.periodEnd
  const following = formatReadingHistory(boundary ? rows.filter(row => row.periodEnd < boundary) : rows)
  following.indexes = following.indexes.filter(row => endDay(row) > cutoffDay)
  following.volumes = following.volumes.filter(row => endDay(row) > cutoffDay)
  return following
}

async function readHistory(chunk, {client, readableSourceWhere, sourceId}, end, isIndex) {
  const where = {
    pointPrelevementId: chunk.pointPrelevementId,
    exploitationId: chunk.exploitationId,
    preleveurUserId: chunk.preleveurUserId,
    compteurId: chunk.compteurId ?? null,
    ...(!chunk.compteurId && {metadata: {path: ['serialNumber'], equals: Prisma.AnyNull}}),
    calculationStrategy: 'GENERIC', instructionStatus: {in: NON_REJECTED_CHUNK_INSTRUCTION_STATUSES},
    source: {AND: [
      readableSourceWhere,
      {type: 'DECLARATION', status: 'COMPLETED', globalInstructionStatus: {not: 'REJECTED'},
        metadata: {path: ['manualQuickDeclaration'], equals: true}},
      {metadata: {path: ['collectionCampaignId'], equals: Prisma.AnyNull}},
      {metadata: {path: ['collectionResponseId'], equals: Prisma.AnyNull}},
      {declaration: {is: {dataSourceType: 'MANUAL', declarantUserId: chunk.preleveurUserId, collectionResponse: null}}}
    ]}
  }
  // A directly declared volume ends at midnight following its last included day.
  const readableIndexes = isIndex ? indexFilter : {...indexFilter, periodStart: {lt: end}}
  const rows = await client.chunkValue.findMany({
    where: {chunk: where, periodEnd: {lte: end}, OR: [readableIndexes, volumeFilter]},
    select, orderBy, take: historyLimit
  })

  // A displayed computed interval can have endpoint readings outside the recent window.
  const knownEnds = new Set(rows.filter(row => indexCodes.includes(row.metricTypeCode)).map(row => +row.periodEnd))
  const missingEnds = new Set()
  for (const row of [...rows, ...(chunk.chunkValues ?? [])]) {
    if (row.valueKind !== 'COMPUTED' || !volumeCodes.includes(row.metricTypeCode)) continue
    for (const date of [row.periodStart, row.periodEnd]) {
      if (+date <= +end && !knownEnds.has(+date)) missingEnds.add(+date)
    }
  }
  if (missingEnds.size) {
    rows.push(...await client.chunkValue.findMany({
      where: {chunk: where, ...readableIndexes, periodEnd: {in: [...missingEnds].map(time => new Date(time))}},
      select, orderBy, take: historyLimit
    }))
  }

  const lastVolumeDay = isIndex ? null : chunk.metadata?.periodEndDate ?? new Date(+end - 1).toISOString().slice(0, 10)
  const cutoffDay = lastVolumeDay ?? chunk.metadata?.readingDate ?? end.toISOString().slice(0, 10)
  const following = await readFollowing(client, where, sourceId, end, isIndex, cutoffDay)
  return {...formatReadingHistory(rows, lastVolumeDay), following}
}

function formatReadingHistory(rows, lastVolumeDay) {
  const seen = new Set()
  const history = {indexes: [], volumes: []}
  for (const {chunk: {metadata}, ...row} of rows) {
    const index = indexCodes.includes(row.metricTypeCode)
    if (index && metadata?.readingDate) {
      if (lastVolumeDay && metadata.readingDate > lastVolumeDay) continue
      row.readingDate = metadata.readingDate
    }
    const key = JSON.stringify([index ? 'index' : row.valueKind, row.periodEnd, index ? null : row.periodStart])
    if (seen.has(key)) continue
    seen.add(key)
    if (!index && row.valueKind === 'DECLARED' && metadata?.periodStartDate && metadata?.periodEndDate) {
      row.periodStartDate = metadata.periodStartDate
      row.periodEndDate = metadata.periodEndDate
    }
    history[index ? 'indexes' : 'volumes'].push(row)
  }
  for (const values of Object.values(history)) values.sort((a, b) => a.periodEnd - b.periodEnd)
  return history
}

function canReadChunkHistory(chunk, readablePointIds) {
  return chunk.pointPrelevementId && chunk.exploitationId && chunk.preleveurUserId
    && (!readablePointIds || readablePointIds.has(chunk.pointPrelevementId))
    && NON_REJECTED_CHUNK_INSTRUCTION_STATUSES.includes(chunk.instructionStatus)
    && (chunk.compteurId || !chunk.metadata?.serialNumber)
    && !chunk.metadata?.nativeTemporal && !chunk.metadata?.collectionCampaignId
}

// Call after source authorization and value loading. Require the same source access
// conditions on every historical row, even when the viewer may read the current receipt.
export async function loadQuickReadingHistory(source, {client, readableSourceWhere, readablePointIds}) {
  if (!readableSourceWhere || source?.metadata?.manualQuickDeclaration !== true || source.metadata.collectionCampaignId
    || source.metadata.collectionResponseId || source.status !== 'COMPLETED' || source.globalInstructionStatus === 'REJECTED') return
  const isIndex = (source.metadata.measurementType ?? 'INDEX') === 'INDEX'
  const pending = []
  for (const chunk of source.chunks ?? []) {
    if (!canReadChunkHistory(chunk, readablePointIds)) continue
    const dates = (chunk.chunkValues ?? []).filter(row => row.valueKind === 'DECLARED'
      && (isIndex ? indexCodes : volumeCodes).includes(row.metricTypeCode)).map(row => +row.periodEnd)
    if (!dates.length) continue
    const end = new Date(Math.max(...dates))
    if (!Number.isFinite(+end)) continue
    pending.push({chunk, end})
  }

  // A form can contain many independent points. Bound both connection usage and rows per point.
  for (let i = 0; i < pending.length; i += 8) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(pending.slice(i, i + 8).map(async ({chunk, end}) => {
      chunk.quickReadingHistory = await readHistory(chunk, {client, readableSourceWhere, sourceId: source.id}, end, isIndex)
    }))
  }
}
