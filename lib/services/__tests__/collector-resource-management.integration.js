/* eslint-disable no-await-in-loop -- Integration cases deliberately serialize mutations and assertions. */
import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import express from 'express'
import request from 'supertest'
import {prisma} from '../../../db/prisma.js'
import {createRoutes} from '../../routes.js'
import {buildAuditMutations, stageAuditMutation} from '../../audit/mutations.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {insertPointPrelevement} from '../../models/point-prelevement.js'
import {
  createCollectorExploitation, getCollectorExploitationForm, updateCollectorExploitationForm,
  getCollectorPreleveurContactDetails, updateCollectorPreleveurContactDetails
} from '../collector-resource-management.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
const prefix = `Resource management ${randomUUID()}`
const zones = []
const campaigns = []
const sources = []
const now = new Date('2026-11-04T12:00:00Z')

test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => {
  if (enabled) {
    await prisma.collectionResponse.deleteMany({where: {campaignId: {in: campaigns}}})
    await prisma.collectionCampaign.deleteMany({where: {id: {in: campaigns}}})
    await prisma.source.deleteMany({where: {id: {in: sources}}})
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

async function actor(role, declarant, extra = {}) {
  return prisma.user.create({data: {role, firstName: prefix, ...extra, ...(declarant ? {declarant: {create: declarant}} : {})}})
}

async function fixture() {
  const zoneId = randomUUID()
  zones.push(zoneId)
  await prisma.$executeRaw`INSERT INTO "Zone" (id, code, type, name, coordinates, "createdAt", "updatedAt")
    VALUES (${zoneId}::uuid, ${zoneId}, 'DEPARTEMENT', ${prefix},
      ST_Multi(ST_GeomFromText('POLYGON((61.6 -30.4,61.6 -29.6,62.4 -29.6,62.4 -30.4,61.6 -30.4))',4326)), now(), now())`
  const admin = await actor('ADMIN')
  const collector = await actor('DECLARANT', {declarantRole: 'COLLECTEUR', pointManagementEnabled: true,
    pointManagementZones: {create: {zoneId}}})
  const owner = await actor('DECLARANT', {declarantRole: 'PRELEVEUR', preleveurType: 'IRRIGANT',
    quickDeclarationEnabled: true, city: 'Ville initiale', contactEmails: {create: {
      email: `${randomUUID()}@example.test`, isPrimary: true, sourceId: `synthetic-import:${randomUUID()}`
    }}}, {email: `${randomUUID()}@example.test`, authVersion: 7})
  const outsider = await actor('DECLARANT', {declarantRole: 'COLLECTEUR', pointManagementEnabled: true})
  const usage = await prisma.sandreWaterUse.findFirstOrThrow({where: {kind: 'USAGE', code: '2'}})
  const point = await insertPointPrelevement({name: `${prefix} ${randomUUID()}`,
    coordinates: {type: 'Point', coordinates: [62, -30]}, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'})
  const exploitation = await prisma.declarantPointPrelevement.create({data: {
    declarantUserId: owner.id, pointPrelevementId: point.id, usageId: usage.id, status: 'EN_ACTIVITE',
    collecteurs: {create: {collecteurUserId: collector.id}}
  }})
  return {collector, admin, owner, outsider, usage, point, exploitation}
}

async function campaign(f) {
  const row = await prisma.collectionCampaign.create({data: {
    name: `${prefix} campagne`, collecteurUserId: f.collector.id, createdByUserId: f.admin.id,
    status: 'OPEN', opensOn: new Date('2020-01-01Z'), closesOn: new Date('2099-12-31Z')
  }})
  campaigns.push(row.id)
  return row
}

function creation(f) {
  return {requestId: randomUUID(), preleveur: {firstName: prefix, lastName: randomUUID(), preleveurType: 'IRRIGANT'},
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

integration('composite creation preserves the point, enrolls atomically and replays after closure', async t => {
  const f = await fixture()
  const c = await campaign(f)
  const payload = {...creation(f), campaignId: c.id}
  const audits = []
  const options = {user: f.collector, now, onCreated: event => audits.push(event)}
  const result = await createCollectorExploitation(f.point.id, payload, options)
  t.is(result.point.id, f.point.id)
  t.is(result.notification.status, 'not_requested')
  t.false(result.replayed)
  t.is(await prisma.pointPrelevement.count({where: {id: f.point.id}}), 1)
  const record = await prisma.declarantPointPrelevement.findUniqueOrThrow({where: {id: result.exploitationId}, include: {collecteurs: true}})
  t.is(record.declarantUserId, result.preleveurId)
  t.deepEqual(record.collecteurs.map(row => row.collecteurUserId), [f.collector.id])
  const response = await prisma.collectionResponse.findUniqueOrThrow({where: {id: result.campaignParticipation.responseId}})
  t.is(response.exploitationId, result.exploitationId)
  t.is(response.preleveurUserId, result.preleveurId)
  await prisma.collectionCampaign.update({where: {id: c.id}, data: {closedAt: now}})
  t.deepEqual(await createCollectorExploitation(f.point.id, payload, options), {...result, replayed: true})
  t.is(audits.length, 1)
  t.is((await t.throwsAsync(createCollectorExploitation(f.point.id, {...payload, campaignId: randomUUID()}, options))).status, 409)
})

integration('failed enrollment rolls back the new preleveur, exploitation, meter and request', async t => {
  const f = await fixture()
  const c = await campaign(f)
  await prisma.pointPrelevement.update({where: {id: f.point.id}, data: {flowType: 'REJET'}})
  const payload = {...creation(f), campaignId: c.id}
  payload.exploitation.meters = [{serialNumber: `${prefix} ${randomUUID()}`}]
  const error = await t.throwsAsync(createCollectorExploitation(f.point.id, payload, {user: f.collector, now}))
  t.is(error.data.code, 'CAMPAIGN_EXPLOITATION_INELIGIBLE')
  t.is(await prisma.user.count({where: {firstName: prefix, lastName: payload.preleveur.lastName}}), 0)
  t.is(await prisma.declarantPointPrelevement.count({where: {pointPrelevementId: f.point.id}}), 1)
  t.is(await prisma.compteur.count({where: {serialNumber: payload.exploitation.meters[0].serialNumber}}), 0)
  t.is(await prisma.collectorPointCreationRequest.count({where: {requestId: payload.requestId}}), 0)
})

integration('contact edits preserve legacy login and imported contacts, revoke old authentication and reject stale versions', async t => {
  const f = await fixture()
  const options = {user: f.collector, now}
  const form = await getCollectorPreleveurContactDetails(f.owner.id, options)
  const originalContact = await prisma.declarantContactEmail.findFirstOrThrow({where: {declarantUserId: f.owner.id}})
  const result = await updateCollectorPreleveurContactDetails(f.owner.id, {version: form.version,
    details: {city: 'Ville corrigée', phoneNumber: '0102030405', contactEmails: [...form.details.contactEmails,
      {email: `${randomUUID()}@example.test`, isPrimary: false}]}}, options)
  t.is(result.details.city, 'Ville corrigée')
  t.is(result.details.contactEmails.length, 2)
  t.not(result.version, form.version)
  const auth = await prisma.user.findUniqueOrThrow({where: {id: f.owner.id}})
  t.is(auth.email, f.owner.email)
  t.is(auth.authVersion, 8)
  t.is(auth.lastLoginAt, f.owner.lastLoginAt)
  t.deepEqual(await prisma.declarantContactEmail.findUniqueOrThrow({where: {id: originalContact.id}}), originalContact)
  t.is((await t.throwsAsync(updateCollectorPreleveurContactDetails(f.owner.id,
    {version: form.version, details: {city: 'Autre ville'}}, options))).status, 409)
  await prisma.declarantCollecteurExploitation.deleteMany({where: {collecteurUserId: f.collector.id, exploitationId: f.exploitation.id}})
  t.is((await t.throwsAsync(updateCollectorPreleveurContactDetails(f.owner.id,
    {version: result.version, details: {city: 'Autre ville'}}, options))).status, 403)
})

integration('shared email creation stays distinct, prevents duplicate profiles and sends one invitation', async t => {
  const f = await fixture()
  const email = `${randomUUID()}@example.org`
  const first = creation(f)
  first.preleveur.email = email
  first.notifyAccountCreation = true
  const second = creation(f)
  second.preleveur.email = email
  second.notifyAccountCreation = true
  let sent = 0
  const options = {user: f.collector, now, notify: async () => { sent++ }}
  const results = await Promise.all([createCollectorExploitation(f.point.id, first, options), createCollectorExploitation(f.point.id, second, options)])
  t.not(results[0].preleveurId, results[1].preleveurId)
  t.deepEqual(results.map(row => row.notification.status).sort(), ['already_registered', 'sent'])
  t.is(sent, 1)
  t.is(await prisma.declarant.count({where: {email}}), 2)
  t.is(await prisma.user.count({where: {email}}), 1)
  const replay = await createCollectorExploitation(f.point.id, first, options)
  t.true(replay.replayed)
  t.is(sent, 1)
  const duplicate = {...first, requestId: randomUUID()}
  t.is((await t.throwsAsync(createCollectorExploitation(f.point.id, duplicate, options))).status, 409)
  const siret = '12345678901234'
  await prisma.declarant.update({where: {userId: results[0].preleveurId}, data: {siret}})
  const sameSiret = creation(f)
  sameSiret.preleveur.siret = siret
  t.is((await t.throwsAsync(createCollectorExploitation(f.point.id, sameSiret, options))).status, 409)
})

integration('two different collectors sharing an email recover a stale transaction without duplicate invitations', async t => {
  const first = await fixture()
  const second = await fixture()
  const email = `${randomUUID()}@example.org`
  let entered = 0
  let release
  const ready = new Promise(resolve => { release = resolve })
  const client = {collectorPointCreationRequest: prisma.collectorPointCreationRequest,
    $transaction: (fn, options) => prisma.$transaction(async tx => {
      const attempt = ++entered
      if (attempt <= 2) {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${first.collector.id}::uuid`
        if (attempt === 2) release()
        await ready
      }
      return fn(tx)
    }, options)}
  let sent = 0
  const payloads = [first, second].map(f => {
    const payload = creation(f)
    payload.preleveur.email = email
    payload.notifyAccountCreation = true
    return payload
  })
  const results = await Promise.all([first, second].map((f, index) => createCollectorExploitation(f.point.id, payloads[index], {
    user: f.collector, now, client, notify: async () => { sent++ }
  })))
  t.true(entered > 2)
  t.not(results[0].preleveurId, results[1].preleveurId)
  t.deepEqual(results.map(result => result.notification.status).sort(), ['already_registered', 'sent'])
  t.is(sent, 1)
  t.is(await prisma.user.count({where: {email}}), 1)
  t.is(await prisma.declarant.count({where: {email}}), 2)
  t.is(await prisma.collectorPointCreationRequest.count({where: {requestId: {in: payloads.map(payload => payload.requestId)}}}), 2)
})

integration('single principal field is atomic, audited and stays empty after clearing', async t => {
  const f = await fixture()
  const mutations = []
  const options = {user: f.collector, now, onUpdated: rows => mutations.push(...rows)}
  const original = await prisma.declarantContactEmail.findFirstOrThrow({where: {declarantUserId: f.owner.id}})
  let form = await getCollectorPreleveurContactDetails(f.owner.id, options)
  form = await updateCollectorPreleveurContactDetails(f.owner.id, {version: form.version,
    details: {email: `${randomUUID()}@example.test`}}, options)
  t.true(mutations.some(row => row.entityType === 'DECLARANT' && row.before.email === null && row.after.email === form.details.email))
  form = await updateCollectorPreleveurContactDetails(f.owner.id, {version: form.version, details: {email: null}}, options)
  t.is(form.details.email, null)
  t.is((await getCollectorPreleveurContactDetails(f.owner.id, options)).details.email, null)
  const preserved = await prisma.declarantContactEmail.findUniqueOrThrow({where: {id: original.id}})
  t.is(preserved.sourceId, original.sourceId)
  t.is(preserved.email, original.email)
  t.false(preserved.isPrimary)
  t.is((await prisma.user.findUniqueOrThrow({where: {id: f.owner.id}})).email, f.owner.email)
})

integration('legacy imported primary prevents recreating the same profile without granting login', async t => {
  const f = await fixture()
  const email = `${randomUUID()}@example.org`
  await prisma.user.update({where: {id: f.owner.id}, data: {email: `${randomUUID()}@import.local`, lastName: 'Legacy'}})
  await prisma.declarantContactEmail.updateMany({where: {declarantUserId: f.owner.id, isPrimary: true}, data: {email}})
  const payload = creation(f)
  Object.assign(payload.preleveur, {email, lastName: 'Legacy'})
  t.is((await t.throwsAsync(createCollectorExploitation(f.point.id, payload, {user: f.collector, now}))).status, 409)
  t.is(await prisma.collectorPointCreationRequest.count({where: {requestId: payload.requestId}}), 0)
  t.is((await prisma.declarant.findUniqueOrThrow({where: {userId: f.owner.id}})).email, null)
})

integration('exploitation updates preserve ownership, support meters-only and lock historical periods', async t => {
  const f = await fixture()
  const action = {type: 'COLLECTOR.EXPLOITATION_FORM_UPDATED'}
  const auditRequest = {auditEventId: 'synthetic', auditAction: action,
    body: {changes: {countingCode: 'CODE-42'}}, params: {exploitationId: f.exploitation.id}}
  const options = {user: f.collector, now, onUpdated: mutations => {
    for (const mutation of mutations) stageAuditMutation(auditRequest, mutation)
  }}
  let form = await getCollectorExploitationForm(f.exploitation.id, options)
  form = await updateCollectorExploitationForm(f.exploitation.id, {version: form.version,
    changes: {countingCode: 'CODE-42'}}, options)
  t.is(form.exploitation.declarantUserId, f.owner.id)
  t.is(form.exploitation.pointPrelevementId, f.point.id)
  t.is(form.exploitation.countingCode, 'CODE-42')
  const [audit] = buildAuditMutations(auditRequest, action)
  t.deepEqual(audit.changedFields, ['countingCode'])
  form = await updateCollectorExploitationForm(f.exploitation.id, {version: form.version,
    meters: [{serialNumber: `${prefix} ${randomUUID()}`}]}, options)
  t.is(form.meters.length, 1)
  t.true(form.meters[0].capabilities.canEditSerialNumber)
  const source = await prisma.source.create({data: {type: 'DECLARATION', status: 'COMPLETED'}})
  sources.push(source.id)
  await prisma.chunk.create({data: {sourceId: source.id, exploitationId: f.exploitation.id, pointPrelevementId: f.point.id,
    preleveurUserId: f.owner.id, usageId: f.usage.id, minDate: new Date('2026-01-01Z'), maxDate: new Date('2026-11-04Z')}})
  const error = await t.throwsAsync(updateCollectorExploitationForm(f.exploitation.id,
    {version: form.version, changes: {startDate: '2026-02-01'}}, options))
  t.is(error.data.code, 'COLLECTOR_EXPLOITATION_HISTORY_PERIOD')
  form = await updateCollectorExploitationForm(f.exploitation.id, {version: form.version, changes: {endDate: '2026-11-04'}}, options)
  t.true(form.capabilities.canEdit)
  t.truthy(await getCollectorPreleveurContactDetails(f.owner.id, options))
  form = await updateCollectorExploitationForm(f.exploitation.id, {version: form.version, changes: {status: 'TERMINEE'}}, options)
  t.false(form.capabilities.canEdit)
  t.is((await t.throwsAsync(updateCollectorExploitationForm(f.exploitation.id,
    {version: form.version, changes: {countingCode: 'Autre'}}, options))).status, 403)
})

integration('closure blocks unsubmitted forms and changed drafts, then allows an unchanged submission', async t => {
  const f = await fixture()
  const c = await campaign(f)
  const response = await prisma.collectionResponse.create({data: {campaignId: c.id, exploitationId: f.exploitation.id, preleveurUserId: f.owner.id}})
  const options = {user: f.collector, now}
  const form = await getCollectorExploitationForm(f.exploitation.id, options)
  const update = () => updateCollectorExploitationForm(f.exploitation.id, {version: form.version, changes: {status: 'TERMINEE'}}, options)
  let error = await t.throwsAsync(update())
  t.is(error.data.code, 'COLLECTOR_EXPLOITATION_PENDING_CAMPAIGNS')
  t.is(error.data.pendingCampaignResponses[0].href, `/campagnes/${c.id}/reponses/${response.id}`)
  await prisma.collectionResponse.update({where: {id: response.id}, data: {firstSubmittedAt: now,
    submittedData: {comment: 'Transmis'}, draftData: {comment: 'Modification'}}})
  error = await t.throwsAsync(update())
  t.is(error.data.code, 'COLLECTOR_EXPLOITATION_PENDING_CAMPAIGNS')
  await prisma.collectionResponse.update({where: {id: response.id}, data: {draftData: {comment: 'Transmis'}}})
  t.false((await update()).capabilities.canEdit)
})

integration('creation checks existing ownership, following and geography on each attempt', async t => {
  const f = await fixture()
  const payload = creation(f)
  const options = {user: f.collector, now}
  await prisma.user.update({where: {id: f.owner.id}, data: {deletedAt: now}})
  t.is((await t.throwsAsync(createCollectorExploitation(f.point.id, payload, options))).status, 403)
  await prisma.user.update({where: {id: f.owner.id}, data: {deletedAt: null}})
  await prisma.declarantPointPrelevement.update({where: {id: f.exploitation.id}, data: {endDate: new Date('2026-11-04Z')}})
  const result = await createCollectorExploitation(f.point.id, payload, options)
  t.truthy(result.exploitationId)
  await prisma.collectorPointManagementZone.deleteMany({where: {collecteurUserId: f.collector.id}})
  t.is((await t.throwsAsync(createCollectorExploitation(f.point.id, creation(f), options))).status, 403)
})

integration('HTTP management routes enforce human enabled-collector access and preserve /api alias', async t => {
  const f = await fixture()
  const app = appFor(f.collector)
  const exploitationPath = `/collecteurs/me/exploitations/${f.exploitation.id}/form`
  const contactPath = `/collecteurs/me/preleveurs/${f.owner.id}/contact-details`
  const createPath = `/collecteurs/me/points-prelevement/${f.point.id}/exploitations`
  const exploitation = await request(app).get(`/api${exploitationPath}`)
  t.is(exploitation.status, 200)
  t.is((await request(app).patch(exploitationPath).send({version: exploitation.body.version, changes: {countingCode: 'HTTP'}})).status, 200)
  const contact = await request(app).get(contactPath)
  t.is(contact.status, 200)
  t.is((await request(app).patch(`/api${contactPath}`).send({version: contact.body.version, details: {city: 'Ville HTTP'}})).status, 200)
  const input = creation(f)
  t.is((await request(app).post(`/api${createPath}`).send(input)).status, 201)
  t.is((await request(app).post(createPath).send(input)).status, 200)
  await prisma.declarant.update({where: {userId: f.collector.id}, data: {pointManagementEnabled: false}})
  for (const restricted of [app, appFor(f.owner), appFor(f.admin), appFor(f.collector, 'SERVICE_ACCOUNT_ACCESS')]) {
    t.is((await request(restricted).get(exploitationPath)).status, 403)
    t.is((await request(restricted).get(contactPath)).status, 403)
    t.is((await request(restricted).patch(exploitationPath).send({version: exploitation.body.version, changes: {countingCode: 'Denied'}})).status, 403)
    t.is((await request(restricted).patch(contactPath).send({version: contact.body.version, details: {city: 'Refusé'}})).status, 403)
    t.is((await request(restricted).post(createPath).send(creation(f))).status, 403)
  }
})
