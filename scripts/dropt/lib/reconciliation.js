import {clean, coordinates, digest} from './epidropt.js'
import {createImportAliasResolver} from '../../../lib/services/import-aliases.js'

const referenceKey = reference => `${reference.provider}:${reference.externalId}`
const unique = values => [...new Set(values.filter(Boolean))]

export const isCacgPoint = name => /CACG/i.test(clean(name))

// Only the numeric part before CACG is transformed. The complete CACG suffix
// remains part of every key: a client number on its own is not a point identity.
export function cacgNameVariants(value) {
  const name = clean(value)
  const match = /^(\d+)(CACG_.+)$/i.exec(name)
  if (!match) return [name]
  const [, code, suffix] = match
  const unpadded = value => value.replace(/^0+(?=\d)/, '')
  const variants = [name, `${unpadded(code)}${suffix}`]
  if (/^(24|33|47)\d+$/.test(code)) variants.push(`${unpadded(code.slice(2))}${suffix}`)
  return unique(variants)
}

function distanceMeters(left, right) {
  const radians = value => value * Math.PI / 180
  const latitude = radians((left[1] + right[1]) / 2)
  return 6_371_000 * Math.hypot(radians(left[0] - right[0]) * Math.cos(latitude), radians(left[1] - right[1]))
}

