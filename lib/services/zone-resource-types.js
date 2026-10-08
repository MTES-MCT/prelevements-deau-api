import createHttpError from 'http-errors'

export const ZONE_MANAGED_RESOURCE_TYPES = Object.freeze(['SUPERFICIELLE', 'SOUTERRAIN', 'TRANSITION', 'MIXTE'])
export const SAGE_OVERLAP_ZONE_CODES = Object.freeze({
  ROUSSILLON: 'sage-SAGE06028',
  TECH_ALBERES: 'sage-SAGE06030'
})

export function isSageSelectionBlocked(reason) {
  return reason === 'SAGE_CANDIDATES_AMBIGUOUS' || reason === 'SAGE_OVERLAP_RESOURCE_CONFLICT'
}

export function getZoneManagedResourceType(zone) {
  return zone.type === 'SAGE' ? zone.managedResourceType ?? 'MIXTE' : null
}

export function isZoneResourceCompatible(zone, waterBodyType) {
  const managedResourceType = getZoneManagedResourceType(zone)
  return zone.type !== 'SAGE' || managedResourceType === 'MIXTE' || managedResourceType === waterBodyType
}

function selectOverlapSage(sageCandidates, compatibleCandidates, waterBodyType) {
  const targetCode = waterBodyType === 'SUPERFICIELLE' ? SAGE_OVERLAP_ZONE_CODES.TECH_ALBERES
    : waterBodyType === 'SOUTERRAIN' ? SAGE_OVERLAP_ZONE_CODES.ROUSSILLON : null
  const pairCodes = Object.values(SAGE_OVERLAP_ZONE_CODES)
  if (!targetCode || !pairCodes.every(code => sageCandidates.some(zone => zone.code === code))) return null

  const target = sageCandidates.find(zone => zone.code === targetCode)
  if (!isZoneResourceCompatible(target, waterBodyType)) {
    return {reason: 'SAGE_OVERLAP_RESOURCE_CONFLICT', compatibleCandidates, selectedSage: null}
  }
  const remainingCandidates = compatibleCandidates.filter(zone => zone.code === targetCode || !pairCodes.includes(zone.code))
  if (remainingCandidates.length !== 1) {
    return {reason: 'SAGE_CANDIDATES_AMBIGUOUS', compatibleCandidates: remainingCandidates, selectedSage: null}
  }
  return {reason: 'SAGE_OVERLAP_RESOURCE_PRIORITY', compatibleCandidates: remainingCandidates, selectedSage: target}
}

// Input must already be restricted to the geometric candidates. The local pair
// rule never introduces a zone outside the intersection or changes its settings.
export function selectCompatibleSageZone(candidates, waterBodyType) {
  const sageCandidates = candidates.filter(zone => zone.type === 'SAGE')
  const compatibleCandidates = sageCandidates.filter(zone => isZoneResourceCompatible(zone, waterBodyType))
  const overlapSelection = selectOverlapSage(sageCandidates, compatibleCandidates, waterBodyType)
  if (overlapSelection) return overlapSelection
  const specializedCandidates = compatibleCandidates.filter(zone => getZoneManagedResourceType(zone) !== 'MIXTE')
  const preferredCandidates = specializedCandidates.length ? specializedCandidates : compatibleCandidates
  const selectedSage = preferredCandidates.length === 1 ? preferredCandidates[0] : null
  let reason = 'SAGE_CANDIDATES_AMBIGUOUS'
  if (sageCandidates.length === 0) reason = 'NO_GEOMETRIC_SAGE'
  else if (compatibleCandidates.length === 0) reason = 'NO_COMPATIBLE_SAGE'
  else if (compatibleCandidates.length === 1) reason = 'SINGLE_COMPATIBLE_SAGE'
  else if (selectedSage) reason = 'SPECIALIZED_SAGE_PRIORITY'
  return {reason, compatibleCandidates, selectedSage}
}

export function selectPointZones(candidates, waterBodyType) {
  const selection = selectCompatibleSageZone(candidates, waterBodyType)
  if (isSageSelectionBlocked(selection.reason)) {
    const message = selection.reason === 'SAGE_OVERLAP_RESOURCE_CONFLICT'
      ? 'Le type de ressource gérée du SAGE désigné dans le chevauchement est incompatible avec le milieu du point. Vérifiez la configuration de cette zone avant de poursuivre.'
      : 'Plusieurs SAGE compatibles couvrent ce point. Vérifiez les types de ressource gérée des zones avant de poursuivre.'
    const error = createHttpError(409, message)
    error.data = {code: selection.reason, candidateZoneIds: selection.compatibleCandidates.map(zone => zone.id)}
    throw error
  }
  return [...candidates.filter(zone => zone.type !== 'SAGE'), ...(selection.selectedSage ? [selection.selectedSage] : [])]
}
