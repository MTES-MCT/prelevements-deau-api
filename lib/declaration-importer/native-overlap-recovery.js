import {createHash} from 'node:crypto'

export const NATIVE_OVERLAP_RECOVERY_VERSION = 1

export function nativeRecoveryReference(chunk) {
  const reference = chunk?.metadata?.nativeOverlapRecovery
  return reference?.version === NATIVE_OVERLAP_RECOVERY_VERSION
    && typeof reference.parentChunkId === 'string' && typeof reference.parentSeriesKey === 'string'
    && typeof reference.parentContentHash === 'string' ? reference : null
}

// A repair publication belongs to the exact original revision. Ordinary replay
// preserves it; changing/removing its parent retires it in the same transaction.
export function retainNativeRecovery(chunk, {chunks, prepared, keys}) {
  const reference = nativeRecoveryReference(chunk)
  if (!reference || chunk.metadata?.superseded || !keys.has(reference.parentSeriesKey)) return false
  const parent = chunks.find(item => item.id === reference.parentChunkId && item.seriesKey === reference.parentSeriesKey)
  if (!parent || parent.metadata?.superseded) return false
  const next = prepared.find(item => item.series.seriesKey === reference.parentSeriesKey)
  return (next?.contentHash ?? parent.contentHash) === reference.parentContentHash
}

export function nativeRecoveryId(namespace, value) {
  const hex = createHash('sha256').update(`${namespace}:${value}`).digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ((Number.parseInt(hex[16], 16) & 3) | 8).toString(16)
  const text = hex.join('')
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`
}
