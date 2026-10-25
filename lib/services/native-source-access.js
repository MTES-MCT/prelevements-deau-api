import {mergeNativeDiagnostics} from '../declaration-importer/native-diagnostics.js'

const NATIVE_DECLARATION_TYPES = new Set(['reunion_multi_param', 'reunion_camion_citerne', 'reunion-multi-param', 'reunion-camion-citerne'])

export function isNativeSource(source) {
  return source?.metadata?.nativeTemporal === true || NATIVE_DECLARATION_TYPES.has(source?.declaration?.type)
}

// Apply after chunk permissions. Source-wide receipts, errors, files and totals
// must not reveal the portion of a native dossier outside the visible territory.
export function scopeNativeSource(source) {
  if (!isNativeSource(source)) return source
  const chunks = source.chunks ?? []
  const partial = (source._count?.chunks ?? chunks.length) > chunks.length
  const visibleKeys = new Set(chunks.map(chunk => chunk.seriesKey).filter(Boolean))
  const {nativeBatch: _nativeBatch, parsingErrors = [], parsingErrorCounts, parsingErrorsSampled, ...metadata} = source.metadata ?? {}
  const errors = partial ? parsingErrors.filter(error => error?.seriesKey && visibleKeys.has(error.seriesKey)) : parsingErrors
  const diagnostics = partial
    ? mergeNativeDiagnostics(null, errors)
    : mergeNativeDiagnostics({parsingErrors: errors, parsingErrorCounts, parsingErrorsSampled}, [])
  if (partial) {
    delete diagnostics.parsingErrorCounts
    diagnostics.parsingErrorsSampled = true
    diagnostics.hasAnomalies ||= chunks.some(chunk => chunk.parsingInfo?.issueCounts?.total > 0)
  }
  const totals = {totalWaterVolumeWithdrawn: 0, totalWaterVolumeDischarged: 0}
  if (source.status === 'COMPLETED') {
    for (const chunk of chunks) {
      if (chunk.instructionStatus === 'REJECTED') continue
      for (const key of Object.keys(totals)) {
        const value = Number(chunk.metadata?.[key] ?? 0)
        if (Number.isFinite(value)) totals[key] += value
      }
    }
  }
  return {...source,
    metadata: {...metadata, ...totals, ...diagnostics},
    ...(partial && source.declaration ? {declaration: {...source.declaration, files: []}} : {}),
    ...(source._count ? {_count: {...source._count, chunks: chunks.length}} : {})}
}
