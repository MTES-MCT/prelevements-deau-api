/* eslint-disable no-await-in-loop -- Bounded synthetic fixtures on a guarded disposable database. */
import {randomUUID} from 'node:crypto'
import process from 'node:process'
import express from 'express'
import request from 'supertest'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {createRoutes} from '../../routes.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {insertPointPrelevement, getPointPrelevement} from '../../models/point-prelevement.js'
import {createCollectorPoint} from '../collector-point-creation.js'
import {updateCollectorPointManagement} from '../collector-point-management.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
const prefix = `Collector test ${randomUUID()}`
const userIds = []
const zoneIds = []
let fixtureIndex = 0

test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => {
  if (enabled) {
    const meters = await prisma.compteur.findMany({where: {OR: [
      {serialNumber: {startsWith: prefix}},
      {meterAllocations: {some: {exploitation: {pointPrelevement: {name: {startsWith: prefix}}}}}}
    ]}, select: {id: true}})
    const compteurId = {in: meters.map(meter => meter.id)}
    await prisma.meterAllocationVersion.deleteMany({where: {allocation: {compteurId}}})
    await prisma.meterAllocation.deleteMany({where: {compteurId}})
    await prisma.compteur.deleteMany({where: {id: compteurId}})
    await prisma.pointPrelevement.deleteMany({where: {name: {startsWith: prefix}}})
    await prisma.user.deleteMany({where: {OR: [{id: {in: userIds}}, {firstName: prefix}]}})
    await prisma.zone.deleteMany({where: {id: {in: zoneIds}}})
  }
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

function appFor(user, {type = 'USER_SESSION', impersonation} = {}) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = user
    req.userRole = user.role
    req.auth = {type, role: user.role, user, impersonation}
    next()
  })
  app.use(createRoutes())
  app.use((error, _req, res, _next) => res.status(error.statusCode || error.status || 500)
    .json({message: error.message, code: error.code, details: error.details, meta: error.meta}))
  return app
}

async function actor(role, declarant) {
  const user = await prisma.user.create({data: {role, firstName: prefix,
    ...(declarant ? {declarant: {create: declarant}} : {})}})
  userIds.push(user.id)
  return user
}

async function zoneAt(longitude) {
  const id = randomUUID()
  zoneIds.push(id)
  const polygon = `POLYGON((${longitude - 0.4} -30.4,${longitude - 0.4} -29.6,${longitude + 0.4} -29.6,${longitude + 0.4} -30.4,${longitude - 0.4} -30.4))`
  await prisma.$executeRaw`INSERT INTO "Zone" (id, code, type, name, coordinates, "createdAt", "updatedAt")
    VALUES (${id}::uuid, ${id}, 'DEPARTEMENT', ${prefix}, ST_Multi(ST_GeomFromText(${polygon},4326)), now(), now())`
  return id
}

async function fixture() {
  const longitude = 50 + fixtureIndex++
  const [admin, collector, owner, outsider] = await Promise.all([
    actor('ADMIN'), actor('DECLARANT', {declarantRole: 'COLLECTEUR', quickDeclarationEnabled: false}),
    actor('DECLARANT', {preleveurType: 'IRRIGANT', quickDeclarationEnabled: false}),
    actor('DECLARANT', {preleveurType: 'IRRIGANT', socialReason: 'Bénéficiaire confidentiel'})
  ])
  const zoneId = await zoneAt(longitude)
  const coordinates = {type: 'Point', coordinates: [longitude, -30]}
  const point = await insertPointPrelevement({name: `${prefix} ${randomUUID()}`, coordinates,
    waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT', nature: 'PLAN_EAU',
    internalComment: 'Contenu interne confidentiel', waterBodyIdentifier: 'identifiant-reserve', collectionMode: 'EXTERNAL'})
  const usage = await prisma.sandreWaterUse.findFirstOrThrow({where: {kind: 'USAGE', code: '2'}})
  const exploitation = await prisma.declarantPointPrelevement.create({data: {
    declarantUserId: owner.id, pointPrelevementId: point.id, usageId: usage.id,
    status: 'EN_ACTIVITE', startDate: new Date('2020-01-01'), endDate: null,
    excludeFromQuickDeclaration: true, collecteurs: {create: {collecteurUserId: collector.id}}
  }})
  const f = {admin, collector, owner, outsider, zoneId, point, coordinates, usage, exploitation}
  f.app = appFor(collector)
  f.enable = () => updateCollectorPointManagement(collector.id, {enabled: true, zoneIds: [zoneId]}, {user: admin})
  return f
}

