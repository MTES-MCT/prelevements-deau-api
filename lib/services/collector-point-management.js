import createHttpError from 'http-errors'
import {isDeepStrictEqual} from 'node:util'
import {prisma} from '../../db/prisma.js'
import {getZoneIdsForCoordinates, updatePointPrelevementById} from '../models/point-prelevement.js'
import {normalizeWaterBodyConnections} from '../validation/point-validation.js'
import {
  COLLECTOR_POINT_EDITABLE_FIELDS,
  validateCollectorPointChanges,
  validateCollectorPointManagement
} from '../validation/collector-point-management-validation.js'
import {exploitationAtDateWhere} from './exploitation-periods.js'
import {isSageSelectionBlocked, selectPointZones} from './zone-resource-types.js'
import {isDatabaseWriteConflict} from '../util/database-write-conflict.js'

const MANAGEMENT_SELECT = {
  pointManagementEnabled: true,
  pointManagementZones: {select: {zone: {select: {id: true, code: true, name: true, type: true}}}}
}

function configuration(record) {
  const zones = (record?.pointManagementZones ?? []).map(link => link.zone)
    .sort((left, right) => left.id.localeCompare(right.id))
  return {enabled: Boolean(record?.pointManagementEnabled), zoneIds: zones.map(zone => zone.id), zones}
}

async function findCollector(collecteurId, client) {
  return client.declarant.findFirst({
    where: {userId: collecteurId, declarantRole: 'COLLECTEUR', user: {role: 'DECLARANT', deletedAt: null}},
    select: MANAGEMENT_SELECT
  })
}

export async function getCollectorPointManagement(collecteurId, {client = prisma} = {}) {
  const collector = await findCollector(collecteurId, client)
  if (!collector) throw createHttpError(404, 'Collecteur introuvable.')
  return configuration(collector)
}

// All writes use this same lock, including habilitation revocation and creation.
async function lockCollector(client, collecteurId) {
  await client.$queryRaw`
    SELECT d."userId" FROM "Declarant" d JOIN "User" u ON u.id = d."userId"
    WHERE d."userId" = ${collecteurId}::uuid FOR UPDATE OF d, u
  `
}

export async function assertCollectorPointManagementEnabled(user, {client = prisma, lock = false} = {}) {
  if (user?.role !== 'DECLARANT' || !user.id) throw createHttpError(403, 'Droits insuffisants.')
  if (lock) await lockCollector(client, user.id)
  const collector = await findCollector(user.id, client)
  const management = configuration(collector)
  if (!management.enabled) throw createHttpError(403, 'La gestion des points n’est pas autorisée pour ce collecteur.')
  return management
}

export async function updateCollectorPointManagement(collecteurId, payload, {user, client = prisma} = {}) {
  if (user?.role !== 'ADMIN') throw createHttpError(403, 'Cette habilitation est réservée aux administrateurs.')
  const {enabled, zoneIds} = validateCollectorPointManagement(payload)
  return client.$transaction(async tx => {
    await lockCollector(tx, collecteurId)
    await getCollectorPointManagement(collecteurId, {client: tx})
    const count = await tx.zone.count({where: {id: {in: zoneIds}}})
    if (count !== zoneIds.length) throw createHttpError(400, 'Une zone sélectionnée est introuvable.')
    await tx.declarant.update({where: {userId: collecteurId}, data: {pointManagementEnabled: enabled}})
    await tx.collectorPointManagementZone.deleteMany({where: {collecteurUserId: collecteurId}})
    if (zoneIds.length) {
      await tx.collectorPointManagementZone.createMany({data: zoneIds.map(zoneId => ({collecteurUserId: collecteurId, zoneId}))})
    }
    return getCollectorPointManagement(collecteurId, {client: tx})
  })
}

export async function assertCollectorPointLocation(management, coordinates, waterBodyType, {client = prisma} = {}) {
  if (!management?.enabled) throw createHttpError(403, 'La gestion des points n’est pas autorisée.')
  const zoneIds = await getZoneIdsForCoordinates(coordinates, {waterBodyType, client})
  if (!zoneIds.some(id => management.zoneIds.includes(id))) {
    throw createHttpError(403, 'Le point doit être situé dans une zone autorisée pour ce collecteur.')
  }
  return zoneIds
}

// Two bulk queries, independent of the number of points. Only booleans leave
// this service; beneficiary identities and exceptional zone ids stay private.
export async function getCollectorPointStates(pointIds, {client = prisma, now = new Date()} = {}) {
  if (!pointIds.length) return new Map()
  const [points, candidates] = await Promise.all([
    client.pointPrelevement.findMany({
      where: {id: {in: pointIds}, deletedAt: null},
      select: {id: true, waterBodyType: true, zones: {select: {zoneId: true}},
        _count: {select: {declarants: {where: exploitationAtDateWhere(now)}}}}
    }),
    client.$queryRaw`
      SELECT p.id AS "pointId", z.id, z.type, z.code, z."managedResourceType"
      FROM "PointPrelevement" p JOIN "Zone" z ON ST_Intersects(p.coordinates, z.coordinates)
      WHERE p.id = ANY(${pointIds}::uuid[]) AND p."deletedAt" IS NULL
    `
  ])
  const byPoint = new Map()
  for (const candidate of candidates) {
    if (!byPoint.has(candidate.pointId)) byPoint.set(candidate.pointId, [])
    byPoint.get(candidate.pointId).push(candidate)
  }
  return new Map(points.map(point => {
    let canEditLocation = false
    try {
      const geographicIds = new Set(selectPointZones(byPoint.get(point.id) ?? [], point.waterBodyType).map(zone => zone.id))
      canEditLocation = point.zones.every(link => geographicIds.has(link.zoneId))
    } catch (error) {
      if (!isSageSelectionBlocked(error.data?.code)) throw error
    }
    return [point.id, {canEditLocation, isShared: point._count.declarants > 1}]
  }))
}

