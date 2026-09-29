import createHttpError from 'http-errors'

export const ZONE_MANAGED_RESOURCE_TYPES = Object.freeze(['SUPERFICIELLE', 'SOUTERRAIN', 'TRANSITION', 'MIXTE'])

export function getZoneManagedResourceType(zone) {
  return zone.type === 'SAGE' ? zone.managedResourceType ?? 'MIXTE' : null
}

export function isZoneResourceCompatible(zone, waterBodyType) {
  const managedResourceType = getZoneManagedResourceType(zone)
  return zone.type !== 'SAGE' || managedResourceType === 'MIXTE' || managedResourceType === waterBodyType
}

// Input must already be restricted to the geometric candidates. This function
// never searches by a name/code or introduces a zone outside that intersection.
export function selectCompatibleSageZone(candidates, waterBodyType) {
  const sageCandidates = candidates.filter(zone => zone.type === 'SAGE')
  const compatibleCandidates = sageCandidates.filter(zone => isZoneResourceCompatible(zone, waterBodyType))
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
  if (selection.reason === 'SAGE_CANDIDATES_AMBIGUOUS') {
    const error = createHttpError(409, 'Plusieurs SAGE compatibles couvrent ce point. Vérifiez les types de ressource gérée des zones avant de poursuivre.')
    error.data = {code: 'SAGE_CANDIDATES_AMBIGUOUS', candidateZoneIds: selection.compatibleCandidates.map(zone => zone.id)}
    throw error
  }
  return [...candidates.filter(zone => zone.type !== 'SAGE'), ...(selection.selectedSage ? [selection.selectedSage] : [])]
}