function creation(f, extra = {}) {
  return {requestId: randomUUID(), point: {
    name: `${prefix} ${randomUUID()}`, coordinates: f.coordinates,
    waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT', communeCode: '01015'
  }, preleveurId: f.owner.id, exploitation: {usageId: f.usage.id, status: 'EN_ACTIVITE'}, ...extra}
}

function newPreleveur(extra = {}) {
  return {declarantType: 'NATURAL_PERSON', preleveurType: 'IRRIGANT', firstName: prefix,
    lastName: 'Synthétique', ...extra}
}

const createPath = '/collecteurs/me/points-prelevement'
const pointPath = f => `/points-prelevement/${f.point.id}`
const managementPath = f => `/collecteurs/${f.collector.id}/point-management`

integration('habilitation admin, révocation et session humaine sont contrôlées par les vraies routes', async t => {
  const f = await fixture()
  t.false((await request(f.app).get('/collecteurs/me/point-management')).body.enabled)
  t.is((await request(f.app).post(createPath).send(creation(f))).status, 403)
  t.is((await request(f.app).patch(managementPath(f)).send({enabled: true, zoneIds: [f.zoneId]})).status, 403)
  t.is((await request(appFor(f.admin, {impersonation: {actor: {id: f.owner.id}}})).patch(managementPath(f)).send({enabled: true, zoneIds: [f.zoneId]})).status, 403)
  const enabledResult = await request(appFor(f.admin)).patch(managementPath(f)).send({enabled: true, zoneIds: [f.zoneId]})
  t.is(enabledResult.status, 200, JSON.stringify(enabledResult.body))
  t.true(enabledResult.body.enabled)
  const accountApp = appFor(f.collector, {type: 'SERVICE_ACCOUNT_IMPERSONATION'})
  t.is((await request(accountApp).post(createPath).send(creation(f))).status, 403)
  t.is((await request(accountApp).put(pointPath(f)).send({expectedUpdatedAt: f.point.updatedAt, usageName: 'Interdit'})).status, 403)
  t.is((await request(f.app).delete(pointPath(f))).status, 403)
  t.is((await request(appFor(f.admin)).patch(managementPath(f)).send({enabled: false, zoneIds: [f.zoneId]})).status, 200)
  t.is((await request(f.app).put(pointPath(f)).send({expectedUpdatedAt: f.point.updatedAt, usageName: 'Interdit'})).status, 403)
  const legacy = await request(f.app).patch(`${pointPath(f)}/usage-name`).send({usageName: 'Nom historique conservé'})
  t.is(legacy.status, 200, JSON.stringify(legacy.body))
  t.is(legacy.body.usageName, 'Nom historique conservé')
  t.false((await prisma.declarant.findUniqueOrThrow({where: {userId: f.collector.id}})).quickDeclarationEnabled)
  t.true((await prisma.declarantPointPrelevement.findUniqueOrThrow({where: {id: f.exploitation.id}})).excludeFromQuickDeclaration)
})

