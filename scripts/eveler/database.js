import {randomUUID} from 'node:crypto'
import {selectPointZones} from '../../lib/services/zone-resource-types.js'
import {buildPlan} from './plan.js'

export async function readInventory(client, manifest) {
  const {point, preleveur, connector, serviceAccount} = manifest
  const {x, y} = point.coordinatesLambert93
  const query = async (sql, values = []) => (await client.query(sql, values)).rows
  const points = await query(`
    SELECT p.id, p.name, p."sourceId", p."waterBodyType", p."flowType", p."pointKind",
      p.nature, p."withdrawalType", p."isZre", p."deletedAt", p.identifiers,
      p."communeCode", p."communeName", p."usageName",
      ST_Distance(ST_Transform(p.coordinates, 2154), ST_SetSRID(ST_MakePoint($3, $4), 2154)) AS "coordinateDistance"
    FROM "PointPrelevement" p
    WHERE p."sourceId" = $1 OR lower(p.name) = lower($2) OR p.identifiers->>'DDT' = $5
    ORDER BY p.id`, [point.sourceId, point.name, x, y, point.identifiers.DDT])
  const users = await query(`
    SELECT u.id, lower(u.email::text) AS email, u.role, u."firstName", u."lastName", u."deletedAt",
      d."userId" AS "declarantUserId", d."socialReason", d.siret, d."declarantType", d."declarantRole", d."preleveurType"
    FROM "User" u LEFT JOIN "Declarant" d ON d."userId" = u.id
    WHERE u.email = $1::citext OR d.siret = $2 OR lower(d."socialReason") = lower($3)
    ORDER BY u.id`, [preleveur.email, preleveur.siret, preleveur.companyName])
  const [emailIdentity] = await query('SELECT * FROM "UserEmailIdentity" WHERE email = $1::citext', [preleveur.email])
  const [usage] = await query(`SELECT u.id, u.code, u.kind, u.label, u."parentId",
    parent.code AS "parentCode", parent.kind AS "parentKind"
    FROM "SandreWaterUse" u LEFT JOIN "SandreWaterUse" parent ON parent.id = u."parentId"
    WHERE u.code = $1`, [manifest.exploitation.usageCode])
  const zones = await query(`
    SELECT id, type, "managedResourceType" FROM "Zone"
    WHERE ST_Intersects(coordinates, ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 2154), 4326))
    ORDER BY id`, [x, y])
  const zoneIds = selectPointZones(zones, point.waterBodyType).map(zone => zone.id).sort()
  const pointId = points.length === 1 ? points[0].id : null
  const userId = users.length === 1 ? users[0].id : null
  const exploitations = await query(`
    SELECT id, "declarantUserId", "pointPrelevementId", status, "startDate", "endDate", "usageId", comment
    FROM "DeclarantPointPrelevement" WHERE "pointPrelevementId" = $1::uuid AND "declarantUserId" = $2::uuid
    ORDER BY id`, [pointId, userId])
  const exploitationId = exploitations.length === 1 ? exploitations[0].id : null
  const connectors = await query(`
    SELECT id, "declarantPointPrelevementId", "connectorType", "connectorParameters", rate
    FROM "DeclarantPointPrelevementConnector"
    WHERE ("declarantPointPrelevementId" = $1::uuid AND "connectorType" = 'eveler')
      OR ("connectorType" = 'eveler' AND "connectorParameters"->>'sourcePointId' = $2)
    ORDER BY id`, [exploitationId, connector.sourcePointId])
  const pointZones = (await query('SELECT "zoneId" FROM "PointPrelevementZone" WHERE "pointPrelevementId" = $1::uuid ORDER BY "zoneId"', [pointId])).map(row => row.zoneId)
  const declarantZones = (await query('SELECT "zoneId" FROM "DeclarantZone" WHERE "declarantUserId" = $1::uuid ORDER BY "zoneId"', [userId])).map(row => row.zoneId)
  const accounts = serviceAccount
    ? await query('SELECT id, name, "isActive", "deletedAt" FROM "ServiceAccount" WHERE id = $1::uuid', [serviceAccount.existingId])
    : []
  return {points, users, emailIdentity: emailIdentity ?? null, usage: usage ?? null, zones, zoneIds, exploitations, connectors, pointZones, declarantZones, accounts}
}

