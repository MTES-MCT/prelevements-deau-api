import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import express from 'express'
import request from 'supertest'
import {prisma} from '../../../../db/prisma.js'
import {ingestMeterBatch} from '../../../../lib/services/meter-ingestion.js'
import {applyManifest, verifyManifest} from '../apply-epidropt.js'
import {digest, stableId} from '../epidropt.js'
import {requireDisposableDatabase} from '../../../../lib/util/test-helpers/disposable-database.js'
import {handlePoint} from '../../../../lib/resolvers.js'
import {authorizePointPrelevement} from '../../../../lib/auth/middleware.js'

const integration = process.env.DROPT_INTEGRATION_TESTS === '1' ? test.serial : test.skip
function fixtureRegistry() {
  return {points: new Set(), users: new Set(), exploitations: new Set(), meters: new Set(), zones: new Set(), accounts: new Set(), batches: new Set(), sources: new Set()}
}
const owned = fixtureRegistry()
let databaseValidated = false
test.before(() => {
  if (process.env.DROPT_INTEGRATION_TESTS !== '1') return
  requireDisposableDatabase()
  databaseValidated = true
})
async function cleanupFixtures(ids) {
  if (!databaseValidated) throw new Error('Nettoyage réservé à la base de tests explicitement vérifiée.')
  const compteurId = {in: [...ids.meters]}
  await prisma.$transaction(async tx => {
    const publications = await tx.meterPublication.findMany({where: {compteurId}, select: {sourceId: true}})
    await tx.meterVolumeContribution.deleteMany({where: {publication: {compteurId}}})
    await tx.meterPublication.deleteMany({where: {compteurId}})
    await tx.source.deleteMany({where: {id: {in: publications.map(row => row.sourceId)}}})
    await tx.source.deleteMany({where: {id: {in: [...ids.sources]}}})
    await tx.meterReading.updateMany({where: {compteurId}, data: {currentRevisionId: null}})
    // Test-only, transactional DDL: never commit a disabled immutability guard.
    // Only this transaction can observe the change while its table lock is held.
    await tx.$executeRawUnsafe('ALTER TABLE "MeterReadingRevision" DISABLE TRIGGER "MeterReadingRevision_immutable"')
    await tx.meterReadingRevision.deleteMany({where: {reading: {compteurId}}})
    await tx.$executeRawUnsafe('ALTER TABLE "MeterReadingRevision" ENABLE TRIGGER "MeterReadingRevision_immutable"')
    await tx.meterReading.deleteMany({where: {compteurId}})
    await tx.meterAllocationVersion.deleteMany({where: {allocation: {compteurId}}})
    await tx.meterAllocation.deleteMany({where: {compteurId}})
    await tx.meterStream.deleteMany({where: {compteurId}})
    await tx.meterIngestion.deleteMany({where: {provider: 'rives-et-eaux', scope: 'epidropt', batchId: {in: [...ids.batches]}}})
    await tx.externalReference.deleteMany({where: {OR: [{compteurId}, {pointPrelevementId: {in: [...ids.points]}}, {declarantUserId: {in: [...ids.users]}}]}})
    await tx.declarantPointPrelevement.deleteMany({where: {id: {in: [...ids.exploitations]}}})
    await tx.compteur.deleteMany({where: {id: compteurId}})
    await tx.pointPrelevement.deleteMany({where: {id: {in: [...ids.points]}}})
    await tx.user.deleteMany({where: {id: {in: [...ids.users]}}})
    await tx.zone.deleteMany({where: {id: {in: [...ids.zones]}}})
    await tx.serviceAccount.deleteMany({where: {id: {in: [...ids.accounts]}}})
  })
}

test.after.always(async () => {
  try {
    if (databaseValidated) await cleanupFixtures(owned)
  } finally {
    await prisma.$disconnect()
    await globalThis.pgPool?.end()
  }
})

function sign(manifest) {
  const {manifestHash, ...payload} = manifest
  return {...payload, manifestHash: digest(payload)}
}

function fixture() {
  const key = randomUUID()
  const pointId = stableId(`test-point:${key}`)
  const ownerId = stableId(`test-owner:${key}`)
  const exploitationId = stableId(`test-exploitation:${key}`)
  const compteurId = stableId(`test-meter:${key}`)
  owned.points.add(pointId)
  owned.users.add(ownerId)
  owned.exploitations.add(exploitationId)
  owned.meters.add(compteurId)
  const allocationSource = `dropt-test:allocation:${key}`
  const allocationSnapshot = [
    {key: allocationSource, contractId: key, lieuId: key, percentage: '70', inScope: true},
    {key: `external:${key}`, percentage: '30', inScope: false}
  ]
  return sign({formatVersion: 1, scope: 'epidropt', issues: [],
    points: [{id: pointId, key, sourceId: `dropt-test:point:${key}`, coordinates: [0.4, 44.6], references: [{provider: 'epidropt', externalId: key}],
      data: {name: `Dropt test ${key}`, flowType: 'PRELEVEMENT', waterBodyType: 'SUPERFICIELLE', locationDescription: 'Import initial'}}],
    declarants: [{id: ownerId, key, sourceId: `dropt-test:owner:${key}`, references: [{provider: 'epidropt', externalId: key}], emails: [`${key}@example.test`],
      user: {role: 'DECLARANT', email: null}, data: {socialReason: `Ferme ${key}`, preleveurType: 'IRRIGANT', declarationNotificationsEnabled: false}}],
    exploitations: [{id: exploitationId, sourceId: `dropt-test:exploitation:${key}`, pointId, declarantId: ownerId, usageCode: '2', aliases: []}],
    meters: [{id: compteurId, serial: key, provider: 'rives-et-eaux', references: [{provider: 'rives-et-eaux', externalId: key}], allocationSnapshot, allocationSnapshotValidated: true}],
    allocations: [{sourceId: allocationSource, compteurId, exploitationId, contractId: key, lieuId: key, percentage: '70', additive: false}]
  })
}

