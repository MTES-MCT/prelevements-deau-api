import {clean, digest} from './epidropt.js'

const referenceKey = reference => `${reference.provider}:${reference.externalId}`
const unique = values => [...new Set(values.filter(Boolean))]

export function proposePointMatches({points, pointRows, lieux, assignments, snapshot}) {
  const claimed = new Map((snapshot?.tables?.externalReferences ?? [])
    .filter(ref => ref.provider === 'rives-et-eaux' && ref.pointPrelevementId)
    .map(ref => [ref.externalId, ref.pointPrelevementId]))
  const candidates = []
  for (const point of points.filter(point => !point.references.some(ref => ref.provider === 'rives-et-eaux'))) {
    const rows = pointRows.filter(row => point.names.includes(clean(row.values[1])))
    const codes = unique([...point.names.map(name => name.split('CACG')[0]), ...rows.map(row => clean(row.values[11]))])
    const serials = unique(rows.flatMap(row => clean(row.values[24]).split(';').map(clean)))
    const serialPlaces = unique(assignments.filter(row => serials.includes(row.serial)).map(row => row.lieuId))
    const placesByCode = lieux.filter(place => codes.includes(place.codeOU))
    const byCoordinates = placesByCode.filter(place => place.coordinates
      && place.coordinates.every((coordinate, index) => coordinate.toFixed(5) === point.coordinates[index].toFixed(5)))
    const bySerial = placesByCode.filter(place => serialPlaces.includes(place.id))
    const proposed = unique([...byCoordinates, ...bySerial].map(place => place.id))
    if (!proposed.length) continue
    const contradictorySerial = proposed.length === 1 && serialPlaces.length && !serialPlaces.includes(proposed[0])
    candidates.push({kind: 'POINT', pointId: point.id, names: point.names, sources: rows.map(row => ({sheet: 'Points prélèvement', row: row.row})),
      method: 'EXACT_CODE_WITH_COORDINATES_OR_SERIAL', candidates: proposed,
      evidence: {codePlaces: placesByCode.map(place => place.id), serialPlaces, coordinatePlaces: byCoordinates.map(place => place.id)},
      status: 'REVIEW', reason: proposed.length !== 1 || contradictorySerial ? 'CONTRADICTORY_REFERENCES'
        : claimed.has(proposed[0]) && claimed.get(proposed[0]) !== point.id ? 'PLACE_ALREADY_ASSIGNED' : 'REVERSE_CARDINALITY_TO_CHECK'})
  }
  for (const candidate of candidates) {
    if (candidate.reason === 'REVERSE_CARDINALITY_TO_CHECK') {
      const count = candidates.filter(other => other.candidates.includes(candidate.candidates[0])).length
      candidate.reason = count === 1 ? 'UNIQUE_CANDIDATE_REQUIRES_REVIEW' : 'MULTIPLE_POINTS_FOR_PLACE'
    }
  }
  return candidates
}

