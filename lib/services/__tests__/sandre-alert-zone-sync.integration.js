import {randomUUID} from 'node:crypto'
import process from 'node:process'
import test from 'ava'

import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {createSandreZoneSnapshot} from '../sandre-alert-zones.js'
import {synchronizeSandreAlertZones} from '../sandre-alert-zone-sync.js'
import {getActiveZoneAssignmentsForUser} from '../zone-permissions.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
const departmentCode = '75'
const polygon = {
  type: 'Polygon',
  coordinates: [[
    [2, 48],
    [3, 48],
    [3, 49],
    [2, 49],
    [2, 48]
  ]]
}

test.before(() => {
  if (enabled) requireDisposableDatabase()
})

test.after.always(async () => {
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

function rawFeature(codeSandre, properties = {}) {
  return {
    type: 'Feature',
    geometry: polygon,
    properties: {
      CdZAS: codeSandre,
      LbZAS: 'Zone SANDRE synthétique',
      TypeZAS: 'SUP',
      StZAS: 'Validé',
      DateMajZAS: '2026-10-01',
      NumeroVersionZAS: 1,
      NumCircAdminBassin: 5,
      RessInfluenceeZAS: 1,
      CdDepartement: departmentCode,
      ...properties
    }
  }
}

async function synchronize(features) {
  const snapshot = createSandreZoneSnapshot(features, features.length, departmentCode)
  return synchronizeSandreAlertZones({
    departmentCodes: [departmentCode],
    fetchSnapshot: async () => snapshot,
    logger: {log() {}, error() {}, warn() {}}
  })
}

integration('le flux sans gid crée et actualise les zones sans changer leur UUID ni les droits de gestion', async t => {
  const numericCode = Number.parseInt(randomUUID().slice(0, 8), 16) + 1
  const codeSandre = String(numericCode)
  const newCode = numericCode + 1
  const codes = [codeSandre, String(newCode)]
  const managementZoneId = randomUUID()
  const instructorId = randomUUID()

  t.teardown(async () => {
    await prisma.sandreAlertZone.deleteMany({where: {codeSandre: {in: codes}}})
    await prisma.sandreAlertZoneSyncState.deleteMany({where: {departmentCode}})
    await prisma.user.deleteMany({where: {id: instructorId}})
    await prisma.zone.deleteMany({where: {id: managementZoneId}})
  })

  await prisma.$executeRaw`
    INSERT INTO "Zone" (id, code, type, name, coordinates, "updatedAt")
    VALUES (
      ${managementZoneId}::uuid,
      ${codeSandre},
      'SAGE'::"ZoneType",
      'Zone de gestion synthétique',
      ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(polygon)}), 4326)),
      NOW()
    )
  `
  const instructor = await prisma.user.create({
    data: {
      id: instructorId,
      role: 'INSTRUCTOR',
      instructor: {
        create: {
          instructorZones: {
            create: {
              zoneId: managementZoneId,
              startDate: new Date('2026-01-01T00:00:00Z'),
              permissions: {create: {permission: 'zone.detail.read'}}
            }
          }
        }
      }
    }
  })
  const managementZoneBefore = await prisma.zone.findUnique({where: {id: managementZoneId}})
  const assignmentsBefore = await getActiveZoneAssignmentsForUser(instructor)
  t.is(assignmentsBefore.length, 1)
  t.deepEqual(assignmentsBefore[0].permissions, ['zone.detail.read'])

  const legacy = await synchronize([rawFeature(codeSandre, {gid: 42})])
  t.is(legacy.successCount, 1)
  const original = await prisma.sandreAlertZone.findUnique({where: {codeSandre}})
  t.is(original.gid, 42)

  const modernFeatures = [
    rawFeature(numericCode, {LbZAS: 'Zone SANDRE actualisée'}),
    rawFeature(newCode)
  ]
  const modern = await synchronize(modernFeatures)
  t.is(modern.successCount, 1)
  t.is(modern.featureCount, 2)
  const updated = await prisma.sandreAlertZone.findUnique({where: {codeSandre}})
  t.is(updated.id, original.id)
  t.is(updated.codeSandre, original.codeSandre)
  t.is(updated.gid, null)
  t.is(updated.name, 'Zone SANDRE actualisée')
  t.deepEqual(updated.createdAt, original.createdAt)
  t.not(updated.payloadHash, original.payloadHash)

  const created = await prisma.sandreAlertZone.findUnique({where: {codeSandre: String(newCode)}})
  t.is(created.gid, null)
  t.not(created.id, original.id)
  const geometries = await prisma.$queryRaw`
    SELECT "codeSandre", ST_SRID(coordinates) AS srid,
      GeometryType(coordinates) AS type, ST_IsValid(coordinates) AS valid,
      ST_Equals(coordinates, ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(polygon)}), 4326)) AS equal
    FROM "SandreAlertZone"
    WHERE "codeSandre" IN (${codeSandre}, ${String(newCode)})
  `
  t.is(geometries.length, 2)
  t.true(geometries.every(row => row.srid === 4326 && row.type === 'MULTIPOLYGON' && row.valid && row.equal))

  await synchronize(modernFeatures)
  t.is(await prisma.sandreAlertZone.count({where: {codeSandre: {in: codes}}}), 2)
  t.is((await prisma.sandreAlertZone.findUnique({where: {codeSandre}})).id, original.id)
  t.deepEqual(await prisma.zone.findUnique({where: {id: managementZoneId}}), managementZoneBefore)
  t.deepEqual(await getActiveZoneAssignmentsForUser(instructor), assignmentsBefore)
})
