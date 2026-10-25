import {getCompatibleMetricTypeCodes} from '../constants/metric-type-codes.js'

const ACCEPTED_STATUSES = ['VALIDATED', 'AUTOMATICALLY_VALIDATED']
const NATIVE_VALUE_TYPES = new Set(['instantaneous', 'average', 'minimum', 'maximum', 'median', 'delta-index', 'raw', 'cumulative'])

function dimensionText(value) {
  if (value === undefined || value === null) return null
  return (typeof value === 'object' ? JSON.stringify(value) : String(value)).trim() || null
}

function depthDimension(value) {
  const text = dimensionText(value)
  if (!text || !/^[+-]?\d+(?:\.\d+)?$/.test(text)) return text
  const [integer, decimals = ''] = text.replace(/^[+-]/, '').split('.')
  let end = decimals.length
  while (end && decimals[end - 1] === '0') end--
  const fraction = decimals.slice(0, end)
  const normalized = `${integer.replace(/^0+(?=\d)/, '')}${fraction ? `.${fraction}` : ''}`
  return normalized === '0' ? '0' : `${text.startsWith('-') ? '-' : ''}${normalized}`
}

export function nativeDimension(metadata = {}) {
  return JSON.stringify([dimensionText(metadata?.detailPointSuivi), depthDimension(metadata?.profondeur)])
}

export function periodsOverlap(a, b) {
  const aStart = +new Date(a.periodStart), aEnd = +new Date(a.periodEnd)
  const bStart = +new Date(b.periodStart), bEnd = +new Date(b.periodEnd)
  if (aStart === aEnd && bStart === bEnd) return aStart === bStart
  if (aStart === aEnd) return aStart >= bStart && aStart < bEnd
  if (bStart === bEnd) return bStart >= aStart && bStart < aEnd
  return aStart < bEnd && bStart < aEnd
}

/** Any overlap between two sets, with inclusive instants and half-open periods. */
export function nativePeriodsConflict(values, candidates) {
  const periods = entries => entries.map(value => ({periodStart: +new Date(value.periodStart), periodEnd: +new Date(value.periodEnd)}))
    .filter(value => Number.isFinite(value.periodStart) && Number.isFinite(value.periodEnd) && value.periodStart <= value.periodEnd)
    .sort((a, b) => a.periodStart - b.periodStart || a.periodEnd - b.periodEnd)
  const left = periods(values), right = periods(candidates)
  let i = 0, j = 0
  while (i < left.length && j < right.length) {
    const a = left[i], b = right[j]
    if (periodsOverlap(a, b)) return true
    if (a.periodEnd <= b.periodStart) i++
    else j++
  }
  return false
}

export async function nativeConflicts(client, {pointPrelevementId, preleveurUserId, metadata, values, excludeChunkId, sourceId}) {
  if (!pointPrelevementId || !values.length) return false
  const min = new Date(values.reduce((result, value) => Math.min(result, +new Date(value.periodStart)), Infinity))
  const max = new Date(values.reduce((result, value) => Math.max(result, +new Date(value.periodEnd)), -Infinity))
  const candidates = await client.chunkValue.findMany({where: {
    ...(excludeChunkId ? {chunkId: {not: excludeChunkId}} : {}), metricTypeCode: {in: getCompatibleMetricTypeCodes(values[0].metricTypeCode)},
    periodStart: {lte: max}, periodEnd: {gte: min},
    chunk: {pointPrelevementId, preleveurUserId, instructionStatus: {in: ACCEPTED_STATUSES},
      source: {OR: [{status: 'COMPLETED'}, ...(sourceId ? [{id: sourceId}] : [])]}}
  }, select: {periodStart: true, periodEnd: true, chunk: {select: {metadata: true}}}})
  const dimension = nativeDimension(metadata)
  return nativePeriodsConflict(values, candidates.filter(candidate => {
    const candidateMetadata = candidate.chunk.metadata
    if (nativeDimension(candidateMetadata) !== dimension) return false
    // Minima, maxima and averages are separate measurements. Legacy values with
    // no known nature remain conservative conflicts with every native nature.
    return !NATIVE_VALUE_TYPES.has(metadata?.valueType) || !NATIVE_VALUE_TYPES.has(candidateMetadata?.valueType)
      || metadata.valueType === candidateMetadata.valueType
  }))
}
