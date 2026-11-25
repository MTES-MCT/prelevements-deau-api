import createHttpError from 'http-errors'

export const METER_VOLUME_OVERLAP_MESSAGE = 'Un volume calculé à partir des relevés du compteur couvre déjà tout ou partie de cette période. Vérifiez les dates saisies. Si elles sont exactes et que les relevés ou le compteur rattaché au point semblent incorrects, contactez l’équipe PE.'

export const COLLECTION_MODES = Object.freeze(['MANUAL', 'EXTERNAL'])

// Un mode absent conserve le fonctionnement antérieur des points existants.
export function canCollectManually(point) {
  return point?.collectionMode !== 'EXTERNAL'
}

export function manualCollectionAccessWhere({actorDeclarantUserId, declarantUserId}) {
  return {
    declarantUserId,
    ...(actorDeclarantUserId && actorDeclarantUserId !== declarantUserId
      ? {collecteurs: {some: {collecteurUserId: actorDeclarantUserId}}}
      : {}),
    pointPrelevement: {
      deletedAt: null,
      OR: [{collectionMode: null}, {collectionMode: 'MANUAL'}]
    }
  }
}

export function assertManualCollectionAccess(exploitations, pointIds) {
  if (pointIds.some(id => !exploitations.has(id)
    || !canCollectManually(exploitations.get(id)?.pointPrelevement))) {
    throw createHttpError(403, 'Un ou plusieurs points ne sont pas autorisés à la saisie manuelle pour ce compte.')
  }
}

export function assertManualVolumePublication(result, expectedCount) {
  if (result?.shouldSkip || !Array.isArray(result?.valueRowsToInsert) || result.valueRowsToInsert.length !== expectedCount) {
    throw createHttpError(409, 'La saisie ne peut pas être enregistrée en entier pour cette période. Vérifiez les dates saisies.')
  }
}
