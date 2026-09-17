import {prisma} from '../../db/prisma.js'
import {computeChunkVolumeTotals} from './volume-totals.js'

export function getMeterChunkAccessWhere({user, pointIds = []} = {}) {
  if (user?.role === 'ADMIN') return {}
  if (user?.role === 'INSTRUCTOR') return {pointPrelevementId: {in: pointIds}}
  if (!user?.id || (user.role && user.role !== 'DECLARANT')) return {id: {in: []}}

  const own = {preleveurUserId: user.id}
  if (user.declarant?.declarantRole !== 'COLLECTEUR') return own

  return {OR: [own, {
    chunkValues: {some: {meterContributions: {some: {
      allocationVersion: {allocation: {exploitation: {
        collecteurs: {some: {collecteurUserId: user.id}}
      }}}
    }}}}
  }]}
}

export function getVisibleTelemetryChunksWhere({user, pointIds} = {}) {
  return {OR: [
    {calculationStrategy: {not: 'METER'}},
    {calculationStrategy: 'METER', ...getMeterChunkAccessWhere({user, pointIds})}
  ]}
}

export function getReadableTelemetrySourceWhere(declarantUserIds, {user = {id: declarantUserIds[0]}} = {}) {
  return {
    type: 'API',
    chunks: {some: {OR: [
      {
        calculationStrategy: {not: 'METER'},
        pointPrelevement: {declarants: {some: {declarantUserId: {in: declarantUserIds}}}}
      },
      {calculationStrategy: 'METER', ...getMeterChunkAccessWhere({user})}
    ]}}
  }
}

const readOnlyCapabilities = {
  readOnly: true, canEdit: false, canDelete: false, canInstruct: false, canReconcile: false
}

export function isMeterSource(source) {
  return source?.metadata?.calculationStrategy === 'METER'
    || source?.chunks?.some(chunk => chunk.calculationStrategy === 'METER')
}

function exactPeriod(values) {
  const starts = values.map(value => value.periodStart).filter(Boolean).map(value => new Date(value).getTime()).filter(Number.isFinite)
  const ends = values.map(value => value.periodEnd).filter(Boolean).map(value => new Date(value).getTime()).filter(Number.isFinite)
  if (!starts.length || !ends.length) return {}
  return {periodStart: new Date(Math.min(...starts)).toISOString(), periodEnd: new Date(Math.max(...ends)).toISOString()}
}

// Call only AFTER the source query has applied chunk-level permissions. Lists
// need two aggregate timestamps per visible METER chunk, not all legacy values.
// No source/publication-wide dates are reused for a partly visible source.
export async function hydrateMeterSourcePeriods(sources, {client = prisma} = {}) {
  const chunkIds = [...new Set(sources.flatMap(source => source.chunks ?? [])
    .filter(chunk => chunk.calculationStrategy === 'METER' && !Array.isArray(chunk.chunkValues)).map(chunk => chunk.id))]
  if (!chunkIds.length) return sources
  const periods = await client.chunkValue.groupBy({
    by: ['chunkId'], where: {chunkId: {in: chunkIds}},
    _min: {periodStart: true}, _max: {periodEnd: true}
  })
  const byChunk = new Map(periods.map(period => [period.chunkId, exactPeriod([{periodStart: period._min.periodStart, periodEnd: period._max.periodEnd}])]))
  const selectedIds = new Set(chunkIds)
  return sources.map(source => ({...source, chunks: source.chunks?.map(chunk => {
    if (!selectedIds.has(chunk.id)) return chunk
    const {periodStart: _periodStart, periodEnd: _periodEnd, ...metadata} = chunk.metadata ?? {}
    return {...chunk, metadata: {...metadata, ...byChunk.get(chunk.id)}}
  })}))
}

// The database query MUST filter chunks with getVisibleTelemetryChunksWhere first.
// Reusing persisted source totals here would disclose other allocations of a
// shared meter. Chunk totals refer only to that exploitation's allocated volume.
export function scopeMeterSource(source) {
  if (!source || !isMeterSource(source)) return source

  const chunks = (source.chunks ?? []).map(chunk => {
    if (chunk.calculationStrategy !== 'METER') return chunk
    const totals = chunk.chunkValues
      ? computeChunkVolumeTotals(chunk.chunkValues, chunk.flowType ?? chunk.pointPrelevement?.flowType)
      : Object.fromEntries(['totalWaterVolume', 'totalWaterVolumeWithdrawn', 'totalWaterVolumeDischarged']
        .map(key => [key, Number(chunk.metadata?.[key] ?? 0)]))
    const period = exactPeriod(Array.isArray(chunk.chunkValues) ? chunk.chunkValues : [chunk.metadata ?? {}])
    const point = chunk.pointPrelevement
    return {
      ...chunk, ...readOnlyCapabilities, metadata: {...totals, ...period, calculationStrategy: 'METER'},
      ...(point?.declarants ? {pointPrelevement: {
        ...point, declarants: point.declarants.filter(link => link.declarantUserId === chunk.preleveurUserId)
      }} : {})
    }
  })
  const totals = chunks.reduce((sum, chunk) => {
    if (chunk.instructionStatus !== 'REJECTED') {
      sum.totalWaterVolumeWithdrawn += Number(chunk.metadata?.totalWaterVolumeWithdrawn ?? 0)
      sum.totalWaterVolumeDischarged += Number(chunk.metadata?.totalWaterVolumeDischarged ?? 0)
    }
    return sum
  }, {totalWaterVolumeWithdrawn: 0, totalWaterVolumeDischarged: 0})
  const {meterPublication: _meterPublication, ...visibleSource} = source
  const period = exactPeriod(chunks.filter(chunk => chunk.calculationStrategy === 'METER' && chunk.instructionStatus !== 'REJECTED')
    .map(chunk => chunk.metadata))
  return {
    ...visibleSource, ...readOnlyCapabilities,
    metadata: {calculationStrategy: 'METER', ...totals, ...period},
    chunks, _count: {...source._count, chunks: chunks.length}
  }
}
