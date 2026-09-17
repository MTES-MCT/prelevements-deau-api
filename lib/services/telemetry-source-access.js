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
    const point = chunk.pointPrelevement
    return {
      ...chunk, ...readOnlyCapabilities, metadata: {...totals, calculationStrategy: 'METER'},
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
  return {
    ...visibleSource, ...readOnlyCapabilities,
    metadata: {calculationStrategy: 'METER', ...totals},
    chunks, _count: {...source._count, chunks: chunks.length}
  }
}
