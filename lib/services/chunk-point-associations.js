export const POINT_ASSOCIATION_ORIGINS = Object.freeze({
  AUTOMATIC: 'AUTOMATIC',
  MANUAL: 'MANUAL'
})

export const AUTOMATIC_POINT_ASSOCIATION_LOCK_REASON = 'AUTOMATIC_POINT_ASSOCIATION_LOCKED'

function getRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function normalizePointPrelevementId(value) {
  return value ? String(value) : null
}

export function getChunkPointAssociationOrigin(chunk) {
  if (!chunk?.pointPrelevementId) {
    return null
  }

  const parsingInfo = getRecord(chunk.parsingInfo)

  if (Object.values(POINT_ASSOCIATION_ORIGINS).includes(parsingInfo.pointAssociationOrigin)) {
    return parsingInfo.pointAssociationOrigin
  }

  const reason = typeof parsingInfo.reason === 'string' ? parsingInfo.reason : ''
  if (parsingInfo.reconciledAt || reason.startsWith('POINT_RECONCILED_BY_')) {
    return POINT_ASSOCIATION_ORIGINS.MANUAL
  }

  return POINT_ASSOCIATION_ORIGINS.AUTOMATIC
}

export function canChangeChunkPointAssociation(chunk) {
  return !chunk?.pointPrelevementId
    || getChunkPointAssociationOrigin(chunk) === POINT_ASSOCIATION_ORIGINS.MANUAL
}

export function isChunkPointAssociationChangeAllowed(chunk, targetPointPrelevementId) {
  const currentPointPrelevementId = normalizePointPrelevementId(chunk?.pointPrelevementId)
  const targetId = normalizePointPrelevementId(targetPointPrelevementId)

  return currentPointPrelevementId === targetId || canChangeChunkPointAssociation(chunk)
}

export function buildManualChunkPointAssociationParsingInfo({
  parsingInfo,
  previousPointPrelevementId,
  pointPrelevementId,
  changedByUserId,
  changedByRole,
  changedAt = new Date(),
  details
}) {
  const isDetaching = pointPrelevementId === null
  const changedAtIso = changedAt instanceof Date
    ? changedAt.toISOString()
    : new Date(changedAt).toISOString()

  return {
    ...getRecord(parsingInfo),
    ...getRecord(details),
    reason: `POINT_${isDetaching ? 'DETACHED' : 'RECONCILED'}_BY_${changedByRole}`,
    changedByUserId,
    changedByRole,
    previousPointPrelevementId: normalizePointPrelevementId(previousPointPrelevementId),
    pointPrelevementId: normalizePointPrelevementId(pointPrelevementId),
    pointAssociationOrigin: isDetaching ? null : POINT_ASSOCIATION_ORIGINS.MANUAL,
    ...(isDetaching
      ? {detachedAt: changedAtIso, reconciledAt: null}
      : {detachedAt: null, reconciledAt: changedAtIso})
  }
}

export function decorateChunkPointAssociation(chunk) {
  return {
    ...chunk,
    pointAssociationOrigin: getChunkPointAssociationOrigin(chunk)
  }
}

export function decorateSourcePointAssociations(source) {
  if (!source) {
    return source
  }

  return {
    ...source,
    chunks: (source.chunks ?? []).map(decorateChunkPointAssociation)
  }
}