// Caller owns a SERIALIZABLE transaction and verifies the reviewed inventory before invoking this.
export async function applyPlan(client, manifest, inventory) {
  const plan = buildPlan(manifest, inventory)
  const {point, preleveur, connector} = manifest
  const pointId = plan.ids.pointId ?? randomUUID()
  const userId = plan.ids.userId ?? randomUUID()
  const exploitationId = plan.ids.exploitationId ?? randomUUID()
  if (plan.actions.includes('create-point')) {
    await client.query(`
      INSERT INTO "PointPrelevement" (id, name, "sourceId", identifiers, coordinates, "waterBodyType",
        "flowType", "pointKind", nature, "withdrawalType", "isZre", "communeCode", "communeName", "usageName", "updatedAt")
      VALUES ($1::uuid, $2, $3, $4::json, ST_Transform(ST_SetSRID(ST_MakePoint($5, $6), 2154), 4326),
        $7::"WaterBodyType", $8::"PointFlowType", $9::"PointKind", $10::"PointPrelevementNature",
        $11::"PrelevementType", $12, $13, $14, $15, now())`,
    [pointId, point.name, point.sourceId, JSON.stringify(point.identifiers), point.coordinatesLambert93.x,
      point.coordinatesLambert93.y, point.waterBodyType, point.flowType, point.pointKind, point.nature,
      point.withdrawalType, point.isZre, point.communeCode ?? null, point.communeName ?? null, inventory.usage.label])
  }
  if (plan.actions.includes('create-user')) {
    // User_sync_primary_email_identity claims the address atomically; never write its registry manually.
    await client.query(`INSERT INTO "User" (id, email, role, "firstName", "lastName", "updatedAt")
      VALUES ($1::uuid, $2::citext, 'DECLARANT', $3, $4, now())`,
    [userId, preleveur.email, preleveur.firstName, preleveur.lastName])
  }
  if (plan.actions.includes('create-preleveur-profile')) {
    await client.query(`INSERT INTO "Declarant" ("userId", "socialReason", siret, "declarantType", "declarantRole", "preleveurType")
      VALUES ($1::uuid, $2, $3, 'LEGAL_PERSON', 'PRELEVEUR', 'AUTRE')`, [userId, preleveur.companyName, preleveur.siret])
  }
  if (plan.actions.includes('create-exploitation')) {
    await client.query(`INSERT INTO "ExploitationIdentityLock" ("declarantUserId", "pointPrelevementId", revision)
      VALUES ($1::uuid, $2::uuid, 1) ON CONFLICT ("declarantUserId", "pointPrelevementId")
      DO UPDATE SET revision = "ExploitationIdentityLock".revision + 1`, [userId, pointId])
    await client.query(`INSERT INTO "DeclarantPointPrelevement" (id, "declarantUserId", "pointPrelevementId", status, "usageId", comment, "updatedAt")
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'EN_ACTIVITE', $4::uuid, $5, now())`,
    [exploitationId, userId, pointId, plan.usageResolution.primaryId, plan.usageResolution.comment])
  }
  if (plan.actions.includes('create-connector')) {
    await client.query(`INSERT INTO "DeclarantPointPrelevementConnector" (id, "declarantPointPrelevementId", "connectorType", "connectorParameters", rate, "updatedAt")
      VALUES ($1::uuid, $2::uuid, 'eveler', $3::json, $4, now())`,
    [randomUUID(), exploitationId, JSON.stringify({sourcePointId: connector.sourcePointId, sourceMeterId: connector.sourceMeterId, sourceStartDate: connector.sourceStartDate}), connector.rate])
  }
  for (const zoneId of plan.missingPointZones) {
    await client.query(`INSERT INTO "PointPrelevementZone" (id, "pointPrelevementId", "zoneId")
      VALUES ($1::uuid, $2::uuid, $3::uuid)`, [randomUUID(), pointId, zoneId])
  }
  for (const zoneId of plan.missingDeclarantZones) {
    await client.query(`INSERT INTO "DeclarantZone" (id, "declarantUserId", "zoneId", source, "updatedAt")
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'EXPLOITATION', now())`, [randomUUID(), userId, zoneId])
  }
  return plan
}