async function activate(manifest) {
  const account = await prisma.serviceAccount.create({data: {name: `Dropt test ${randomUUID()}`}})
  owned.accounts.add(account.id)
  const options = {apply: true, activateAt: '2026-07-01T00:00:00Z', serviceAccountId: account.id}
  const result = await applyManifest(prisma, manifest, options)
  return {account, options, result}
}

async function versions(manifest) {
  return prisma.meterAllocationVersion.findMany({where: {allocation: {compteurId: manifest.meters[0].id}}, orderBy: {version: 'asc'}})
}

async function ingest(manifest, account) {
  const batchId = randomUUID()
  owned.batches.add(batchId)
  return ingestMeterBatch({provider: 'rives-et-eaux', scope: 'epidropt', batchId, complete: true, mode: 'LIVE', fetchedAt: '2026-07-16T12:00:00Z',
    windowStart: '2026-07-01T00:00:00Z', windowEnd: '2026-07-16T00:00:00Z',
    readings: [100, 110, 120].map((index, position) => ({externalId: manifest.meters[0].serial,
      observedAt: `2026-07-0${position + 2}T00:00:00Z`, index: String(index), status: 'VALID', quality: 'A', origin: 'Auto'}))
  }, {serviceAccountId: account.id})
}

integration('dry-run laisse zéro objet, application et rejeu gardent exactement les identités et versions', async t => {
  const manifest = fixture()
  const dry = await applyManifest(prisma, manifest)
  t.deepEqual(dry.issues, [])
  t.false(dry.applied)
  t.is(await prisma.pointPrelevement.count({where: {id: manifest.points[0].id}}), 0)
  t.is(await prisma.user.count({where: {id: manifest.declarants[0].id}}), 0)
  t.is(await prisma.compteur.count({where: {id: manifest.meters[0].id}}), 0)
  t.is(await prisma.externalReference.count({where: {externalId: manifest.points[0].key}}), 0)
  const {options, result} = await activate(manifest)
  t.deepEqual(result.issues, [])
  const allocation = await prisma.meterAllocation.findUnique({where: {sourceId: manifest.allocations[0].sourceId}})
  t.deepEqual(allocation.metadata, {contractId: manifest.allocations[0].contractId, lieuId: manifest.allocations[0].lieuId})
  t.is(allocation.provider, 'rives-et-eaux')
  t.is(allocation.scope, 'epidropt')
  t.true((await prisma.meterStream.findFirst({where: {compteurId: manifest.meters[0].id}})).supersedeSameMeter)
  const initialVersions = await versions(manifest)
  const replay = await applyManifest(prisma, manifest, {...options, activateAt: '2026-09-17T08:00:00Z'})
  t.deepEqual(replay.objectIds, result.objectIds)
  t.deepEqual(replay.issues, [])
  t.deepEqual((await versions(manifest)).map(row => row.id), initialVersions.map(row => row.id))
  t.true((await verifyManifest(prisma, manifest, {report: result})).complete)
  const forged = structuredClone(result)
  forged.mappings.points[0].id = randomUUID()
  t.false((await verifyManifest(prisma, manifest, {report: forged})).complete)
})

integration('rejeu conserve changements manuels, rattachement de zone non-SAGE et désactivation du flux', async t => {
  const manifest = fixture()
  const {options} = await activate(manifest)
  const pointId = manifest.points[0].id
  const zoneId = randomUUID()
  owned.zones.add(zoneId)
  await prisma.$executeRaw`INSERT INTO "Zone" (id, code, type, name, coordinates, "updatedAt") VALUES (${zoneId}::uuid, ${zoneId}, 'REGION', 'Zone test manuelle', ST_GeomFromText('MULTIPOLYGON(((1 45,2 45,2 46,1 46,1 45)))',4326), now())`
  await prisma.pointPrelevementZone.create({data: {pointPrelevementId: pointId, zoneId}})
  await prisma.pointPrelevement.update({where: {id: pointId}, data: {locationDescription: 'Correction manuelle'}})
  await prisma.declarant.update({where: {userId: manifest.declarants[0].id}, data: {socialReason: 'Nom corrigé'}})
  await prisma.meterStream.updateMany({where: {compteurId: manifest.meters[0].id}, data: {enabled: false}})
  const initialVersions = await versions(manifest)
  t.deepEqual((await applyManifest(prisma, manifest, options)).issues, [])
  t.is((await prisma.pointPrelevement.findUnique({where: {id: pointId}})).locationDescription, 'Correction manuelle')
  t.is((await prisma.declarant.findUnique({where: {userId: manifest.declarants[0].id}})).socialReason, 'Nom corrigé')
  t.is(await prisma.pointPrelevementZone.count({where: {pointPrelevementId: pointId, zoneId}}), 1)
  t.false((await prisma.meterStream.findFirst({where: {compteurId: manifest.meters[0].id}})).enabled)
  t.deepEqual((await versions(manifest)).map(row => row.id), initialVersions.map(row => row.id))
  await prisma.$executeRaw`UPDATE "PointPrelevement" SET coordinates = ST_SetSRID(ST_MakePoint(0.7,44.7),4326) WHERE id = ${pointId}::uuid`
  t.deepEqual((await applyManifest(prisma, manifest, options)).issues, [])
  const [geometry] = await prisma.$queryRaw`SELECT ST_X(coordinates) AS x FROM "PointPrelevement" WHERE id = ${pointId}::uuid`
  t.is(geometry.x, 0.7)
})

