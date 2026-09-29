import {getZoneManagedResourceType, selectCompatibleSageZone} from '../../../lib/services/zone-resource-types.js'

function sortedZones(zones) {
  return zones.map(({id, type, code, name, managedResourceType}) => ({
    id, type, code, name, managedResourceType: getZoneManagedResourceType({type, managedResourceType})
  }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

export function planDroptPointZones({point, candidates, currentZones, refreshNonSageZones = false}) {
  const geometricZones = sortedZones(candidates)
  const before = sortedZones(currentZones)
  const {selectedSage, reason, compatibleCandidates} = selectCompatibleSageZone(geometricZones, point.waterBodyType)

  const nonSageZones = (refreshNonSageZones ? geometricZones : before).filter(zone => zone.type !== 'SAGE')
  const after = reason === 'SAGE_CANDIDATES_AMBIGUOUS'
    ? before
    : sortedZones([...nonSageZones, ...(selectedSage ? [selectedSage] : [])])
  const beforeIds = new Set(before.map(zone => zone.id))
  const afterIds = new Set(after.map(zone => zone.id))
  const removed = before.filter(zone => !afterIds.has(zone.id))
  const added = after.filter(zone => !beforeIds.has(zone.id))
  const untraceableRemovedSageLinks = removed.filter(zone => zone.type === 'SAGE')

  return {
    pointId: point.id,
    coordinates: point.coordinates,
    waterBodyType: point.waterBodyType,
    reason,
    candidates: geometricZones,
    compatibleCandidates,
    selectedSage: selectedSage ?? null,
    refreshNonSageZones,
    before,
    after,
    added,
    removed,
    // Existing links do not record whether an import or a person created them.
    // Never describe their removal as a proven correction of imported links.
    untraceableRemovedSageLinks,
    warnings: untraceableRemovedSageLinks.length ? ['REMOVED_SAGE_LINK_PROVENANCE_UNKNOWN'] : []
  }
}

export async function inspectDroptPointZones(client, pointId, {refreshNonSageZones = false} = {}) {
  // Read the actual stored values after managed updates, not the incoming file:
  // manually corrected coordinates and milieu must remain authoritative.
  const [stored] = await client.$queryRaw`
    SELECT id, "waterBodyType", ST_X(coordinates) AS x, ST_Y(coordinates) AS y
    FROM "PointPrelevement" WHERE id = ${pointId}::uuid
  `
  if (!stored) throw new Error('POINT_ABSENT')
  const candidates = await client.$queryRaw`
    SELECT z.id, z.type, z.code, z.name, z."managedResourceType"
    FROM "Zone" z JOIN "PointPrelevement" p ON p.id = ${pointId}::uuid
    WHERE ST_Intersects(z.coordinates, p.coordinates)
    ORDER BY z.id
  `
  const links = await client.pointPrelevementZone.findMany({where: {pointPrelevementId: pointId}, include: {zone: true}})
  return planDroptPointZones({
    point: {id: pointId, waterBodyType: stored.waterBodyType,
      coordinates: stored.x == null || stored.y == null ? null : [stored.x, stored.y]},
    candidates,
    currentZones: links.map(link => link.zone),
    refreshNonSageZones
  })
}

export async function synchronizeDroptPointZones(client, pointId, {refreshNonSageZones, changes, decisions}) {
  const decision = await inspectDroptPointZones(client, pointId, {refreshNonSageZones})
  decisions.push(decision)
  if (decision.reason === 'SAGE_CANDIDATES_AMBIGUOUS') throw new Error('SAGE_CANDIDATES_AMBIGUOUS')
  if (decision.removed.length) {
    await client.pointPrelevementZone.deleteMany({where: {
      pointPrelevementId: pointId, zoneId: {in: decision.removed.map(zone => zone.id)}
    }})
  }
  if (decision.added.length) {
    await client.pointPrelevementZone.createMany({
      data: decision.added.map(zone => ({pointPrelevementId: pointId, zoneId: zone.id})), skipDuplicates: true
    })
  }
  if (decision.removed.length || decision.added.length) {
    changes.push({kind: 'points', id: pointId, action: 'ZONES_UPDATED', before: decision.before, after: decision.after,
      reason: decision.reason, warnings: decision.warnings})
  }
  return decision
}
