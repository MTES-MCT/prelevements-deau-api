const legalName = value => String(value ?? '').trim().toLocaleLowerCase('fr')

export function resolveHistoricalDeclarant({legacy, preleveurs, points, exploitations}) {
  const sourceId = owner => `reunion:DEP-974:declarant:${owner.id_preleveur}`
  const owner = preleveurs.find(item => String(item._id) === String(legacy.result?.preleveur))
  if (owner) return {owner, resolution: {method: 'LEGACY_RESULT', sourceId: sourceId(owner), sourceReference: String(owner._id)}}
  const name = legalName(legacy.declarant?.raisonSociale)
  const candidates = name ? preleveurs.filter(item => legalName(item.raison_sociale) === name) : []
  if (candidates.length !== 1) return {owner: null}
  const candidate = candidates[0]
  const declaredPoints = [...new Set([legacy.pointPrelevement, ...(legacy.result?.foundPointPrelevements ?? [])]
    .filter(value => Number.isSafeInteger(value) && value > 0))]
  const ownerExploits = exploitations.filter(item => String(item.preleveur) === String(candidate._id) && !item.deletedAt)
  const pointById = new Map(points.map(item => [String(item._id), item.id_point]))
  const ownerPoints = new Set(ownerExploits.map(item => pointById.get(String(item.point))))
  const evidence = {method: 'EXACT_LEGAL_NAME_AND_POINT', sourceId: sourceId(candidate), sourceReference: String(candidate._id),
    legalName: legacy.declarant.raisonSociale, declaredPoints, exploitationReferences: ownerExploits.filter(item => declaredPoints.includes(pointById.get(String(item.point))))
      .map(item => ({sourceId: `reunion:DEP-974:exploitation:${item.id_exploitation}`, pointId: pointById.get(String(item.point))}))}
  if (declaredPoints.length && declaredPoints.every(point => ownerPoints.has(point))) return {owner: candidate, resolution: evidence}
  return {owner: null, proposal: {...evidence, method: 'EXACT_LEGAL_NAME_ONLY', reason: 'Nom légal identique ; rattachement au point non corroboré'}}
}