integration('un ancien manifeste suit les alias PP et exploitations sans recréer les sources ni modifier les séries', async t => {
  const manifest = fixture()
  const initial = await applyManifest(prisma, manifest, {apply: true})
  t.true(initial.applied)
  const oldPointId = randomUUID()
  const oldExploitationId = randomUUID()
  const oldSourceId = `dropt-test:old:${oldPointId}`
  owned.points.add(oldPointId)
  owned.exploitations.add(oldExploitationId)
  await prisma.pointPrelevement.create({data: {id: oldPointId, name: `merged:${oldPointId}`, sourceId: oldSourceId,
    deletedAt: new Date(), waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'}})
  await prisma.externalReference.create({data: {provider: 'pe-import-alias', scope: 'epidropt', kind: 'POINT',
    externalId: oldPointId, pointPrelevementId: manifest.points[0].id, metadata: {exploitationAliases: [
      {sourceId: oldExploitationId, targetId: manifest.exploitations[0].id, sourceSourceId: `old:${oldExploitationId}`}
    ]}}})
  const old = structuredClone(manifest)
  old.points[0].id = oldPointId
  old.points[0].sourceId = oldSourceId
  old.exploitations[0].id = oldExploitationId
  old.exploitations[0].sourceId = `old:${oldExploitationId}`
  old.exploitations[0].pointId = oldPointId
  old.allocations[0].exploitationId = oldExploitationId
  const oldManifest = sign(old)
  const beforeVersions = await versions(manifest)
  const preview = await applyManifest(prisma, oldManifest)
  t.true(preview.complete)
  t.false(preview.applied)
  t.deepEqual(preview.objectIds, initial.objectIds)
  t.deepEqual(preview.changes, [])
  const replay = await applyManifest(prisma, oldManifest, {apply: true, expectedReport: preview})
  t.true(replay.applied)
  t.deepEqual(replay.changes, [])
  t.true((await verifyManifest(prisma, oldManifest, {report: replay})).complete)
  t.deepEqual(await versions(manifest), beforeVersions)
  t.is(await prisma.declarantPointPrelevement.count({where: {id: oldExploitationId}}), 0)
  t.truthy((await prisma.pointPrelevement.findUnique({where: {id: oldPointId}})).deletedAt)
})

integration('les anciennes URLs PP utilisent les droits de la cible canonique, jamais ceux du PP fusionné', async t => {
  const manifest = fixture()
  t.true((await applyManifest(prisma, manifest, {apply: true})).applied)
  const targetId = manifest.points[0].id
  const sourceId = randomUUID()
  const retiredId = randomUUID()
  const outsiderId = randomUUID()
  const sourceExploitationId = randomUUID()
  owned.points.add(sourceId)
  owned.points.add(retiredId)
  owned.users.add(outsiderId)
  owned.exploitations.add(sourceExploitationId)
  await prisma.pointPrelevement.createMany({data: [sourceId, retiredId].map(id => ({id, name: `merged:${id}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT', deletedAt: new Date()}))})
  await prisma.externalReference.createMany({data: [
    {provider: 'pe-import-alias', scope: 'epidropt', kind: 'POINT', externalId: sourceId, pointPrelevementId: targetId},
    {provider: 'pe-import-retired', scope: 'epidropt', kind: 'POINT', externalId: retiredId, pointPrelevementId: retiredId}
  ]})
  await prisma.user.create({data: {id: outsiderId, role: 'DECLARANT', declarant: {create: {socialReason: 'Préleveur test non autorisé', preleveurType: 'IRRIGANT'}}}})
  const usage = await prisma.sandreWaterUse.findUniqueOrThrow({where: {code: '2'}})
  // Even a stale link to the deleted source must not authorize the survivor.
  await prisma.declarantPointPrelevement.create({data: {id: sourceExploitationId, pointPrelevementId: sourceId, declarantUserId: outsiderId, usageId: usage.id}})
  const app = express()
  app.use((req, _res, next) => {
    req.user = {id: req.get('x-test-user') ?? outsiderId, role: 'DECLARANT'}
    next()
  })
  app.param('pointId', handlePoint)
  app.get('/points-prelevement/:pointId', authorizePointPrelevement(), (req, res) => res.json({id: req.point.id, parameter: req.params.pointId}))
  app.put('/points-prelevement/:pointId', authorizePointPrelevement('write'), (_req, res) => res.sendStatus(204))
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({message: error.message}))
  const ownerId = manifest.declarants[0].id
  const allowed = await request(app).get(`/points-prelevement/${sourceId}`).set('x-test-user', ownerId)
  t.is(allowed.status, 200)
  t.deepEqual(allowed.body, {id: targetId, parameter: targetId})
  t.is((await request(app).get(`/points-prelevement/${sourceId}`)).status, 403)
  t.is((await request(app).put(`/points-prelevement/${sourceId}`).set('x-test-user', ownerId)).status, 403)
  t.is((await request(app).get(`/points-prelevement/${retiredId}`).set('x-test-user', ownerId)).status, 404)
  await prisma.pointPrelevement.update({where: {id: targetId}, data: {deletedAt: new Date()}})
  t.is((await request(app).get(`/points-prelevement/${sourceId}`).set('x-test-user', ownerId)).status, 404)
})

integration('les SAGE suivent le milieu et les candidats PostGIS au rejeu, avec rollback et sans écraser les corrections manuelles', async t => {
  const input = fixture()
  input.points[0].coordinates = [0.95, 44.95]
  const manifest = sign(input)
  const pointId = manifest.points[0].id
  const zones = [
    {code: 'sage-SAGE05024', name: 'Dropt test', managedResourceType: 'MIXTE', minX: 0.9, maxX: 1},
    {code: 'sage-SAGE05003', name: 'Nappes profondes test', managedResourceType: 'SOUTERRAIN', minX: 0.94, maxX: 1.2},
    {code: 'sage-SAGE05009', name: 'Garonne test', managedResourceType: 'SUPERFICIELLE', minX: 1.02, maxX: 1.2}
  ].map(zone => ({...zone, id: randomUUID()}))
  for (const zone of zones) {
    owned.zones.add(zone.id)
    const geometry = `MULTIPOLYGON(((${zone.minX} 44.9,${zone.maxX} 44.9,${zone.maxX} 44.99,${zone.minX} 44.99,${zone.minX} 44.9)))`
    await prisma.$executeRaw`INSERT INTO "Zone" (id, code, type, name, "managedResourceType", coordinates, "updatedAt") VALUES (${zone.id}::uuid, ${zone.code}, 'SAGE', ${zone.name}, ${zone.managedResourceType}::"ZoneManagedResourceType", ST_GeomFromText(${geometry},4326), now())`
  }
  const [dropt, gironde, garonne] = zones
  const sageIds = async () => (await prisma.pointPrelevementZone.findMany({
    where: {pointPrelevementId: pointId, zone: {type: 'SAGE'}}, select: {zoneId: true}
  })).map(link => link.zoneId).sort()

  const preview = await applyManifest(prisma, manifest)
  t.true(preview.complete)
  t.is(await prisma.pointPrelevement.count({where: {id: pointId}}), 0)
  const result = await applyManifest(prisma, manifest, {apply: true, expectedReport: preview})
  t.true(result.applied)
  t.deepEqual(await sageIds(), [dropt.id])

  // Reproduce the former automatic double attachment without moving the point.
  await prisma.pointPrelevementZone.create({data: {pointPrelevementId: pointId, zoneId: gironde.id}})
  const replayPreview = await applyManifest(prisma, manifest)
  t.deepEqual(await sageIds(), [dropt.id, gironde.id].sort())
  t.is(replayPreview.pointZoneDecisions[0].untraceableRemovedSageLinks[0].id, gironde.id)
  t.true((await applyManifest(prisma, manifest, {apply: true, expectedReport: replayPreview})).complete)
  t.deepEqual(await sageIds(), [dropt.id])

  await prisma.pointPrelevement.update({where: {id: pointId}, data: {waterBodyType: 'SOUTERRAIN'}})
  t.true((await applyManifest(prisma, manifest, {apply: true})).complete)
  t.deepEqual(await sageIds(), [gironde.id])
  t.is((await prisma.pointPrelevement.findUnique({where: {id: pointId}})).waterBodyType, 'SOUTERRAIN')

  // A third candidate is not silently discarded and every write rolls back.
  const unknownId = randomUUID()
  owned.zones.add(unknownId)
  await prisma.$executeRaw`INSERT INTO "Zone" (id, code, type, name, "managedResourceType", coordinates, "updatedAt") VALUES (${unknownId}::uuid, ${unknownId}, 'SAGE', 'SAGE non arbitré', 'SOUTERRAIN', ST_GeomFromText('MULTIPOLYGON(((0.94 44.9,1 44.9,1 44.99,0.94 44.99,0.94 44.9)))',4326), now())`
  const rejected = await applyManifest(prisma, manifest, {apply: true})
  t.false(rejected.applied)
  t.true(rejected.executionIssues.some(issue => issue.code === 'SAGE_CANDIDATES_AMBIGUOUS'))
  t.deepEqual(await sageIds(), [gironde.id])

  // Groundwater outside Nappes profondes remains covered by mixed Dropt.
  await prisma.$executeRaw`UPDATE "PointPrelevement" SET coordinates = ST_SetSRID(ST_MakePoint(0.92,44.95),4326) WHERE id = ${pointId}::uuid`
  const mixedReplay = await applyManifest(prisma, manifest, {apply: true})
  t.true(mixedReplay.complete)
  t.deepEqual(await sageIds(), [dropt.id])
  t.is((await prisma.pointPrelevement.findUnique({where: {id: pointId}})).waterBodyType, 'SOUTERRAIN')

  // The actual manual coordinate now intersects Garonne + Gironde, not Dropt.
  await prisma.$executeRaw`UPDATE "PointPrelevement" SET coordinates = ST_SetSRID(ST_MakePoint(1.1,44.95),4326), "waterBodyType" = 'SUPERFICIELLE' WHERE id = ${pointId}::uuid`
  const garonneReplay = await applyManifest(prisma, manifest, {apply: true})
  t.true(garonneReplay.complete)
  t.is(garonneReplay.pointZoneDecisions[0].reason, 'SINGLE_COMPATIBLE_SAGE')
  t.deepEqual(await sageIds(), [garonne.id])
  t.deepEqual(garonneReplay.pointZoneDecisions[0].coordinates, [1.1, 44.95])
  t.true((await verifyManifest(prisma, manifest)).complete)

  // No polygon candidate: no forced assignment to either of the known SAGEs.
  await prisma.$executeRaw`UPDATE "PointPrelevement" SET coordinates = ST_SetSRID(ST_MakePoint(1.25,44.95),4326) WHERE id = ${pointId}::uuid`
  const outside = await applyManifest(prisma, manifest, {apply: true})
  t.true(outside.complete)
  t.is(outside.pointZoneDecisions[0].reason, 'NO_GEOMETRIC_SAGE')
  t.deepEqual(await sageIds(), [])
})

integration('référence stable rapproche un ID existant sans changer son sourceId ni ses champs manuels', async t => {
  const manifest = fixture()
  const existingId = randomUUID()
  owned.points.add(existingId)
  await prisma.pointPrelevement.create({data: {id: existingId, sourceId: `existing-manual:${existingId}`, ...manifest.points[0].data, locationDescription: 'Manuel'}})
  await prisma.externalReference.create({data: {provider: 'epidropt', scope: 'epidropt', kind: 'POINT', externalId: manifest.points[0].key, pointPrelevementId: existingId}})
  const result = await applyManifest(prisma, manifest, {apply: true})
  t.deepEqual(result.issues, [])
  t.deepEqual(result.objectIds.points, [existingId])
  t.is((await prisma.pointPrelevement.findUnique({where: {id: existingId}})).locationDescription, 'Manuel')
  t.true((await verifyManifest(prisma, manifest, {report: result})).complete)
  const collision = fixture()
  collision.points[0].data.name = manifest.points[0].data.name
  const rejected = await applyManifest(prisma, sign(collision), {apply: true})
  t.true(rejected.issues.some(issue => issue.code === 'NOM_POINT_EXISTANT_A_RAPPROCHER'))
  t.false(rejected.applied)
  t.false(rejected.complete)
  t.is(await prisma.pointPrelevement.count({where: {id: collision.points[0].id}}), 0)
  t.is(await prisma.user.count({where: {id: collision.declarants[0].id}}), 0)
  t.is(await prisma.compteur.count({where: {id: collision.meters[0].id}}), 0)
})

integration('code comptage enrichi sans changement d’identité et correction manuelle conservée au rejeu', async t => {
  const original = fixture()
  await applyManifest(prisma, original, {apply: true})
  const coded = structuredClone(original)
  coded.exploitations[0].countingCode = '001'
  const manifest = sign(coded)
  const preview = await applyManifest(prisma, manifest)
  t.true(preview.complete)
  t.true(preview.changes.some(change => change.field === 'countingCode' && change.after === '001'))
  const applied = await applyManifest(prisma, manifest, {apply: true, expectedReport: preview})
  t.true(applied.applied)
  t.deepEqual(applied.objectIds.exploitations, [original.exploitations[0].id])
  const replay = await applyManifest(prisma, manifest, {apply: true})
  t.true(replay.complete)
  t.deepEqual(replay.changes, [])
  await prisma.declarantPointPrelevement.update({where: {id: original.exploitations[0].id}, data: {countingCode: '002'}})
  const manual = await applyManifest(prisma, manifest, {apply: true})
  t.true(manual.complete)
  t.true(manual.changes.some(change => change.action === 'PRESERVED_MANUAL_VALUE'))
  t.is((await prisma.declarantPointPrelevement.findUnique({where: {id: original.exploitations[0].id}})).countingCode, '002')
})

function usageFixture(usageCode = '17') {
  const manifest = fixture()
  manifest.meters = []
  manifest.allocations = []
  manifest.exploitations[0].usageCode = usageCode
  return sign(manifest)
}

function withUsage(manifest, usageCode, previousUsageCode) {
  const incoming = structuredClone(manifest)
  Object.assign(incoming.exploitations[0], {usageCode, previousUsageCode})
  return sign(incoming)
}

integration('usage importé corrigé avec baseline : simulation, application et rejeu sans toucher les autres volumes', async t => {
  const unrelated = fixture()
  const {account} = await activate(unrelated)
  await ingest(unrelated, account)
  const existingPublications = await prisma.meterPublication.findMany({where: {compteurId: unrelated.meters[0].id}, orderBy: {id: 'asc'}})
  const existingChunks = await prisma.chunk.findMany({where: {exploitationId: unrelated.exploitations[0].id}, include: {chunkValues: {orderBy: {id: 'asc'}}}, orderBy: {id: 'asc'}})
  t.true(existingPublications.length > 0)
  const original = usageFixture()
  t.true((await applyManifest(prisma, original, {apply: true})).applied)
  const id = original.exploitations[0].id
  const before = await prisma.declarantPointPrelevement.findUniqueOrThrow({where: {id}})
  const usage = await prisma.sandreWaterUse.findUniqueOrThrow({where: {code: '7'}})
  const incoming = withUsage(original, '7', '17')
  const preview = await applyManifest(prisma, incoming)
  t.true(preview.complete)
  t.false(preview.applied)
  t.deepEqual(preview.changes, [{kind: 'exploitations', id, field: 'usageId', action: 'UPDATED',
    before: before.usageId, after: usage.id, beforeCode: '17', afterCode: '7', removedAutoSecondaryUsageId: before.usageId}])
  t.deepEqual(await prisma.declarantPointPrelevement.findUniqueOrThrow({where: {id}}), before)
  const applied = await applyManifest(prisma, incoming, {apply: true, expectedReport: preview})
  t.true(applied.applied)
  t.deepEqual(applied.objectIds.exploitations, [id])
  const after = await prisma.declarantPointPrelevement.findUniqueOrThrow({where: {id}})
  t.is(after.usageId, usage.id)
  t.deepEqual({...after, usageId: before.usageId, updatedAt: before.updatedAt}, before)
  t.is(await prisma.declarantPointPrelevementSecondaryUsage.count({where: {exploitationId: id}}), 0)
  const replay = await applyManifest(prisma, incoming, {apply: true})
  t.true(replay.applied)
  t.deepEqual(replay.changes, [])
  t.deepEqual(await prisma.declarantPointPrelevement.findUniqueOrThrow({where: {id}}), after)
  t.deepEqual(await prisma.meterPublication.findMany({where: {compteurId: unrelated.meters[0].id}, orderBy: {id: 'asc'}}), existingPublications)
  t.deepEqual(await prisma.chunk.findMany({where: {exploitationId: unrelated.exploitations[0].id}, include: {chunkValues: {orderBy: {id: 'asc'}}}, orderBy: {id: 'asc'}}), existingChunks)
})

integration('usage manuel ou baseline inconnue conservés sans modifier l’exploitation', async t => {
  for (const [currentCode, previousCode, action] of [
    ['4', '17', 'PRESERVED_MANUAL_VALUE'],
    ['17', undefined, 'PRESERVED_UNKNOWN_BASELINE'],
    ['17', 'missing-test-code', 'PRESERVED_UNKNOWN_BASELINE']
  ]) {
    const original = usageFixture(currentCode)
    t.true((await applyManifest(prisma, original, {apply: true})).applied)
    const id = original.exploitations[0].id
    const before = await prisma.declarantPointPrelevement.findUniqueOrThrow({where: {id}})
    const result = await applyManifest(prisma, withUsage(original, '7', previousCode), {apply: true})
    t.true(result.applied)
    t.true(result.changes.some(change => change.field === 'usageId' && change.action === action))
    t.deepEqual(await prisma.declarantPointPrelevement.findUniqueOrThrow({where: {id}}), before)
  }
})

integration('usage avec compteur : correction bloquée, publications et versions intégralement conservées', async t => {
  const original = fixture()
  const {account} = await activate(original)
  await ingest(original, account)
  const id = original.exploitations[0].id
  const before = await prisma.declarantPointPrelevement.findUniqueOrThrow({where: {id}})
  const beforeVersions = await versions(original)
  const publications = await prisma.meterPublication.findMany({where: {compteurId: original.meters[0].id}, include: {contributions: {orderBy: {id: 'asc'}}}, orderBy: {id: 'asc'}})
  const result = await applyManifest(prisma, withUsage(original, '7', '2'), {apply: true})
  t.false(result.applied)
  t.false(result.complete)
  t.true(result.executionIssues.some(issue => issue.code === 'USAGE_IMPORT_METER_REVIEW_REQUIRED'))
  t.deepEqual(await prisma.declarantPointPrelevement.findUniqueOrThrow({where: {id}}), before)
  t.deepEqual(await versions(original), beforeVersions)
  t.deepEqual(await prisma.meterPublication.findMany({where: {compteurId: original.meters[0].id}, include: {contributions: {orderBy: {id: 'asc'}}}, orderBy: {id: 'asc'}}), publications)
})

integration('usage avec déclaration, même sans lien exploitation historique : correction bloquée et données préservées', async t => {
  for (const legacy of [false, true]) {
    const original = usageFixture()
    t.true((await applyManifest(prisma, original, {apply: true})).applied)
    const id = original.exploitations[0].id
    const existing = await prisma.declarantPointPrelevement.findUniqueOrThrow({where: {id}})
    const source = await prisma.source.create({data: {type: 'API'}})
    owned.sources.add(source.id)
    const chunk = await prisma.chunk.create({data: {sourceId: source.id,
      pointPrelevementId: original.points[0].id, preleveurUserId: original.declarants[0].id,
      exploitationId: legacy ? null : id, usageId: existing.usageId,
      minDate: new Date('2026-01-01Z'), maxDate: new Date('2026-02-01Z'),
      chunkValues: {create: {metricTypeCode: 'volume', unit: 'm³', frequency: 'irregular',
        periodStart: new Date('2026-01-01Z'), periodEnd: new Date('2026-02-01Z'), valueKind: 'DECLARED', value: '123'}}
    }, include: {chunkValues: true}})
    const result = await applyManifest(prisma, withUsage(original, '7', '17'), {apply: true})
    t.false(result.applied)
    t.true(result.executionIssues.some(issue => issue.code === 'USAGE_IMPORT_DECLARATION_REVIEW_REQUIRED'))
    t.deepEqual(await prisma.declarantPointPrelevement.findUniqueOrThrow({where: {id}}), existing)
    t.deepEqual(await prisma.chunk.findUniqueOrThrow({where: {id: chunk.id}, include: {chunkValues: true}}), chunk)
  }
})

integration('usages secondaires et correction entre simulation et application sont protégés', async t => {
  const original = usageFixture()
  t.true((await applyManifest(prisma, original, {apply: true})).applied)
  const id = original.exploitations[0].id
  const before = await prisma.declarantPointPrelevement.findUniqueOrThrow({where: {id}})
  const incoming = withUsage(original, '7', '17')
  const preview = await applyManifest(prisma, incoming)
  const otherUsage = await prisma.sandreWaterUse.findUniqueOrThrow({where: {code: '4'}})
  await prisma.declarantPointPrelevement.update({where: {id}, data: {usageId: otherUsage.id}})
  const rejected = await applyManifest(prisma, incoming, {apply: true, expectedReport: preview})
  t.false(rejected.applied)
  t.true(rejected.executionIssues.some(issue => issue.code === 'DRY_RUN_STATE_CHANGED'))
  t.is((await prisma.declarantPointPrelevement.findUniqueOrThrow({where: {id}})).usageId, otherUsage.id)
  await prisma.declarantPointPrelevement.update({where: {id}, data: {usageId: before.usageId}})
  // The compatibility trigger keeps the manually selected real usage as a
  // secondary after restoring the primary. The import must leave it intact.
  t.is(await prisma.declarantPointPrelevementSecondaryUsage.count({where: {exploitationId: id, usageId: otherUsage.id}}), 1)
  const withSecondary = await applyManifest(prisma, incoming, {apply: true})
  t.false(withSecondary.applied)
  t.true(withSecondary.executionIssues.some(issue => issue.code === 'USAGE_IMPORT_SECONDARY_USAGES_REVIEW_REQUIRED'))
  t.is((await prisma.declarantPointPrelevement.findUniqueOrThrow({where: {id}})).usageId, before.usageId)
  t.is(await prisma.declarantPointPrelevementSecondaryUsage.count({where: {exploitationId: id, usageId: otherUsage.id}}), 1)
})

integration('une différence entre simulation et application annule le lot au lieu d’ignorer la dérive', async t => {
  const original = fixture()
  await applyManifest(prisma, original, {apply: true})
  const incoming = structuredClone(original)
  incoming.points[0].data.locationDescription = 'Correction importée'
  const manifest = sign(incoming)
  const preview = await applyManifest(prisma, manifest)
  t.true(preview.complete)
  await prisma.pointPrelevement.update({where: {id: original.points[0].id}, data: {locationDescription: 'Correction manuelle concurrente'}})
  const rejected = await applyManifest(prisma, manifest, {apply: true, expectedReport: preview})
  t.false(rejected.applied)
  t.false(rejected.complete)
  t.true(rejected.executionIssues.some(issue => issue.code === 'DRY_RUN_STATE_CHANGED'))
  t.is((await prisma.pointPrelevement.findUnique({where: {id: original.points[0].id}})).locationDescription, 'Correction manuelle concurrente')
})

integration('compteur non Rives et répartition incohérente restent importés mais désactivés', async t => {
  const manifest = fixture()
  manifest.meters[0].provider = 'epidropt'
  manifest.meters[0].references[0].provider = 'epidropt'
  const ordinary = sign(manifest)
  const {result} = await activate(ordinary)
  t.deepEqual(result.issues, [])
  t.is(await prisma.meterStream.count({where: {compteurId: ordinary.meters[0].id}}), 0)
  t.true((await versions(ordinary)).every(version => !version.enabled && version.percentage === null))
  const invalid = fixture()
  invalid.meters[0].allocationSnapshotValidated = false
  invalid.meters[0].allocationSnapshot[0].percentage = '-100'
  invalid.allocations[0].percentage = '-100'
  const bad = sign(invalid)
  t.deepEqual((await activate(bad)).result.issues, [])
  t.false((await prisma.meterStream.findFirst({where: {compteurId: bad.meters[0].id}})).enabled)
  t.true((await versions(bad)).every(version => !version.enabled && version.percentage === null))
})

integration('correction datée conserve snapshots historiques et volumes exacts sans renormaliser', async t => {
  const manifest = fixture()
  const {account} = await activate(manifest)
  await ingest(manifest, account)
  const correction = structuredClone(manifest)
  correction.meters[0].allocationSnapshot[0].percentage = '40'
  correction.meters[0].allocationSnapshot[1].percentage = '60'
  correction.allocations[0].percentage = '40'
  const revised = sign(correction)
  t.true((await applyManifest(prisma, revised, {apply: true})).issues.some(issue => issue.code === 'REPARTITION_MODIFIEE_NOUVELLE_VERSION_REQUISE'))
  const result = await applyManifest(prisma, revised, {apply: true, effectiveAt: '2026-07-03T00:00:00Z'})
  t.deepEqual(result.issues, [])
  const allocations = await versions(manifest)
  t.is(allocations.length, 2)
  t.true(allocations[0].enabled)
  t.is(allocations[0].endDate.toISOString(), '2026-07-03T00:00:00.000Z')
  t.is(allocations[0].metadata.allocationSnapshot[0].percentage, '70')
  const publications = await prisma.meterPublication.findMany({where: {compteurId: manifest.meters[0].id, active: true}, orderBy: {periodStart: 'asc'}})
  t.deepEqual(publications.map(row => row.inScopeVolume.toString()), ['7', '4'])
  t.deepEqual(publications.map(row => row.outOfScopeVolume.toString()), ['3', '6'])
  t.true(publications.every(row => row.physicalVolume.eq(row.inScopeVolume.add(row.outOfScopeVolume))))
  const ids = allocations.map(row => row.id)
  t.deepEqual((await applyManifest(prisma, revised, {apply: true, effectiveAt: '2026-07-03T00:00:00Z'})).issues, [])
  t.deepEqual((await versions(manifest)).map(row => row.id), ids)
})

integration('absence de mapping ne ferme rien ; snapshot explicite daté ferme sans supprimer les versions', async t => {
  const manifest = fixture()
  const {account} = await activate(manifest)
  await ingest(manifest, account)
  const absent = sign({...manifest, allocations: []})
  t.deepEqual((await applyManifest(prisma, absent, {apply: true})).issues, [])
  t.is((await versions(manifest))[0].endDate, null)
  const correction = structuredClone(absent)
  correction.meters[0].allocationSnapshot = [{key: 'entirely-external', percentage: '100', inScope: false}]
  const result = await applyManifest(prisma, sign(correction), {apply: true, effectiveAt: '2026-07-03T00:00:00Z'})
  t.deepEqual(result.issues, [])
  const rows = await versions(manifest)
  t.is(rows.length, 2)
  t.true(rows[0].enabled)
  t.false(rows[1].enabled)
  const publications = await prisma.meterPublication.findMany({where: {compteurId: manifest.meters[0].id, active: true}, orderBy: {periodStart: 'asc'}})
  t.deepEqual(publications.map(row => row.inScopeVolume.toString()), ['7', '0'])
  t.deepEqual(publications.map(row => row.outOfScopeVolume.toString()), ['3', '10'])
})

integration('les identifiants fournisseur restent des métadonnées immuables sur une affectation active', async t => {
  const manifest = fixture()
  const {options} = await activate(manifest)
  const altered = structuredClone(manifest)
  altered.allocations[0].contractId = randomUUID()
  const result = await applyManifest(prisma, sign(altered), options)
  t.true(result.issues.some(issue => issue.code === 'AFFECTATION_IDENTIFIANTS_DIFFERENTS'))
  const allocation = await prisma.meterAllocation.findUnique({where: {sourceId: manifest.allocations[0].sourceId}})
  t.is(allocation.metadata.contractId, manifest.allocations[0].contractId)
  t.is((await versions(manifest)).length, 1)
})

integration('nettoyage borné aux fixtures sans supprimer les données des autres suites', async t => {
  const ids = fixtureRegistry()
  const targetId = randomUUID()
  const unrelatedId = randomUUID()
  owned.points.add(targetId)
  owned.points.add(unrelatedId)
  ids.points.add(targetId)
  for (const id of [targetId, unrelatedId]) {
    await prisma.pointPrelevement.create({data: {id, name: `Cleanup test ${id}`, flowType: 'PRELEVEMENT', waterBodyType: 'SUPERFICIELLE'}})
  }
  await cleanupFixtures(ids)
  t.is(await prisma.pointPrelevement.count({where: {id: targetId}}), 0)
  t.is(await prisma.pointPrelevement.count({where: {id: unrelatedId}}), 1)
})

test('format et checksum du manifeste sont validés avant tout accès aux données', async t => {
  const manifest = fixture()
  await t.throwsAsync(applyManifest({}, {...manifest, manifestHash: 'invalid'}), {message: /Format/})
  await t.throwsAsync(applyManifest({}, {...manifest, points: []}), {message: /Empreinte/})
  await t.throwsAsync(verifyManifest({}, sign({...manifest, formatVersion: 2})), {message: /Format/})
  await t.throwsAsync(applyManifest({}, manifest, {effectiveAt: '2026-07-03'}), {message: /fuseau/})
})