integration('création atomique avec préleveur existant, idempotence et refus de réutiliser la clé pour un autre contenu', async t => {
  const f = await fixture()
  await f.enable()
  const payload = creation(f)
  const first = await request(f.app).post(createPath).send(payload)
  t.is(first.status, 201, JSON.stringify(first.body))
  t.is(first.body.preleveurId, f.owner.id)
  t.is(first.body.point.communeName, 'Arboys en Bugey')
  t.true(first.body.point.right.canEdit)
  t.deepEqual(first.body.notification, {status: 'not_requested'})
  const persisted = await prisma.declarantPointPrelevement.findUniqueOrThrow({where: {id: first.body.exploitationId}, include: {collecteurs: true}})
  t.is(persisted.declarantUserId, f.owner.id)
  t.deepEqual(persisted.collecteurs.map(link => link.collecteurUserId), [f.collector.id])
  const replay = await request(f.app).post(createPath).send(payload)
  t.is(replay.status, 200, JSON.stringify(replay.body))
  t.is(replay.body.point.id, first.body.point.id)
  t.true(replay.body.replayed)
  t.is((await request(f.app).post(createPath).send({...payload, point: {...payload.point, usageName: 'Autre'}})).status, 409)
  t.is(await prisma.pointPrelevement.count({where: {name: payload.point.name}}), 1)
})

integration('double soumission concurrente produit un seul point et un seul préleveur sans email', async t => {
  const f = await fixture()
  await f.enable()
  const payload = creation(f, {preleveurId: undefined, preleveur: newPreleveur()})
  const responses = await Promise.all([request(f.app).post(createPath).send(payload), request(f.app).post(createPath).send(payload)])
  t.deepEqual(responses.map(result => result.status).sort(), [200, 201], JSON.stringify(responses.map(result => result.body)))
  t.is(responses[0].body.point.id, responses[1].body.point.id)
  t.is(responses[0].body.preleveurId, responses[1].body.preleveurId)
  t.is((await prisma.user.findUniqueOrThrow({where: {id: responses[0].body.preleveurId}})).email, null)
})

