import {randomUUID} from 'node:crypto'
import process from 'node:process'
import test from 'ava'

import {prisma} from '../../../db/prisma.js'
import {createZoneResourceSettingsHandlers} from '../../handlers/zone-resource-settings.js'
import {ZONE_AGENT_MANAGEMENT_PERMISSIONS} from '../../constants/zone-permissions.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {createPointPrelevement, updatePointPrelevement} from '../point-prelevement.js'
import {getCoordsByPointIds} from '../../models/point-prelevement.js'

const integration = process.env.DROPT_INTEGRATION_TESTS === '1' ? test.serial : test.skip
const zones = []
const users = []
const points = []
let validated = false

test.before(() => {
  if (process.env.DROPT_INTEGRATION_TESTS !== '1') return
  requireDisposableDatabase()
  validated = true
})

test.after.always(async () => {
  try {
    if (validated) {
      await prisma.pointPrelevement.deleteMany({where: {id: {in: points}}})
      await prisma.user.deleteMany({where: {id: {in: users}}})
      await prisma.zone.deleteMany({where: {id: {in: zones}}})
    }
  } finally {
    await prisma.$disconnect()
    await globalThis.pgPool?.end()
  }
})

async function createZone(type = 'SAGE', managedResourceType = null) {
  const id = randomUUID()
  zones.push(id)
  await prisma.$executeRaw`
    INSERT INTO "Zone" (id, code, type, name, "managedResourceType", coordinates, "updatedAt")
    VALUES (${id}::uuid, ${id}, ${type}::"ZoneType", 'Zone synthétique', ${managedResourceType}::"ZoneManagedResourceType",
      ST_GeomFromText('MULTIPOLYGON(((9.9 49.9,10.1 49.9,10.1 50.1,9.9 50.1,9.9 49.9)))',4326), now())
  `
  return prisma.zone.findUnique({where: {id}})
}

function response() {
  return {body: null, set() { return this }, json(body) { this.body = body; return this }}
}

function req(user, zoneId, managedResourceType = 'SUPERFICIELLE') {
  return {user, auth: {type: 'USER_SESSION', user}, params: {zoneId}, body: {managedResourceType}}
}

integration('migration additive : défaut mixte seulement pour SAGE, mise à jour géographique préserve le choix PE', async t => {
  const sage = await createZone()
  const department = await createZone('DEPARTEMENT')
  t.is(sage.managedResourceType, 'MIXTE')
  t.is(department.managedResourceType, null)
  await prisma.zone.update({where: {id: sage.id}, data: {managedResourceType: 'TRANSITION'}})
  // Same shape as scripts/import-zones.js: no PE resource field in the update.
  await prisma.$executeRaw`
    INSERT INTO "Zone" (id, code, type, name, coordinates, "updatedAt")
    SELECT ${randomUUID()}::uuid, code, type, 'Nom géographique actualisé', coordinates, now()
    FROM "Zone" WHERE id = ${sage.id}::uuid
    ON CONFLICT (type, code) DO UPDATE SET name = EXCLUDED.name, coordinates = EXCLUDED.coordinates, "updatedAt" = now()
  `
  t.is((await prisma.zone.findUnique({where: {id: sage.id}})).managedResourceType, 'TRANSITION')
  // Remove these polygons from the following assignment scenarios only.
  await prisma.zone.deleteMany({where: {id: {in: [sage.id, department.id]}}})
})

