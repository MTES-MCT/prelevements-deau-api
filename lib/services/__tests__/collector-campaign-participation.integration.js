import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import express from 'express'
import request from 'supertest'
import {prisma} from '../../../db/prisma.js'
import {createRoutes} from '../../routes.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {insertPointPrelevement} from '../../models/point-prelevement.js'
import {createCollectorPoint} from '../collector-point-creation.js'
import {getCollectorPointForm, updateCollectorPointForm} from '../collector-point-form.js'
import {addCollectorCampaignParticipation, getCollectorCampaignParticipationOptions} from '../collector-campaign-participation.js'
import {getAuthorizedCampaignResponseContext} from '../collection-campaigns.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
const prefix = `Enrollment ${randomUUID()}`
const campaigns = []
const zones = []
const now = new Date('2026-11-04T10:00:00Z')

test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => {
  if (enabled) {
    await prisma.collectionResponse.deleteMany({where: {campaignId: {in: campaigns}}})
    await prisma.collectionCampaign.deleteMany({where: {id: {in: campaigns}}})
    const meters = await prisma.compteur.findMany({where: {serialNumber: {startsWith: prefix}}, select: {id: true}})
    const compteurId = {in: meters.map(row => row.id)}
    await prisma.meterAllocationVersion.deleteMany({where: {allocation: {compteurId}}})
    await prisma.meterAllocation.deleteMany({where: {compteurId}})
    await prisma.compteur.deleteMany({where: {id: compteurId}})
    await prisma.pointPrelevement.deleteMany({where: {name: {startsWith: prefix}}})
    await prisma.user.deleteMany({where: {firstName: prefix}})
    await prisma.zone.deleteMany({where: {id: {in: zones}}})
  }
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

async function actor(role, declarant) {
  return prisma.user.create({data: {role, firstName: prefix, ...(declarant ? {declarant: {create: declarant}} : {})}})
}

async function fixture() {
  const zoneId = randomUUID()
  zones.push(zoneId)
  await prisma.$executeRaw`INSERT INTO "Zone" (id, code, type, name, coordinates, "createdAt", "updatedAt")
    VALUES (${zoneId}::uuid, ${zoneId}, 'DEPARTEMENT', ${prefix},
      ST_Multi(ST_GeomFromText('POLYGON((51.6 -30.4,51.6 -29.6,52.4 -29.6,52.4 -30.4,51.6 -30.4))',4326)), now(), now())`
  const admin = await actor('ADMIN')
  const collector = await actor('DECLARANT', {declarantRole: 'COLLECTEUR', pointManagementEnabled: true,
    pointManagementZones: {create: {zoneId}}})
  const owner = await actor('DECLARANT', {declarantRole: 'PRELEVEUR', preleveurType: 'IRRIGANT', quickDeclarationEnabled: true})
  const outsider = await actor('DECLARANT', {declarantRole: 'COLLECTEUR', pointManagementEnabled: true})
  const usage = await prisma.sandreWaterUse.findFirstOrThrow({where: {kind: 'USAGE', code: '2'}})
  const coordinates = {type: 'Point', coordinates: [52, -30]}
  const point = await insertPointPrelevement({name: `${prefix} ${randomUUID()}`, coordinates, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'})
  const exploitation = await prisma.declarantPointPrelevement.create({data: {
    declarantUserId: owner.id, pointPrelevementId: point.id, usageId: usage.id, status: 'EN_ACTIVITE',
    excludeFromQuickDeclaration: true, collecteurs: {create: {collecteurUserId: collector.id}}
  }})
  const campaign = await prisma.collectionCampaign.create({data: {
    name: `${prefix} campagne`, collecteurUserId: collector.id, createdByUserId: admin.id,
    status: 'OPEN', opensOn: new Date('2020-01-01Z'), closesOn: new Date('2099-12-31Z')
  }})
  campaigns.push(campaign.id)
  return {collector, admin, owner, outsider, usage, coordinates, point, exploitation, campaign}
}

function creation(f) {
  return {requestId: randomUUID(), preleveurId: f.owner.id, campaignId: f.campaign.id,
    point: {name: `${prefix} ${randomUUID()}`, coordinates: f.coordinates, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'},
    exploitation: {status: 'EN_ACTIVITE', usageId: f.usage.id}}
}

function appFor(user, type = 'USER_SESSION') {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.user = user; req.userRole = user.role; req.auth = {type, role: user.role, user}; next() })
  const routes = createRoutes()
  app.use('/', routes)
  app.use('/api', routes)
  app.use((error, _req, res, _next) => res.status(error.status || error.statusCode || 500).json({message: error.message, data: error.data}))
  return app
}

integration('opt-in commits the complete graph, exposes the response and replays after campaign closure', async t => {
  const f = await fixture()
  const input = creation(f)
  input.exploitation.meters = [{serialNumber: `${prefix} ${randomUUID()}`}]
  const audits = []
  const options = {user: f.collector, now, onCreated: ({mutations}) => audits.push(...mutations)}
  const result = await createCollectorPoint(input, options)
  const responseId = result.campaignParticipation.responseId
  const stored = await prisma.collectionResponse.findUniqueOrThrow({where: {id: responseId}})
  t.is(stored.exploitationId, result.exploitationId)
  t.is(stored.preleveurUserId, f.owner.id)
  t.is(stored.revision, 0)
  t.is(stored.draftData, null)
  t.is(stored.submittedData, null)
  const context = await getAuthorizedCampaignResponseContext(f.owner, f.campaign.id, responseId)
  t.true(context.permissions.canSubmit)
  t.is(context.meters.length, 1)
  t.deepEqual(context.blockers, [])
  await prisma.collectionCampaign.update({where: {id: f.campaign.id}, data: {closedAt: now}})
  const replay = await createCollectorPoint(input, options)
  t.deepEqual(replay, {...result, replayed: true})
  t.is(audits.filter(row => row.entityType === 'COLLECTION_RESPONSE').length, 1)
  t.is(await prisma.collectionResponse.count({where: {campaignId: f.campaign.id}}), 1)
  await prisma.declarantCollecteurExploitation.deleteMany({where: {collecteurUserId: f.collector.id, exploitationId: result.exploitationId}})
  t.is((await t.throwsAsync(createCollectorPoint(input, options))).status, 403)
})

integration('enrollment refusal rolls back new account, point, meters and creation request', async t => {
  const f = await fixture()
  const input = creation(f)
  delete input.preleveurId
  input.preleveur = {firstName: prefix, lastName: randomUUID(), preleveurType: 'IRRIGANT'}
  input.point.flowType = 'REJET'
  input.exploitation.meters = [{serialNumber: `${prefix} ${randomUUID()}`}]
  const audits = []
  const error = await t.throwsAsync(createCollectorPoint(input, {user: f.collector, now, onCreated: event => audits.push(event)}))
  t.is(error.data.code, 'CAMPAIGN_EXPLOITATION_INELIGIBLE')
  t.is(await prisma.pointPrelevement.count({where: {name: input.point.name}}), 0)
  t.is(await prisma.user.count({where: {firstName: prefix, lastName: input.preleveur.lastName}}), 0)
  t.is(await prisma.compteur.count({where: {serialNumber: input.exploitation.meters[0].serialNumber}}), 0)
  t.is(await prisma.collectorPointCreationRequest.count({where: {collecteurUserId: f.collector.id, requestId: input.requestId}}), 0)
  t.is(audits.length, 0)
  delete input.campaignId
  t.truthy((await createCollectorPoint(input, {user: f.collector, now})).point.id)
})

integration('concurrent enrollment is idempotent and retry preserves a started response after closure', async t => {
  const f = await fixture()
  const audits = []
  const enroll = () => addCollectorCampaignParticipation(f.collector, f.campaign.id, {exploitationId: f.exploitation.id},
    {now, onAdded: mutation => audits.push(mutation)})
  const results = await Promise.all([enroll(), enroll()])
  t.is(new Set(results.map(result => result.campaignParticipation.responseId)).size, 1)
  t.is(results.filter(result => result.campaignParticipation.created).length, 1)
  t.is(audits.length, 1)
  const responseId = results[0].campaignParticipation.responseId
  await prisma.collectionResponse.update({where: {id: responseId}, data: {revision: 3,
    draftData: {comment: 'Brouillon conservé'}, submittedData: {comment: 'Envoi conservé'}, firstSubmittedAt: now, lastSubmittedAt: now, publicationStatus: 'PUBLISHED'}})
  await prisma.collectionCampaign.update({where: {id: f.campaign.id}, data: {closedAt: now}})
  const before = await prisma.collectionResponse.findUniqueOrThrow({where: {id: responseId}})
  t.false((await enroll()).campaignParticipation.created)
  t.deepEqual(await prisma.collectionResponse.findUniqueOrThrow({where: {id: responseId}}), before)
  t.is(audits.length, 1)
  await prisma.declarant.update({where: {userId: f.collector.id}, data: {pointManagementEnabled: false}})
  t.is((await t.throwsAsync(enroll())).status, 403)
})

integration('options and writes deny disabled manual entry, outsiders and revoked delegations', async t => {
  const f = await fixture()
  await prisma.declarant.update({where: {userId: f.owner.id}, data: {quickDeclarationEnabled: false}})
  const options = await getCollectorCampaignParticipationOptions(f.collector, {exploitationId: f.exploitation.id}, {now})
  t.false(options.campaigns[0].eligible)
  const enroll = () => addCollectorCampaignParticipation(f.collector, f.campaign.id, {exploitationId: f.exploitation.id}, {now})
  t.is((await t.throwsAsync(enroll())).data.code, 'CAMPAIGN_EXPLOITATION_INELIGIBLE')
  t.is((await t.throwsAsync(addCollectorCampaignParticipation(f.outsider, f.campaign.id, {exploitationId: f.exploitation.id}, {now}))).status, 404)
  await prisma.declarantCollecteurExploitation.deleteMany({where: {collecteurUserId: f.collector.id, exploitationId: f.exploitation.id}})
  t.is((await t.throwsAsync(enroll())).status, 404)
  t.is((await t.throwsAsync(getCollectorCampaignParticipationOptions(f.collector, {exploitationId: f.exploitation.id}, {now}))).status, 404)
  t.is(await prisma.collectionResponse.count({where: {campaignId: f.campaign.id}}), 0)
})

integration('HTTP endpoints retain human-session guards and the API alias', async t => {
  const f = await fixture()
  const path = `/campaigns/${f.campaign.id}/responses`
  const body = {exploitationId: f.exploitation.id}
  t.is((await request(appFor(f.collector, 'SERVICE_ACCOUNT_ACCESS')).post(path).send(body)).status, 403)
  const app = appFor(f.collector)
  t.is((await request(app).get('/api/collecteurs/me/campaign-participation-options')).status, 200)
  const first = await request(app).post(`/api${path}`).send(body)
  t.is(first.status, 201)
  t.true(first.body.campaignParticipation.created)
  const second = await request(app).post(path).send(body)
  t.is(second.status, 200)
  t.false(second.body.campaignParticipation.created)
  t.is(second.body.campaignParticipation.responseId, first.body.campaignParticipation.responseId)
})

integration('collector point form and enrollment include the full final French calendar day', async t => {
  const f = await fixture()
  const instant = new Date('2026-11-03T23:30:00Z')
  await prisma.declarantPointPrelevement.update({where: {id: f.exploitation.id},
    data: {startDate: new Date('2026-11-04Z'), endDate: new Date('2026-11-04Z')}})
  const form = await getCollectorPointForm(f.point.id, {user: f.collector, now: instant})
  t.deepEqual(form.exploitations.map(row => row.id), [f.exploitation.id])
  t.true(form.point.right.canEdit)
  t.true(form.point.right.canCreateExploitation)
  const updated = await updateCollectorPointForm(f.point.id, {expectedUpdatedAt: form.point.updatedAt.toISOString(),
    exploitations: [{id: f.exploitation.id, expectedCountingCode: null, countingCode: '00123'}]}, {user: f.collector, now: instant})
  t.is(updated.exploitations[0].countingCode, '00123')
  t.true((await addCollectorCampaignParticipation(f.collector, f.campaign.id, {exploitationId: f.exploitation.id}, {now: instant})).campaignParticipation.created)
})
