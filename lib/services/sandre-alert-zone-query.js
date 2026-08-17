import {Prisma} from '@prisma/client'

import {prisma} from '../../db/prisma.js'

function getUuidListSql(ids) {
  return Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))
}

function getAccessiblePointTerritorySql({user, allowedZoneIds}) {
  if (user.role === 'ADMIN') {
    return Prisma.empty
  }

  return Prisma.sql`
    AND EXISTS (
      SELECT 1
      FROM "PointPrelevementZone" accessible_ppz
      WHERE accessible_ppz."pointPrelevementId" = accessible_point.id
        AND accessible_ppz."zoneId" IN (${getUuidListSql(allowedZoneIds)})
    )
  `
}

export function toSandreZoneOption(zone) {
  return {
    id: zone.id,
    code: zone.code,
    name: zone.name,
    type: zone.type,
    source: 'SANDRE_ZAS'
  }
}

export async function getAccessibleSandreZones({
  user,
  allowedZoneIds,
  sandreZoneIds,
  client = prisma
}) {
  if (user.role !== 'ADMIN' && allowedZoneIds.length === 0) {
    return []
  }

  if (Array.isArray(sandreZoneIds) && sandreZoneIds.length === 0) {
    return []
  }

  const idFilter = Array.isArray(sandreZoneIds)
    ? Prisma.sql`AND sandre_zone.id IN (${getUuidListSql(sandreZoneIds)})`
    : Prisma.empty
  const territoryFilter = getAccessiblePointTerritorySql({user, allowedZoneIds})

  const query = Prisma.sql`
    SELECT
      sandre_zone.id,
      sandre_zone."codeSandre" AS code,
      sandre_zone.name,
      sandre_zone.type::text AS type
    FROM "SandreAlertZone" sandre_zone
    WHERE sandre_zone.active = true
      AND sandre_zone.coordinates IS NOT NULL
      ${idFilter}
      AND EXISTS (
        SELECT 1
        FROM "PointPrelevement" accessible_point
        WHERE accessible_point."deletedAt" IS NULL
          AND accessible_point.coordinates IS NOT NULL
          AND ST_Covers(sandre_zone.coordinates, accessible_point.coordinates)
          ${territoryFilter}
      )
    ORDER BY sandre_zone.type ASC, sandre_zone.name ASC, sandre_zone."codeSandre" ASC
  `

  return client.$queryRaw(query)
}

export function getSandreZoneFilterSql(sandreZoneIds) {
  if (sandreZoneIds.length === 0) {
    return Prisma.empty
  }

  return Prisma.sql`
    AND EXISTS (
      SELECT 1
      FROM "SandreAlertZone" export_sandre_zone
      WHERE export_sandre_zone.id IN (${getUuidListSql(sandreZoneIds)})
        AND ST_Covers(export_sandre_zone.coordinates, p.coordinates)
    )
  `
}