integration('un nom de point déjà pris renvoie un conflit sans divulgation et annule le nouveau préleveur', async t => {
  const f = await fixture()
  await f.enable()
  const hiddenPoint = await insertPointPrelevement({name: `${prefix} ${randomUUID()}`, coordinates: f.coordinates,
    waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'})
  const payload = creation(f, {preleveurId: undefined, preleveur: newPreleveur()})
  payload.point.name = hiddenPoint.name
  const before = {points: await prisma.pointPrelevement.count(), users: await prisma.user.count(), requests: await prisma.collectorPointCreationRequest.count()}
  const response = await request(f.app).post(createPath).send(payload)
  t.is(response.status, 409, JSON.stringify(response.body))
  t.is(response.body.message, 'Ce nom de point n’est pas disponible. Choisissez un autre nom.')
  t.false(JSON.stringify(response.body).includes(hiddenPoint.id))
  t.false(JSON.stringify(response.body).includes('PointPrelevement_name_key'))
  t.deepEqual({points: await prisma.pointPrelevement.count(), users: await prisma.user.count(), requests: await prisma.collectorPointCreationRequest.count()}, before)
})

integration('usage invalide et point hors zone annulent tout le graphe, pas de récupération d’un préleveur hors droits', async t => {
  const f = await fixture()
  await f.enable()
  const before = {points: await prisma.pointPrelevement.count(), users: await prisma.user.count(), requests: await prisma.collectorPointCreationRequest.count()}
  const invalidUsage = creation(f, {preleveurId: undefined, preleveur: newPreleveur(), exploitation: {usageId: randomUUID(), status: 'EN_ACTIVITE'}})
  const invalid = await request(f.app).post(createPath).send(invalidUsage)
  t.is(invalid.status, 400, JSON.stringify(invalid.body))
  t.deepEqual({points: await prisma.pointPrelevement.count(), users: await prisma.user.count(), requests: await prisma.collectorPointCreationRequest.count()}, before)
  const outside = creation(f)
  outside.point.coordinates = {type: 'Point', coordinates: [-130, 30]}
  t.is((await request(f.app).post(createPath).send(outside)).status, 403)
  t.is((await request(f.app).post(createPath).send(creation(f, {preleveurId: f.outsider.id}))).status, 403)
  t.deepEqual({points: await prisma.pointPrelevement.count(), users: await prisma.user.count(), requests: await prisma.collectorPointCreationRequest.count()}, before)
})

integration('identités email, alias et SIRET ne rattachent jamais silencieusement un autre compte', async t => {
  const f = await fixture()
  await f.enable()
  const suffix = randomUUID()
  const email = `${suffix}@example.com`
  const alias = `alias-${suffix}@example.com`
  await prisma.user.update({where: {id: f.outsider.id}, data: {email}})
  await prisma.userEmailAlias.create({data: {userId: f.outsider.id, email: alias}})
  await prisma.declarant.update({where: {userId: f.outsider.id}, data: {siret: '12345678901234'}})
  for (const identity of [{email}, {email: alias}, {siret: '12345678901234'}]) {
    const response = await request(f.app).post(createPath).send(creation(f, {preleveurId: undefined, preleveur: newPreleveur(identity)}))
    t.is(response.status, 409, JSON.stringify(response.body))
    t.false(JSON.stringify(response.body).includes(f.outsider.id))
  }
})

integration('deux créations concurrentes de la même identité n’en créent qu’une', async t => {
  const f = await fixture()
  await f.enable()
  const other = await actor('DECLARANT', {declarantRole: 'COLLECTEUR'})
  await updateCollectorPointManagement(other.id, {enabled: true, zoneIds: [f.zoneId]}, {user: f.admin})
  const email = `${randomUUID()}@example.com`
  const first = creation(f, {preleveurId: undefined, preleveur: newPreleveur({email})})
  const second = creation(f, {preleveurId: undefined, preleveur: newPreleveur({email})})
  const responses = await Promise.all([request(f.app).post(createPath).send(first), request(appFor(other)).post(createPath).send(second)])
  t.deepEqual(responses.map(result => result.status).sort(), [201, 409], JSON.stringify(responses.map(result => result.body)))
  t.is(await prisma.user.count({where: {email}}), 1)
  const siret = '12345678901235'
  const withSiret = () => creation(f, {preleveurId: undefined, preleveur: newPreleveur({siret})})
  const siretResponses = await Promise.all([request(f.app).post(createPath).send(withSiret()), request(appFor(other)).post(createPath).send(withSiret())])
  t.deepEqual(siretResponses.map(result => result.status).sort(), [201, 409], JSON.stringify(siretResponses.map(result => result.body)))
  t.is(await prisma.declarant.count({where: {siret}}), 1)
})

integration('une erreur d’envoi après commit ne recrée rien et le rejeu ne renvoie aucun email', async t => {
  const f = await fixture()
  await f.enable()
  const payload = creation(f, {preleveurId: undefined, preleveur: newPreleveur({email: `${randomUUID()}@example.com`}), notifyAccountCreation: true})
  let attempts = 0
  const options = {user: f.collector, notifyAccountCreation: async () => { attempts++; throw new Error('SMTP synthétique indisponible') }}
  const first = await createCollectorPoint(payload, options)
  t.is(first.notification.status, 'failed')
  const replay = await createCollectorPoint(payload, options)
  t.is(replay.point.id, first.point.id)
  t.is(replay.notification.status, 'failed')
  t.is(attempts, 1)
})

integration('édition partagée reste bornée aux champs autorisés et ne divulgue ni autres préleveurs ni commentaire interne', async t => {
  const f = await fixture()
  await f.enable()
  await prisma.declarantPointPrelevement.create({data: {declarantUserId: f.outsider.id,
    pointPrelevementId: f.point.id, usageId: f.usage.id, status: 'EN_ACTIVITE'}})
  const before = await request(f.app).get(pointPath(f))
  t.is(before.status, 200, JSON.stringify(before.body))
  t.true(before.body.right.isShared)
  t.true(before.body.right.canEdit)
  t.false(JSON.stringify(before.body).includes(f.outsider.id))
  t.false(JSON.stringify(before.body).includes('Contenu interne confidentiel'))
  for (const path of [`${pointPath(f)}/exploitations`, `/exploitations/${f.exploitation.id}`]) {
    const result = await request(f.app).get(path)
    t.is(result.status, 200, JSON.stringify(result.body))
    t.false(JSON.stringify(result.body).includes(f.outsider.id))
    t.false(JSON.stringify(result.body).includes('Contenu interne confidentiel'))
    t.false(JSON.stringify(result.body).includes('internalComment'))
  }
  for (const field of ['name', 'internalComment', 'flowType', 'pointKind', 'collectionMode']) {
    t.is((await request(f.app).put(pointPath(f)).send({expectedUpdatedAt: before.body.updatedAt, [field]: 'Interdit'})).status, 400)
  }
  const changed = await request(f.app).put(pointPath(f)).send({expectedUpdatedAt: before.body.updatedAt, usageName: 'Nom public corrigé', nature: 'COURS_EAU'})
  t.is(changed.status, 200, JSON.stringify(changed.body))
  t.false(JSON.stringify(changed.body).includes(f.outsider.id))
  t.is(changed.body.usageName, 'Nom public corrigé')
  const persisted = await getPointPrelevement(f.point.id)
  t.is(persisted.waterBodyIdentifier, null)
  t.is(persisted.internalComment, 'Contenu interne confidentiel')
  t.is(persisted.collectionMode, 'EXTERNAL')
  t.is((await request(f.app).put(pointPath(f)).send({expectedUpdatedAt: before.body.updatedAt, usageName: 'Écrasement'})).status, 409)
})

integration('coordonnées seules changent la version, le hors-zone est refusé et un rattachement exceptionnel est conservé', async t => {
  const f = await fixture()
  await f.enable()
  const movedCoordinates = {type: 'Point', coordinates: [f.coordinates.coordinates[0] + 0.1, -30]}
  const changed = await request(f.app).put(pointPath(f)).send({expectedUpdatedAt: f.point.updatedAt, coordinates: movedCoordinates})
  t.is(changed.status, 200, JSON.stringify(changed.body))
  t.not(new Date(changed.body.updatedAt).getTime(), f.point.updatedAt.getTime())
  t.deepEqual(changed.body.coordinates, movedCoordinates)
  const outside = await request(f.app).put(pointPath(f)).send({expectedUpdatedAt: changed.body.updatedAt, coordinates: {type: 'Point', coordinates: [-130, 30]}})
  t.is(outside.status, 403)
  const exception = await zoneAt(-110)
  await prisma.pointPrelevementZone.create({data: {pointPrelevementId: f.point.id, zoneId: exception}})
  const current = await request(f.app).get(pointPath(f))
  t.false(current.body.right.canEditLocation)
  t.is((await request(f.app).put(pointPath(f)).send({expectedUpdatedAt: current.body.updatedAt, waterBodyType: 'SOUTERRAIN'})).status, 409)
  const descriptive = await request(f.app).put(pointPath(f)).send({expectedUpdatedAt: current.body.updatedAt, comment: 'Observation autorisée'})
  t.is(descriptive.status, 200, JSON.stringify(descriptive.body))
  t.deepEqual((await prisma.pointPrelevementZone.findMany({where: {pointPrelevementId: f.point.id}})).map(link => link.zoneId).sort(), [f.zoneId, exception].sort())
})

integration('historique expiré et collecteur non rattaché ne donnent aucun droit d’édition', async t => {
  const f = await fixture()
  await f.enable()
  await prisma.declarantPointPrelevement.update({where: {id: f.exploitation.id}, data: {endDate: new Date('2001-01-01'), startDate: new Date('2000-01-01')}})
  const historical = await request(f.app).get(pointPath(f))
  t.is(historical.status, 200)
  t.false(historical.body.right.canEdit)
  t.is((await request(f.app).put(pointPath(f)).send({expectedUpdatedAt: f.point.updatedAt, usageName: 'Interdit'})).status, 403)
  const other = await actor('DECLARANT', {declarantRole: 'COLLECTEUR'})
  await updateCollectorPointManagement(other.id, {enabled: true, zoneIds: [f.zoneId]}, {user: f.admin})
  t.is((await request(appFor(other)).get(pointPath(f))).status, 403)
  t.is((await request(appFor(other)).put(pointPath(f)).send({expectedUpdatedAt: f.point.updatedAt, usageName: 'Interdit'})).status, 403)
})

integration('deux modifications concurrentes d’une même version ne s’écrasent pas', async t => {
  const f = await fixture()
  await f.enable()
  const secondCollector = await actor('DECLARANT', {declarantRole: 'COLLECTEUR'})
  await updateCollectorPointManagement(secondCollector.id, {enabled: true, zoneIds: [f.zoneId]}, {user: f.admin})
  await prisma.declarantCollecteurExploitation.create({data: {collecteurUserId: secondCollector.id, exploitationId: f.exploitation.id}})
  const responses = await Promise.all([
    request(f.app).put(pointPath(f)).send({expectedUpdatedAt: f.point.updatedAt, usageName: 'Première correction'}),
    request(appFor(secondCollector)).put(pointPath(f)).send({expectedUpdatedAt: f.point.updatedAt, usageName: 'Seconde correction'})
  ])
  t.deepEqual(responses.map(result => result.status).sort(), [200, 409], JSON.stringify(responses.map(result => result.body)))
  const successful = responses.find(response => response.status === 200)
  t.is((await getPointPrelevement(f.point.id)).usageName, successful.body.usageName)
})

const formPath = f => `/collecteurs/me/points-prelevement/${f.point.id}/form`

integration('formulaire composite crée puis corrige les cinq champs, avec création et rejeu des compteurs', async t => {
  const f = await fixture()
  await f.enable()
  const input = creation(f)
  Object.assign(input.point, {nature: 'PLAN_EAU', waterAgencyInternalIdentifier: '00012', waterBodyIdentifier: '00034', reservoirNominalVolume: 123.5})
  Object.assign(input.exploitation, {countingCode: 'COUNT-1', meters: [{serialNumber: `${prefix} N1`}, {serialNumber: `${prefix} N2`}]})
  const first = await request(f.app).post(createPath).send(input)
  t.is(first.status, 201, JSON.stringify(first.body))
  const replay = await request(f.app).post(createPath).send(input)
  t.is(replay.status, 200, JSON.stringify(replay.body))
  const path = `/collecteurs/me/points-prelevement/${first.body.point.id}/form`
  const before = await request(f.app).get(path)
  t.is(before.status, 200, JSON.stringify(before.body))
  t.true(before.body.point.right.canEdit)
  t.is(before.body.point.waterAgencyInternalIdentifier, '00012')
  t.is(before.body.point.waterBodyIdentifier, '00034')
  t.is(before.body.point.reservoirNominalVolume, 123.5)
  const exploitation = before.body.exploitations[0]
  t.is(exploitation.id, first.body.exploitationId)
  t.is(exploitation.preleveur.id, f.owner.id)
  t.is(exploitation.countingCode, 'COUNT-1')
  t.is(exploitation.meters.length, 2)
  t.true(exploitation.meters.every(meter => meter.capabilities.canEditSerialNumber))
  const [one, two] = exploitation.meters
  const patch = {expectedUpdatedAt: before.body.point.updatedAt,
    point: {waterAgencyInternalIdentifier: null, waterBodyIdentifier: '00056', reservoirNominalVolume: null},
    exploitations: [{id: exploitation.id, countingCode: 'COUNT-2', expectedCountingCode: 'COUNT-1', meters: [
      {id: one.id, expectedUpdatedAt: one.updatedAt, serialNumber: `${prefix} CORRECTED`},
      {id: two.id, expectedUpdatedAt: two.updatedAt, serialNumber: null},
      {serialNumber: `${prefix} N3`}
    ]}]}
  const updated = await request(f.app).patch(path).send(patch)
  t.is(updated.status, 200, JSON.stringify(updated.body))
  t.is(updated.body.point.waterAgencyInternalIdentifier, null)
  t.is(updated.body.point.waterBodyIdentifier, '00056')
  t.is(updated.body.point.reservoirNominalVolume, null)
  t.is(updated.body.exploitations[0].countingCode, 'COUNT-2')
  t.is(updated.body.exploitations[0].meters.length, 3)
  t.is(updated.body.exploitations[0].meters.find(meter => meter.id === two.id).serialNumber, null)
  t.is((await request(f.app).patch(path).send(patch)).status, 409)
  t.is(await prisma.meterAllocation.count({where: {exploitationId: exploitation.id}}), 3)
  const versions = await prisma.meterAllocationVersion.findMany({where: {allocation: {exploitationId: exploitation.id}}})
  t.true(versions.every(version => !version.enabled && version.percentage === null && version.startDate === null && version.endDate === null))
  t.is(await prisma.chunk.count({where: {exploitationId: exploitation.id}}), 0)
  t.is(await prisma.collectionResponse.count({where: {exploitationId: exploitation.id}}), 0)
  t.false(JSON.stringify(updated.body).includes('mutations'))
})

integration('une collision de série annule les changements du point, du comptage et les nouveaux compteurs', async t => {
  const f = await fixture()
  await f.enable()
  const reserved = await prisma.compteur.create({data: {serialNumber: `${prefix} RESERVED`, deletedAt: new Date()}})
  const before = (await request(f.app).get(formPath(f))).body
  const result = await request(f.app).patch(formPath(f)).send({expectedUpdatedAt: before.point.updatedAt,
    point: {waterAgencyInternalIdentifier: 'SHOULD-ROLLBACK'}, exploitations: [{id: f.exploitation.id,
      countingCode: 'NEW', expectedCountingCode: null,
      meters: [{serialNumber: `${prefix} AAA-ROLLBACK`}, {serialNumber: reserved.serialNumber.toLowerCase()}]}]})
  t.is(result.status, 409, JSON.stringify(result.body))
  const after = (await request(f.app).get(formPath(f))).body
  t.deepEqual(after, before)
  t.is(await prisma.compteur.count({where: {serialNumber: `${prefix} AAA-ROLLBACK`}}), 0)
  t.is(await prisma.meterAllocation.count({where: {exploitationId: f.exploitation.id}}), 0)
})

integration('formulaire restreint aux exploitations déléguées sans exposer les autres bénéficiaires', async t => {
  const f = await fixture()
  await f.enable()
  const outside = await prisma.declarantPointPrelevement.create({data: {pointPrelevementId: f.point.id,
    declarantUserId: f.outsider.id, usageId: f.usage.id, status: 'EN_ACTIVITE'}})
  const before = await request(f.app).get(formPath(f))
  t.is(before.status, 200, JSON.stringify(before.body))
  t.deepEqual(before.body.exploitations.map(row => row.id), [f.exploitation.id])
  t.true(before.body.point.right.isShared)
  t.false(JSON.stringify(before.body).includes(f.outsider.id))
  t.false(JSON.stringify(before.body).includes(outside.id))
  t.false(JSON.stringify(before.body).includes('Contenu interne confidentiel'))
  const refused = await request(f.app).patch(formPath(f)).send({expectedUpdatedAt: before.body.point.updatedAt,
    point: {waterAgencyInternalIdentifier: 'FORBIDDEN'},
    exploitations: [{id: outside.id, countingCode: 'CODE', expectedCountingCode: null}]})
  t.is(refused.status, 403)
  t.is((await request(f.app).put(`/exploitations/${f.exploitation.id}`).send({countingCode: 'CODE', expectedCountingCode: null})).status, 403)
  t.is((await request(appFor(f.collector, {type: 'SERVICE_ACCOUNT'})).get(formPath(f))).status, 403)
  await prisma.declarantCollecteurExploitation.deleteMany({where: {exploitationId: f.exploitation.id}})
  t.is((await request(f.app).get(formPath(f))).status, 403)
  t.is((await request(f.app).patch(formPath(f)).send({expectedUpdatedAt: before.body.point.updatedAt,
    point: {usageName: 'Denied'}})).status, 403)
  t.is((await getPointPrelevement(f.point.id)).waterAgencyInternalIdentifier, null)
})

integration('code comptage et compteur périmés refusent toute modification du formulaire', async t => {
  const f = await fixture()
  await f.enable()
  const initial = (await request(f.app).get(formPath(f))).body
  const created = await request(f.app).patch(formPath(f)).send({expectedUpdatedAt: initial.point.updatedAt,
    exploitations: [{id: f.exploitation.id, meters: [{serialNumber: `${prefix} STALE`}]}]})
  t.is(created.status, 200, JSON.stringify(created.body))
  const before = created.body
  const meter = before.exploitations[0].meters[0]
  for (const edit of [{countingCode: 'NEW', expectedCountingCode: 'STALE'},
    {meters: [{id: meter.id, expectedUpdatedAt: '2000-01-01T00:00:00.000Z', serialNumber: 'NEW'}]}]) {
    const result = await request(f.app).patch(formPath(f)).send({expectedUpdatedAt: before.point.updatedAt,
      point: {waterAgencyInternalIdentifier: 'SHOULD-ROLLBACK'}, exploitations: [{id: f.exploitation.id, ...edit}]})
    t.is(result.status, 409, JSON.stringify(result.body))
    t.deepEqual((await request(f.app).get(formPath(f))).body, before)
  }
  await prisma.declarant.update({where: {userId: f.collector.id}, data: {pointManagementEnabled: false}})
  t.is((await request(f.app).get(formPath(f))).status, 403)
})

integration('deux ajouts concurrents depuis la même version ne créent qu’un seul compteur', async t => {
  const f = await fixture()
  await f.enable()
  const before = (await request(f.app).get(formPath(f))).body
  const input = {expectedUpdatedAt: before.point.updatedAt, exploitations: [{id: f.exploitation.id,
    meters: [{serialNumber: `${prefix} RACE`}]}]}
  const replies = await Promise.all([request(f.app).patch(formPath(f)).send(input), request(f.app).patch(formPath(f)).send(input)])
  t.deepEqual(replies.map(reply => reply.status).sort(), [200, 409])
  t.is(await prisma.meterAllocation.count({where: {exploitationId: f.exploitation.id}}), 1)
})

integration('les comptages multiples restent distincts et les collisions SQL sont des conflits métier', async t => {
  const f = await fixture()
  await f.enable()
  await prisma.declarantPointPrelevement.update({where: {id: f.exploitation.id}, data: {countingCode: 'A'}})
  const second = await prisma.declarantPointPrelevement.create({data: {pointPrelevementId: f.point.id,
    declarantUserId: f.owner.id, countingCode: 'B', usageId: f.usage.id, status: 'EN_ACTIVITE',
    collecteurs: {create: {collecteurUserId: f.collector.id}}}})
  const before = (await request(f.app).get(formPath(f))).body
  t.is(before.exploitations.length, 2)
  const conflict = await request(f.app).patch(formPath(f)).send({expectedUpdatedAt: before.point.updatedAt,
    point: {waterAgencyInternalIdentifier: 'SHOULD-ROLLBACK'},
    exploitations: [{id: f.exploitation.id, countingCode: 'B', expectedCountingCode: 'A'}]})
  t.is(conflict.status, 409, JSON.stringify(conflict.body))
  t.deepEqual((await request(f.app).get(formPath(f))).body, before)
  const valid = await request(f.app).patch(formPath(f)).send({expectedUpdatedAt: before.point.updatedAt,
    exploitations: [{id: f.exploitation.id, countingCode: 'C', expectedCountingCode: 'A'}]})
  t.is(valid.status, 200, JSON.stringify(valid.body))
  t.is(valid.body.exploitations.find(row => row.id === second.id).countingCode, 'B')
  t.is(valid.body.exploitations.find(row => row.id === f.exploitation.id).countingCode, 'C')
})