integration('les droits de gestion réels et leur période active sont nécessaires au PATCH', async t => {
  const zone = await createZone()
  const user = await prisma.user.create({data: {role: 'INSTRUCTOR', email: `${randomUUID()}@example.test`, instructor: {create: {}}}})
  users.push(user.id)
  const right = await prisma.instructorZone.create({data: {
    instructorUserId: user.id, zoneId: zone.id, startDate: new Date('2020-01-01'),
    permissions: {create: ['zone.detail.read', ...ZONE_AGENT_MANAGEMENT_PERMISSIONS].map(permission => ({permission}))}
  }})
  const handlers = createZoneResourceSettingsHandlers()
  const res = response()
  await handlers.update(req(user, zone.id, 'SOUTERRAIN'), res)
  t.deepEqual(res.body, {data: {managedResourceType: 'SOUTERRAIN'}, canEdit: true})
  await prisma.instructorZonePermission.deleteMany({where: {instructorZoneId: right.id, permission: 'zone.agent.remove'}})
  t.is((await t.throwsAsync(handlers.update(req(user, zone.id), response()))).status, 403)
  t.is((await prisma.zone.findUnique({where: {id: zone.id}})).managedResourceType, 'SOUTERRAIN')
  await prisma.instructorZone.update({where: {id: right.id}, data: {endDate: new Date('2020-12-31')}})
  t.is((await t.throwsAsync(handlers.get(req(user, zone.id), response()))).status, 403)
  await prisma.zone.delete({where: {id: zone.id}})
})

integration('création et édition normales du PP sélectionnent un SAGE, modification du type SAGE seule ne réaffecte aucun point', async t => {
  const surface = await createZone('SAGE', 'SUPERFICIELLE')
  const groundwater = await createZone('SAGE', 'SOUTERRAIN')
  const department = await createZone('DEPARTEMENT')
  const admin = {id: randomUUID(), role: 'ADMIN'}
  const point = await createPointPrelevement({name: `Point synthétique ${randomUUID()}`, waterBodyType: 'SUPERFICIELLE',
    flowType: 'PRELEVEMENT', coordinates: {type: 'Point', coordinates: [10, 50]}}, {user: admin})
  points.push(point.id)
  const zoneIds = async () => (await prisma.pointPrelevementZone.findMany({where: {pointPrelevementId: point.id}})).map(link => link.zoneId).sort()
  t.deepEqual(await zoneIds(), [surface.id, department.id].sort())
  await updatePointPrelevement(point.id, {waterBodyType: 'SOUTERRAIN'}, {user: admin})
  t.deepEqual(await zoneIds(), [groundwater.id, department.id].sort())

  await createZoneResourceSettingsHandlers().update(req(admin, surface.id, 'MIXTE'), response())
  t.deepEqual(await zoneIds(), [groundwater.id, department.id].sort())
  await updatePointPrelevement(point.id, {comment: 'Le SAGE spécialisé reste prioritaire'}, {user: admin})
  t.deepEqual(await zoneIds(), [groundwater.id, department.id].sort())
  // Descriptive edits preserve existing attachments, even if the geographic
  // reference has become ambiguous since the point was last positioned.
  await createZone('SAGE', 'SOUTERRAIN')
  await updatePointPrelevement(point.id, {comment: 'Les rattachements existants sont conservés'}, {user: admin})
  t.deepEqual(await zoneIds(), [groundwater.id, department.id].sort())

  // A geographic or resource-type edit must still reject that ambiguity and
  // must not save any part of the accompanying descriptive changes.
  const locationError = await t.throwsAsync(updatePointPrelevement(point.id, {
    coordinates: {type: 'Point', coordinates: [10.01, 50]}, comment: 'Ne doit pas être commis'
  }, {user: admin}))
  t.is(locationError.status, 409)
  const resourceError = await t.throwsAsync(updatePointPrelevement(point.id, {
    waterBodyType: 'SOUTERRAIN', comment: 'Ne doit pas être commis'
  }, {user: admin}))
  t.is(resourceError.status, 409)
  t.is((await prisma.pointPrelevement.findUnique({where: {id: point.id}})).comment, 'Les rattachements existants sont conservés')
  t.deepEqual((await getCoordsByPointIds([point.id])).get(point.id), {type: 'Point', coordinates: [10, 50]})
  t.deepEqual(await zoneIds(), [groundwater.id, department.id].sort())
})