// Existing UUIDs are anchors, never regenerated from a newly discovered provider
// key. The private manifest/report is the ledger; source files remain unchanged.
export function preserveManifestIdentities(manifest, {previousManifest, snapshot} = {}) {
  if (!previousManifest && !snapshot) return manifest
  const result = structuredClone(manifest)
  const remapped = new Map()
  const blocked = new Set()
  const live = snapshot?.tables ?? {}
  const refs = live.externalReferences ?? []
  for (const [kind, table, field, referenceKind] of [
    ['points', 'points', 'id', 'POINT'], ['declarants', 'declarants', 'userId', 'DECLARANT'], ['meters', 'compteurs', 'id', 'METER']
  ]) {
    for (const record of result[kind]) {
      const keys = new Set(record.references.map(referenceKey))
      const previous = (previousManifest?.[kind] ?? []).filter(previous => previous.id === record.id
        || previous.references?.some(reference => keys.has(referenceKey(reference))))
      const matches = refs.filter(ref => ref.kind === referenceKind && keys.has(referenceKey(ref)))
      const targetField = {POINT: 'pointPrelevementId', DECLARANT: 'declarantUserId', METER: 'compteurId'}[referenceKind]
      const sourceMatches = (live[table] ?? []).filter(item => item[field] === record.id || (record.sourceId && item.sourceId === record.sourceId)
        || (kind === 'meters' && item.serialNumber === record.serial))
      const previousLiveIds = previous.map(item => (live[table] ?? []).find(stored => stored[field] === item.id
        || (item.sourceId && stored.sourceId === item.sourceId))?.[field] ?? item.id)
      const ids = unique([...matches.map(ref => ref[targetField]), ...sourceMatches.map(row => row[field]), ...previousLiveIds])
      if (ids.length > 1 || previous.length > 1) {
        blocked.add(record.id)
        result.issues.push({code: 'IDENTITY_LEDGER_CONFLICT', source: {kind, id: record.id}, candidates: ids})
        continue
      }
      if (kind === 'declarants' && record.data.siret) {
        const sameSiret = (live.declarants ?? []).filter(person => person.siret === record.data.siret && !person.deletedAt)
        if (sameSiret.some(person => person.userId !== (ids[0] ?? record.id))) {
          blocked.add(record.id)
          result.issues.push({code: 'SIRET_IDENTITY_CONFLICT', source: {kind, id: record.id}})
          continue
        }
      }
      const beforeId = record.id
      const anchor = previous[0]
      const id = ids[0] ?? record.id
      remapped.set(beforeId, id)
      if (anchor) {
        remapped.set(anchor.id, id)
        record.key = anchor.key
        record.sourceId = anchor.sourceId
      }
      const stored = (live[table] ?? []).find(item => item[field] === id)
      if (stored?.sourceId) record.sourceId = stored.sourceId
      record.id = id
      if (beforeId !== id || anchor) result.reconciliation.push({kind: 'IDENTITY', entity: kind, sourceId: beforeId, id,
        status: 'ACCEPTED', method: 'EXISTING_UUID_ANCHOR'})
    }
    result[kind] = result[kind].filter(record => !blocked.has(record.id))
  }

  for (const record of result.exploitations) {
    const beforeId = record.id
    if (blocked.has(record.pointId) || blocked.has(record.declarantId)) {
      blocked.add(beforeId)
      result.issues.push({code: 'EXPLOITATION_IDENTITY_DEPENDENCY_CONFLICT', source: {id: beforeId}})
      continue
    }
    record.pointId = remapped.get(record.pointId) ?? record.pointId
    record.declarantId = remapped.get(record.declarantId) ?? record.declarantId
    const previous = (previousManifest?.exploitations ?? []).filter(previous =>
      (remapped.get(previous.pointId) ?? previous.pointId) === record.pointId
      && (remapped.get(previous.declarantId) ?? previous.declarantId) === record.declarantId)
    const siblings = result.exploitations.filter(item => (remapped.get(item.pointId) ?? item.pointId) === record.pointId
      && (remapped.get(item.declarantId) ?? item.declarantId) === record.declarantId)
    const exact = previous.filter(previous => clean(previous.countingCode) === clean(record.countingCode))
    const anchor = previous.find(previous => previous.id === beforeId)
      ?? (exact.length === 1 ? exact[0] : previous.length === 1 && siblings.length === 1 ? previous[0] : null)
    if (previous.some(previous => !previous.countingCode) && siblings.length > 1 && !anchor) {
      blocked.add(beforeId)
      result.issues.push({code: 'EXPLOITATION_LEGACY_CODE_AMBIGUOUS', source: {id: beforeId}})
      continue
    }
    const stored = (live.exploitations ?? []).filter(item => item.id === (anchor?.id ?? beforeId)
      || (anchor?.sourceId && item.sourceId === anchor.sourceId)
      || (record.sourceId && item.sourceId === record.sourceId))
    if (unique(stored.map(item => item.id)).length > 1) {
      blocked.add(beforeId)
      result.issues.push({code: 'IDENTITY_LEDGER_CONFLICT', source: {kind: 'exploitations', id: beforeId}})
      continue
    }
    if (anchor) {
      record.id = anchor.id
      record.key = anchor.key
      record.sourceId = anchor.sourceId
      record.previousCountingCode = anchor.countingCode ?? null
    }
    if (stored[0]) {
      record.id = stored[0].id
      record.sourceId = stored[0].sourceId ?? record.sourceId
    }
    remapped.set(beforeId, record.id)
  }
  result.exploitations = result.exploitations.filter(record => !blocked.has(record.id))
  result.allocations = result.allocations.filter(record => !blocked.has(record.exploitationId) && !blocked.has(record.compteurId))
  for (const record of result.allocations) {
    record.exploitationId = remapped.get(record.exploitationId) ?? record.exploitationId
    record.compteurId = remapped.get(record.compteurId) ?? record.compteurId
    if (record.provider === 'epidropt') {
      const meter = result.meters.find(meter => meter.id === record.compteurId)
      record.sourceId = `dropt-epidropt:allocation:${digest([meter.serial, record.exploitationId]).slice(0, 32)}`
    }
  }
  for (const entry of result.reconciliation) {
    if (entry.exploitationId) entry.exploitationId = remapped.get(entry.exploitationId) ?? entry.exploitationId
    if (entry.pointId) entry.pointId = remapped.get(entry.pointId) ?? entry.pointId
  }
  for (const meter of result.meters.filter(meter => meter.provider === 'rives-et-eaux')) {
    if (meter.allocationSnapshot.some(item => item.inScope && !result.allocations.some(allocation => allocation.sourceId === item.key))) {
      meter.allocationSnapshotValidated = false
    }
  }
  return result
}