export async function getCollectorPointRights(user, pointIds, {client = prisma, now = new Date()} = {}) {
  const rights = new Map()
  if (user?.role !== 'DECLARANT' || !pointIds.length) return rights
  const collector = await findCollector(user.id, client)
  if (!collector?.pointManagementEnabled) return rights
  const delegated = await client.declarantPointPrelevement.findMany({
    where: {pointPrelevementId: {in: pointIds}, ...exploitationAtDateWhere(now),
      collecteurs: {some: {collecteurUserId: user.id}}},
    select: {pointPrelevementId: true}, distinct: ['pointPrelevementId']
  })
  const states = await getCollectorPointStates(delegated.map(row => row.pointPrelevementId), {client, now})
  for (const [pointId, state] of states) {
    rights.set(pointId, {
      canRead: true, canEdit: true, canEditUsageName: true, isAdmin: false, permissions: [],
      editScope: 'COLLECTOR', editableFields: [...COLLECTOR_POINT_EDITABLE_FIELDS], ...state
    })
  }
  return rights
}

async function lockCurrentDelegations(client, collecteurId, pointId, now) {
  return client.$queryRaw`
    SELECT e.id FROM "DeclarantPointPrelevement" e
    JOIN "DeclarantCollecteurExploitation" link ON link."exploitationId" = e.id
    WHERE e."pointPrelevementId" = ${pointId}::uuid AND link."collecteurUserId" = ${collecteurId}::uuid
      AND e.status IN ('EN_ACTIVITE', 'NON_RENSEIGNE')
      AND (e."startDate" IS NULL OR e."startDate" <= ${now})
      AND (e."endDate" IS NULL OR e."endDate" >= ${now})
    FOR SHARE OF e, link
  `
}

export async function updateCollectorPoint(pointId, payload, {user, client = prisma, now = new Date()} = {}) {
  const {expectedUpdatedAt, changes: validated} = validateCollectorPointChanges(payload)
  try {
    return await client.$transaction(async tx => {
      const management = await assertCollectorPointManagementEnabled(user, {client: tx, lock: true})
      const rows = await tx.$queryRaw`
        SELECT p.id, p."updatedAt", p.nature, p."waterBodyType", ST_AsGeoJSON(p.coordinates)::json AS coordinates
        FROM "PointPrelevement" p WHERE p.id = ${pointId}::uuid AND p."deletedAt" IS NULL FOR UPDATE
      `
      const point = rows[0]
      if (!point) throw createHttpError(404, 'Point de prélèvement introuvable.')
      if (!(await lockCurrentDelegations(tx, user.id, pointId, now)).length) {
        throw createHttpError(403, 'Vous ne suivez pas d’exploitation active sur ce point.')
      }
      if (new Date(point.updatedAt).getTime() !== new Date(expectedUpdatedAt).getTime()) {
        throw createHttpError(409, 'Ce point a été modifié depuis son ouverture. Rechargez la fiche avant de réessayer.')
      }
      const locationChanged = (Object.hasOwn(validated, 'coordinates') && !isDeepStrictEqual(validated.coordinates, point.coordinates))
        || (Object.hasOwn(validated, 'waterBodyType') && validated.waterBodyType !== point.waterBodyType)
      if (locationChanged) {
        const states = await getCollectorPointStates([pointId], {client: tx, now})
        if (!states.get(pointId)?.canEditLocation) {
          throw createHttpError(409, 'Ce point a des rattachements particuliers. Un agent doit modifier sa localisation ou son milieu.')
        }
        await assertCollectorPointLocation(management, validated.coordinates ?? point.coordinates,
          validated.waterBodyType ?? point.waterBodyType, {client: tx})
      }
      const changes = normalizeWaterBodyConnections(validated, point.nature)
      // Normalization may clear waterBodyIdentifier when leaving PLAN_EAU; it
      // remains a reserved technical identifier for collectors.
      delete changes.waterBodyIdentifier
      if (!locationChanged) {
        delete changes.coordinates
        delete changes.waterBodyType
      }
      return updatePointPrelevementById(pointId, changes, {client: tx})
    }, {isolationLevel: 'Serializable'})
  } catch (error) {
    if (isDatabaseWriteConflict(error)) throw createHttpError(409, 'Les droits ou la fiche ont changé. Rechargez la page avant de réessayer.')
    throw error
  }
}