export function resolvePointMatches({pointRows, lieux, assignments, previousManifest, snapshot, overrides = {}}) {
  const grouped = new Map()
  for (const row of pointRows) {
    const name = clean(row.values[1])
    if (name) grouped.set(name, [...(grouped.get(name) ?? []), row])
  }
  const rivesNames = unique(assignments.map(row => row.pointName))
  const results = new Map()
  for (const [name, rows] of grouped) {
    const base = {kind: 'POINT', names: [name], sources: rows.map(row => ({sheet: 'Points prélèvement', row: row.row})),
      supplyCategory: isCacgPoint(name) ? 'REALIMENTE' : 'NON_REALIMENTE'}
    if (overrides.points?.[name]?.skip) {
      results.set(name, {...base, status: 'EXCLUDED', method: 'REVIEWED_RETIREMENT', candidates: [], matchedNames: [], reason: 'REVIEWED_RETIREMENT'})
      continue
    }
    if (!isCacgPoint(name)) {
      results.set(name, {...base, status: 'EXCLUDED', method: 'NON_REALIMENTE', candidates: [], reason: 'NOT_ELIGIBLE_FOR_RIVES'})
      continue
    }
    const variants = cacgNameVariants(name)
    const serials = unique(rows.flatMap(row => clean(row.values[24]).split(';').map(clean)))
    const serialPlaces = unique(assignments.filter(row => serials.includes(row.serial)).map(row => row.lieuId))
    const sourceCoordinates = rows.map(row => coordinates(row.values[3], row.values[4])).filter(Boolean)
    const coordinatePlaces = lieux.filter(place => place.coordinates && sourceCoordinates.some(position => distanceMeters(position, place.coordinates) <= 5)).map(place => place.id)
    const codes = unique([...variants.map(variant => variant.split(/CACG/i)[0]), ...rows.map(row => clean(row.values[11]))])
    const codePlaces = lieux.filter(place => codes.includes(place.codeOU) || codes.includes(place.id)).map(place => place.id)
    const contractId = /CACG_([^\s]+)$/i.exec(name)?.[1]
    const contractPlaces = unique(assignments.filter(row => row.contractId === `CACG_${contractId}`).map(row => row.lieuId))
    const evidence = {variants, serials, serialPlaces, coordinatePlaces, codePlaces, contractPlaces}
    const tiers = [
      ['EXACT_NAME', assignments.filter(row => row.pointName === name)],
      ['CACG_SOURCE_VARIANT', assignments.filter(row => variants.includes(row.pointName))],
      ['CACG_BOTH_VARIANTS', assignments.filter(row => cacgNameVariants(row.pointName).some(key => variants.includes(key)))]
    ]
    let method = 'NO_MATCH'
    let candidates = []
    let matchedNames = []
    if (overrides.points?.[name]?.lieuId) {
      method = 'EXPLICIT_MAPPING'
      candidates = [String(overrides.points[name].lieuId)]
    } else {
      for (const [tier, matches] of tiers) {
        candidates = unique(matches.map(row => row.lieuId))
        if (candidates.length) {
          method = tier
          matchedNames = unique(matches.map(row => row.pointName))
          break
        }
      }
      if (!candidates.length && codePlaces.length) {
        method = 'CODE_OR_PLACE_WITH_EVIDENCE'
        candidates = unique(codePlaces)
      }
      if (!candidates.length && serialPlaces.length) {
        candidates = unique(serialPlaces.filter(id => coordinatePlaces.includes(id)))
        if (candidates.length) method = 'SERIAL_AND_COORDINATES'
      }
      if (!candidates.length && !serialPlaces.length && contractId) {
        candidates = unique(contractPlaces.filter(id => coordinatePlaces.includes(id)))
        if (candidates.length) method = 'CONTRACT_AND_COORDINATES'
      }
    }
    const knownPlace = candidates.length === 1 && lieux.some(place => place.id === candidates[0])
    const corroborated = candidates.length === 1 && (serialPlaces.includes(candidates[0]) || coordinatePlaces.includes(candidates[0]))
    const trustedName = ['EXACT_NAME', 'EXPLICIT_MAPPING'].includes(method)
    const contradictorySerial = !trustedName && candidates.length === 1 && serialPlaces.length > 0 && !serialPlaces.includes(candidates[0])
    const accepted = knownPlace && !contradictorySerial && (trustedName || corroborated)
    if (!matchedNames.length) matchedNames = rivesNames.filter(rivesName => assignments.some(row => row.pointName === rivesName && candidates.includes(row.lieuId)))
    results.set(name, {...base, method, candidates, evidence, matchedNames,
      status: accepted ? 'ACCEPTED' : candidates.length ? 'REVIEW' : 'UNMATCHED',
      reason: accepted ? null : candidates.length > 1 ? 'MULTIPLE_RIVES_PLACES'
        : contradictorySerial ? 'CONTRADICTORY_SERIAL_REFERENCE'
          : candidates.length && !knownPlace ? 'PLACE_MISSING_OR_CONFLICTING' : candidates.length ? 'CORROBORATION_MISSING' : 'NO_RIVES_MATCH'})
  }

  // A newly discovered alias must not make an already imported point disappear
  // by grouping two existing UUIDs before the identity ledger can check them.
  const refs = snapshot?.tables?.externalReferences ?? []
  const canonical = createImportAliasResolver(refs, {scope: 'epidropt', points: snapshot?.tables?.points})
  const sourceAnchors = name => unique([
    ...refs.filter(ref => ref.kind === 'POINT' && ref.provider === 'epidropt' && ref.externalId === name).map(ref => ref.pointPrelevementId),
    ...(previousManifest?.points ?? []).filter(point => point.references.some(ref => ref.provider === 'epidropt' && ref.externalId === name)).map(point => point.id)
  ].map(id => canonical.point(id)))
  const placeAnchors = lieuId => unique([
    ...refs.filter(ref => ref.kind === 'POINT' && ref.provider === 'rives-et-eaux' && ref.externalId === lieuId).map(ref => ref.pointPrelevementId),
    ...(previousManifest?.points ?? []).filter(point => point.references.some(ref => ref.provider === 'rives-et-eaux' && ref.externalId === lieuId)).map(point => point.id)
  ].map(id => canonical.point(id)))
  for (const lieuId of unique([...results.values()].filter(item => item.status === 'ACCEPTED').flatMap(item => item.candidates))) {
    const aliases = [...results.values()].filter(item => item.status === 'ACCEPTED' && item.candidates[0] === lieuId)
    let claimed
    let ids
    try {
      claimed = placeAnchors(lieuId)
      ids = unique([...claimed, ...aliases.flatMap(item => sourceAnchors(item.names[0]))])
    } catch (error) {
      if (!error.message.startsWith('IMPORT_ALIAS_')) throw error
      for (const item of aliases) {
        item.status = 'REVIEW'
        item.reason = error.message
      }
      continue
    }
    if (ids.length <= 1) continue
    for (const item of aliases) {
      const anchors = sourceAnchors(item.names[0])
      if (claimed.length === 1 && (!anchors.length || (anchors.length === 1 && anchors[0] === claimed[0]))) continue
      item.status = 'REVIEW'
      item.reason = 'EXISTING_POINT_IDENTITIES_COLLIDE'
      item.evidence.existingPointIds = ids
    }
  }
  return results
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
  const canonical = createImportAliasResolver(refs, {scope: 'epidropt', points: live.points, exploitations: live.exploitations})
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
      let ids
      let previousIds
      try {
        const resolve = id => kind === 'points' ? canonical.point(id) : id
        previousIds = unique(previous.map(item => resolve(item.id)))
        ids = unique([...matches.map(ref => ref[targetField]), ...sourceMatches.map(row => row[field]), ...previousLiveIds,
          ...(resolve(record.id) !== record.id ? [resolve(record.id)] : [])].map(resolve))
      } catch (error) {
        if (!error.message.startsWith('IMPORT_ALIAS_')) throw error
        blocked.add(record.id)
        result.issues.push({code: error.message, source: {kind, id: record.id}})
        continue
      }
      if (ids.length > 1 || previousIds.length > 1 || (kind !== 'points' && previous.length > 1)) {
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
      const id = ids[0] ?? record.id
      const anchor = previous.find(item => item.id === id) ?? previous[0]
      remapped.set(beforeId, id)
      for (const item of previous) remapped.set(item.id, id)
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
    let canonicalId
    try {
      canonicalId = canonical.exploitation(beforeId, record.sourceId)
    } catch (error) {
      if (!error.message.startsWith('IMPORT_ALIAS_')) throw error
      blocked.add(beforeId)
      result.issues.push({code: error.message, source: {kind: 'exploitations', id: beforeId}})
      continue
    }
    if (blocked.has(record.pointId) || blocked.has(record.declarantId)) {
      blocked.add(beforeId)
      result.issues.push({code: 'EXPLOITATION_IDENTITY_DEPENDENCY_CONFLICT', source: {id: beforeId}})
      continue
    }
    record.pointId = remapped.get(record.pointId) ?? record.pointId
    record.declarantId = remapped.get(record.declarantId) ?? record.declarantId
    const matchingPrevious = (previousManifest?.exploitations ?? []).filter(previous =>
      (remapped.get(previous.pointId) ?? previous.pointId) === record.pointId
      && (remapped.get(previous.declarantId) ?? previous.declarantId) === record.declarantId)
    let previous
    try {
      const anchors = new Map()
      for (const item of matchingPrevious) {
        const id = canonical.exploitation(item.id, item.sourceId)
        // Two historical records explicitly merged into one exploitation are a
        // single anchor. Prefer the surviving record and its import identity.
        if (!anchors.has(id) || item.id === id) anchors.set(id, {...item, id})
      }
      previous = [...anchors.values()]
    } catch (error) {
      if (!error.message.startsWith('IMPORT_ALIAS_')) throw error
      blocked.add(beforeId)
      result.issues.push({code: error.message, source: {kind: 'exploitations', id: beforeId}})
      continue
    }
    const siblings = result.exploitations.filter(item => (remapped.get(item.pointId) ?? item.pointId) === record.pointId
      && (remapped.get(item.declarantId) ?? item.declarantId) === record.declarantId)
    const exact = previous.filter(previous => clean(previous.countingCode) === clean(record.countingCode))
    const aliasAnchor = previous.find(previous => previous.id === canonicalId)
      ?? previous.find(previous => previous.id === beforeId)
    const anchor = aliasAnchor
      ?? (exact.length === 1 ? exact[0] : previous.length === 1 && siblings.length === 1 ? previous[0] : null)
    if (previous.some(previous => !previous.countingCode) && siblings.length > 1 && !anchor) {
      blocked.add(beforeId)
      result.issues.push({code: 'EXPLOITATION_LEGACY_CODE_AMBIGUOUS', source: {id: beforeId}})
      continue
    }
    let anchorId
    try {
      anchorId = anchor ? canonical.exploitation(anchor.id, anchor.sourceId) : canonicalId
      if (canonicalId !== beforeId && canonicalId !== anchorId) throw new Error('IMPORT_ALIAS_CONFLICT')
    } catch (error) {
      if (!error.message.startsWith('IMPORT_ALIAS_')) throw error
      blocked.add(beforeId)
      result.issues.push({code: error.message, source: {kind: 'exploitations', id: beforeId}})
      continue
    }
    const stored = (live.exploitations ?? []).filter(item => item.id === anchorId
      || (anchor?.sourceId && item.sourceId === anchor.sourceId)
      || (record.sourceId && item.sourceId === record.sourceId))
    if (unique(stored.map(item => item.id)).length > 1) {
      blocked.add(beforeId)
      result.issues.push({code: 'IDENTITY_LEDGER_CONFLICT', source: {kind: 'exploitations', id: beforeId}})
      continue
    }
    if (anchor) {
      record.id = anchorId
      record.key = anchor.key
      record.sourceId = anchor.sourceId
      record.previousCountingCode = anchor.countingCode ?? null
    }
    if (!anchor) record.id = canonicalId
    if (stored[0]) {
      record.id = stored[0].id
      record.sourceId = stored[0].sourceId ?? record.sourceId
    }
    remapped.set(beforeId, record.id)
    if (anchor) remapped.set(anchor.id, record.id)
    for (const item of matchingPrevious) {
      if (canonical.exploitation(item.id, item.sourceId) === record.id) remapped.set(item.id, record.id)
    }
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
