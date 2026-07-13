export const POINT_FLOW_TYPES = Object.freeze({
  PRELEVEMENT: 'PRELEVEMENT',
  REJET: 'REJET'
})

export const POINT_FLOW_TYPE_VALUES = Object.freeze(Object.values(POINT_FLOW_TYPES))

export function normalizePointFlowType(value) {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toUpperCase()
  return POINT_FLOW_TYPE_VALUES.includes(normalized) ? normalized : null
}

export function getSourceFlowTypeFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null
  }

  return normalizePointFlowType(metadata.sourceFlowType ?? metadata.source_flow_type)
}
