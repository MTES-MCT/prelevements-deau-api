import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import {Prisma} from '@prisma/client'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {
  createCollectionCampaign, getCollectionCampaign, listCollectionCampaigns, listCollectionCandidates,
  updateCollectionCampaign, transitionCollectionCampaign, listCollectionResponses,
  getAuthorizedCampaignResponseContext, saveCollectionResponseDraft, getCollectionResults, getCampaignResponseVolumes
} from '../collection-campaigns.js'
import {submitCampaignResponse} from '../campaign-submission.js'
import {approveCampaignMeter, getCampaignMeterReview} from '../campaign-meter-publication.js'
import express from 'express'
import request from 'supertest'
import {createRoutes} from '../../routes.js'
import {createSessionToken} from '../../models/session-token.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
const owned = {campaigns: [], declarations: [], meters: [], users: [], points: [], exploitations: []}
const publicationFixtures = new Set()
test.before(() => { if (enabled) requireDisposableDatabase() })
test.afterEach.always(async () => {
  if (!enabled) return
  // Meter publication provenance is immutable. Its isolated fixtures remain in
  // the disposable database and are never deleted by a referential-only cleanup.
  if (owned.campaigns.some(id => publicationFixtures.has(id))) {
    for (const ids of Object.values(owned)) ids.length = 0
    return
  }
  await prisma.collectionResponse.deleteMany({where: {campaignId: {in: owned.campaigns}}})
  await prisma.collectionCampaign.deleteMany({where: {id: {in: owned.campaigns}}})
  await prisma.declaration.deleteMany({where: {id: {in: owned.declarations}}})
  await prisma.compteur.deleteMany({where: {id: {in: owned.meters}}})
  await prisma.declarantPointPrelevement.deleteMany({where: {id: {in: owned.exploitations}}})
  await prisma.pointPrelevement.deleteMany({where: {id: {in: owned.points}}})
  await prisma.user.deleteMany({where: {id: {in: owned.users}}})
  for (const ids of Object.values(owned)) ids.length = 0
})
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function user(role, declarantRole) {
  const created = await prisma.user.create({data: {role, ...(declarantRole ? {declarant: {create: {declarantRole, preleveurType: declarantRole === 'PRELEVEUR' ? 'IRRIGANT' : null, socialReason: `Collecte ${randomUUID()}`}}} : {})}})
  owned.users.push(created.id)
  return created
}

async function fixture({open = true} = {}) {
  const admin = await user('ADMIN')
  const collector = await user('DECLARANT', 'COLLECTEUR')
  const farmer = await user('DECLARANT', 'PRELEVEUR')
  const other = await user('DECLARANT', 'PRELEVEUR')
  const usage = await prisma.sandreWaterUse.findFirst({where: {kind: 'USAGE'}})
  const point = await prisma.pointPrelevement.create({data: {name: `Collecte ${randomUUID()}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT', collectionMode: 'MANUAL'}})
  owned.points.push(point.id)
  const exploitation = await prisma.declarantPointPrelevement.create({data: {declarantUserId: farmer.id, pointPrelevementId: point.id, usageId: usage.id, status: 'EN_ACTIVITE'}})
  owned.exploitations.push(exploitation.id)
  await prisma.declarantCollecteurExploitation.create({data: {exploitationId: exploitation.id, collecteurUserId: collector.id}})
  const campaign = await createCollectionCampaign({name: 'Collecte synthétique', opensOn: '2026-09-01', closesOn: '2026-12-31', collecteurUserId: collector.id, exploitationIds: [exploitation.id]}, {user: admin})
  owned.campaigns.push(campaign.id)
  if (open) await transitionCollectionCampaign(admin, campaign.id, 'open')
  const response = await prisma.collectionResponse.findFirst({where: {campaignId: campaign.id}})
  return {admin, collector, farmer, other, point, exploitation, campaign, response}
}

function declarationApp(actor, {serviceAccount} = {}) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = actor
    req.userRole = actor?.role
    req.serviceAccount = serviceAccount
    req.auth = serviceAccount ? {type: 'SERVICE_ACCOUNT_ACCESS'} : {type: 'USER_SESSION', role: actor.role, user: actor}
    next()
  })
  app.use(createRoutes())
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({message: error.message}))
  return app
}

function campaignApp(actor, auth = actor ? {type: 'USER_SESSION', role: actor.role, user: actor} : undefined) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.auth = auth; req.user = actor; req.userRole = actor?.role; next() })
  const routes = createRoutes()
  app.use('/', routes)
  app.use('/api', routes)
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({message: error.message}))
  return app
}

async function receiptFixture() {
  const f = await fixture()
  const stranger = await user('DECLARANT', 'COLLECTEUR')
  const meter = await prisma.compteur.create({data: {serialNumber: `RECEIPT-${randomUUID()}`}})
  owned.meters.push(meter.id)
  const createDeclaration = async (index, createdAt) => {
    const declaration = await prisma.declaration.create({data: {
      code: randomUUID().slice(0, 6).toUpperCase(), declarantUserId: f.farmer.id, type: 'quick-declaration', waterWithdrawalType: 'unknown', dataSourceType: 'MANUAL',
      source: {create: {type: 'DECLARATION', status: 'COMPLETED', metadata: {manualQuickDeclaration: true}, chunks: {create: {
        pointPrelevementId: f.point.id, exploitationId: f.exploitation.id, preleveurUserId: f.farmer.id,
        compteurId: meter.id, usageId: f.exploitation.usageId, instructionStatus: 'VALIDATED',
        minDate: new Date('2026-05-31'), maxDate: new Date('2026-05-31T00:00:01Z'),
        chunkValues: {create: {metricTypeCode: 'index', value: index, valueKind: 'DECLARED', periodStart: new Date('2026-05-31'), periodEnd: new Date('2026-05-31T00:00:01Z'), unit: 'm³', frequency: 'instant', createdAt}}
      }}}}
    }, include: {source: {include: {chunks: true}}}})
    owned.declarations.push(declaration.id)
    return declaration
  }
  const ordinary = await createDeclaration(100, new Date('2026-06-02'))
  const receipt = await createDeclaration(999, new Date('2026-06-03'))
  await prisma.collectionResponse.update({where: {id: f.response.id}, data: {declarationId: receipt.id, firstSubmittedAt: new Date()}})
  await prisma.declarantCollecteurExploitation.create({data: {collecteurUserId: stranger.id, exploitationId: f.exploitation.id}})
  return {...f, ordinary, receipt, stranger: {...stranger, declarant: {declarantRole: 'COLLECTEUR'}}, collector: {...f.collector, declarant: {declarantRole: 'COLLECTEUR'}}}
}

integration('campaign receipts keep exact collector rights in declaration list, feed, detail and replacement readings', async t => {
  const f = await receiptFixture()
  const app = declarationApp(f.stranger)
  const list = await request(app).get('/declarations/me')
  t.is(list.status, 200, list.body.message)
  t.true(list.body.data.some(row => row.id === f.ordinary.id))
  t.false(list.body.data.some(row => row.id === f.receipt.id))
  const feed = await request(app).get('/declarations/me/feed')
  t.is(feed.status, 200, feed.body.message)
  t.true(feed.body.data.some(row => row.declaration.id === f.ordinary.id))
  t.false(feed.body.data.some(row => row.declaration.id === f.receipt.id))
  t.is(feed.body.meta.total, 1)
  t.is((await request(app).get(`/declarations/${f.receipt.id}`)).status, 404)
  const ordinary = await request(app).get(`/declarations/${f.ordinary.id}`)
  t.is(ordinary.status, 200, ordinary.body.message)
  t.false(JSON.stringify(ordinary.body).includes(f.receipt.id))
  t.deepEqual(ordinary.body.data.source.chunks[0].latestIndexReadings.map(row => row.value), [100])
  t.false(ordinary.body.data.source.chunks[0].chunkValues[0].isOverwritten)
  t.is((await request(declarationApp(f.collector)).get(`/declarations/${f.receipt.id}`)).status, 200)
  t.is((await request(declarationApp(f.farmer)).get(`/declarations/${f.receipt.id}`)).status, 200)

  // Keep a delegation to this same farmer, but remove the campaign exploitation.
  const point = await prisma.pointPrelevement.create({data: {name: `Other receipt point ${randomUUID()}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'}})
  owned.points.push(point.id)
  const other = await prisma.declarantPointPrelevement.create({data: {declarantUserId: f.farmer.id, pointPrelevementId: point.id, usageId: f.exploitation.usageId}})
  owned.exploitations.push(other.id)
  await prisma.declarantCollecteurExploitation.create({data: {collecteurUserId: f.collector.id, exploitationId: other.id}})
  await prisma.declarantCollecteurExploitation.deleteMany({where: {collecteurUserId: f.collector.id, exploitationId: f.exploitation.id}})
  t.is((await request(declarationApp(f.collector)).get(`/declarations/${f.receipt.id}`)).status, 404)
  t.is((await request(declarationApp(f.collector)).get(`/declarations/${f.ordinary.id}`)).status, 200)
})

integration('receipt mutations outside campaigns are blocked after authorization and without changing the source', async t => {
  const f = await receiptFixture()
  const owner = declarationApp(f.farmer)
  const stranger = declarationApp(f.stranger)
  const admin = declarationApp(f.admin)
  const path = `/declarations/${f.receipt.id}`
  t.is((await request(stranger).get(`${path}/available-points-prelevements`)).status, 404)
  t.is((await request(owner).get(`${path}/available-points-prelevements`)).status, 409)
  t.is((await request(stranger).post(`${path}/points-change-request`).send({message: 'Déplacer le point'})).status, 404)
  t.is((await request(owner).post(`${path}/points-change-request`).send({message: 'Déplacer le point'})).status, 409)
  const reconcile = `${path}/chunks/${f.receipt.source.chunks[0].id}/reconcile`
  t.is((await request(stranger).post(reconcile).send({pointPrelevementId: null})).status, 404)
  t.is((await request(owner).post(reconcile).send({pointPrelevementId: null})).status, 409)
  t.is((await request(admin).post(`/chunks/${f.receipt.source.chunks[0].id}/instruction`).send({instructionStatus: 'REJECTED'})).status, 409)
  t.is((await request(admin).delete(`/admin${path}`)).status, 409)
  t.is((await request(admin).post(`/admin${path}/replay`)).status, 409)
  const service = declarationApp(null, {serviceAccount: {id: randomUUID()}})
  t.is((await request(service).get(`/service-accounts${path}/processing-context`)).status, 409)
  t.is((await request(service).post(`/service-accounts${path}/ingest`).send({data: {series: [], conflictPolicy: 'replace'}})).status, 409)
  t.is((await prisma.source.findUnique({where: {id: f.receipt.source.id}})).status, 'COMPLETED')
  t.is((await prisma.chunk.findUnique({where: {id: f.receipt.source.chunks[0].id}})).instructionStatus, 'VALIDATED')
  t.is((await prisma.declaration.findUnique({where: {id: f.receipt.id}})).processingStatus, 'CREATED')
})

integration('CRUD campaign targets are hidden before opening and scoped to their owner afterwards', async t => {
  const f = await fixture({open: false})
  t.is((await t.throwsAsync(getCollectionCampaign(f.farmer, f.campaign.id))).status, 404)
  t.is((await t.throwsAsync(getCollectionCampaign(f.collector, f.campaign.id))).status, 404)
  t.deepEqual((await getCollectionCampaign(f.admin, f.campaign.id)).campaign.exploitationIds, [f.exploitation.id])
  await transitionCollectionCampaign(f.admin, f.campaign.id, 'open')
  const own = await listCollectionResponses(f.farmer, f.campaign.id)
  t.is(own.total, 1)
  t.is(own.items[0].id, f.response.id)
  t.is((await t.throwsAsync(getAuthorizedCampaignResponseContext(f.other, f.campaign.id, f.response.id))).status, 404)
  t.true((await listCollectionCampaigns(f.farmer)).items.some(row => row.id === f.campaign.id))
})

integration('grouped progress excludes SQL and JSON null drafts and immediately reflects revoked delegations', async t => {
  const f = await fixture()
  for (const draftData of [Prisma.DbNull, Prisma.JsonNull]) {
    // eslint-disable-next-line no-await-in-loop -- Check each null representation on the same stored response.
    await prisma.collectionResponse.update({where: {id: f.response.id}, data: {draftData}})
    // eslint-disable-next-line no-await-in-loop -- Read the representation just written before replacing it.
    t.deepEqual((await getCollectionCampaign(f.collector, f.campaign.id)).progress, {total: 1, submitted: 0, drafts: 0, remaining: 1})
  }
  await prisma.collectionResponse.update({where: {id: f.response.id}, data: {draftData: {comment: 'Brouillon synthétique'}}})
  const listed = await listCollectionCampaigns(f.collector)
  t.deepEqual(listed.items.find(row => row.id === f.campaign.id).progress, {total: 1, submitted: 0, drafts: 1, remaining: 1})
  await prisma.collectionResponse.update({where: {id: f.response.id}, data: {firstSubmittedAt: new Date('2026-11-01Z')}})
  t.deepEqual((await getCollectionCampaign(f.collector, f.campaign.id)).progress, {total: 1, submitted: 1, drafts: 0, remaining: 0})
  await prisma.declarantCollecteurExploitation.deleteMany({where: {collecteurUserId: f.collector.id, exploitationId: f.exploitation.id}})
  t.deepEqual((await getCollectionCampaign(f.collector, f.campaign.id)).progress, {total: 0, submitted: 0, drafts: 0, remaining: 0})
  t.is((await getCollectionCampaign(f.farmer, f.campaign.id)).progress.submitted, 1)
})

integration('collector and participant alternate on one versioned draft and reject stale writes', async t => {
  const f = await fixture()
  const saved = await saveCollectionResponseDraft(f.farmer, f.campaign.id, f.response.id, {revision: 0, data: {comment: 'Brouillon partagé'}})
  t.is(saved.response.revision, 1)
  t.is(saved.response.draftData.comment, 'Brouillon partagé')
  const seen = await getAuthorizedCampaignResponseContext(f.collector, f.campaign.id, f.response.id)
  t.deepEqual(seen.response.draftData, saved.response.draftData)
  t.true(seen.permissions.canEdit)
  t.true(seen.permissions.canSubmit)
  t.true(seen.permissions.respondingOnBehalf)
  t.deepEqual(seen.response.permissions, {canEdit: true, canSubmit: true, respondingOnBehalf: true})
  const corrected = await saveCollectionResponseDraft(f.collector, f.campaign.id, f.response.id, {revision: 1, data: {comment: 'Saisie du collecteur'}})
  t.is(corrected.response.revision, 2)
  t.is(corrected.response.preleveurUserId, f.farmer.id)
  const participant = await getAuthorizedCampaignResponseContext(f.farmer, f.campaign.id, f.response.id)
  t.deepEqual(participant.data, corrected.data)
  t.deepEqual(participant.response.permissions, {canEdit: true, canSubmit: true, respondingOnBehalf: false})
  t.is((await t.throwsAsync(saveCollectionResponseDraft(f.farmer, f.campaign.id, f.response.id, {revision: 0, data: {comment: 'Obsolète'}}))).status, 409)
  t.is((await t.throwsAsync(saveCollectionResponseDraft(f.collector, f.campaign.id, f.response.id, {revision: 1, data: {comment: 'Obsolète'}}))).status, 409)
  t.is((await saveCollectionResponseDraft(f.farmer, f.campaign.id, f.response.id, {revision: 2, data: {comment: 'Reprise du préleveur'}})).response.revision, 3)
  t.is((await listCollectionResponses(f.collector, f.campaign.id, {status: 'DRAFT'})).total, 1)
  t.is((await listCollectionResponses(f.collector, f.campaign.id, {status: 'NOT_STARTED'})).total, 0)
})

integration('simultaneous collector and participant drafts accept one revision without losing the winner', async t => {
  const f = await fixture()
  const results = await Promise.allSettled([f.collector, f.farmer].map(actor =>
    saveCollectionResponseDraft(actor, f.campaign.id, f.response.id, {revision: 0, data: {comment: actor.id}})))
  const successes = results.filter(result => result.status === 'fulfilled')
  const failures = results.filter(result => result.status === 'rejected')
  t.is(successes.length, 1)
  t.is(failures.length, 1)
  t.is(failures[0].reason.status, 409)
  const stored = await prisma.collectionResponse.findUniqueOrThrow({where: {id: f.response.id}})
  t.is(stored.revision, 1)
  t.deepEqual(stored.draftData, successes[0].value.data)
  t.is(stored.preleveurUserId, f.farmer.id)
})

integration('campaign and response permissions agree across collector, participant and administrator views', async t => {
  const f = await fixture()
  await Promise.all([[f.collector, true, true], [f.farmer, true, false], [f.admin, false, false]].map(async ([actor, canEdit, respondingOnBehalf]) => {
    const campaign = await getCollectionCampaign(actor, f.campaign.id)
    const listed = (await listCollectionCampaigns(actor)).items.find(row => row.id === f.campaign.id)
    t.is(campaign.permissions.canRespondForParticipants, respondingOnBehalf)
    t.is(listed.permissions.canRespondForParticipants, respondingOnBehalf)
    for (const view of ['detailed', 'summary']) {
      // eslint-disable-next-line no-await-in-loop -- Compare both representations of the same authorized response.
      const page = await listCollectionResponses(actor, f.campaign.id, {view})
      t.deepEqual(page.items[0].permissions, {canEdit, canSubmit: canEdit, respondingOnBehalf})
    }
    const detail = await getAuthorizedCampaignResponseContext(actor, f.campaign.id, f.response.id)
    t.deepEqual(detail.response.permissions, {canEdit, canSubmit: canEdit, respondingOnBehalf})
    t.is(detail.permissions.canEdit, canEdit)
    t.is(detail.permissions.canSubmit, canEdit)
    t.is(detail.permissions.respondingOnBehalf, respondingOnBehalf)
  }))
})

integration('summary responses keep draft status and requested needs without disclosing the underlying answers', async t => {
  const f = await fixture()
  const submittedData = {comment: 'Commentaire synthétique privé', needs: {
    season: {flow: '12', volume: '240', crops: ['Culture privée'], surface: '8'},
    offSeason: {flow: '0', volume: '0'}
  }}
  await prisma.collectionResponse.update({where: {id: f.response.id}, data: {
    draftData: submittedData, submittedData, firstSubmittedAt: new Date('2026-11-01Z'),
    prefillData: {comment: 'Proposition privée'}, prefillMetadata: {private: 'Provenance privée'}
  }})
  const summary = (await listCollectionResponses(f.farmer, f.campaign.id, {view: 'summary'})).items[0]
  t.is(summary.status, 'SUBMITTED')
  t.false(summary.hasDraft)
  t.deepEqual(summary.submittedNeeds, {season: {flow: '12', volume: '240'}, offSeason: {flow: '0', volume: '0'}})
  for (const field of ['draftData', 'submittedData', 'prefillData', 'prefillMetadata', 'volumes']) t.false(Object.hasOwn(summary, field))
  t.false(JSON.stringify(summary).includes('privé'))
  t.deepEqual((await listCollectionResponses(f.farmer, f.campaign.id)).items[0].draftData, submittedData)
  await prisma.collectionResponse.update({where: {id: f.response.id}, data: {draftData: {...submittedData, comment: 'Modifié'}}})
  t.true((await listCollectionResponses(f.collector, f.campaign.id, {view: 'summary'})).items[0].hasDraft)
  const results = await getCollectionResults(f.collector, f.campaign.id, {view: 'summary'})
  t.deepEqual(results.items[0].submittedNeeds, summary.submittedNeeds)
  t.truthy(results.items[0].volumes)
  t.is(results.totals.requestedSeasonVolume, 240)
  await prisma.collectionResponse.update({where: {id: f.response.id}, data: {draftData: Prisma.JsonNull}})
  t.false((await listCollectionResponses(f.farmer, f.campaign.id, {view: 'summary'})).items[0].hasDraft)
})

integration('imported proposals remain private, do not start responses and yield to the first saved draft', async t => {
  const f = await fixture()
  const proposal = {needs: {season: {volume: '54321', usageId: f.exploitation.usageId}}}
  const metadata = {version: 1, sourceSha256: 'synthetic-source-hash', rows: [2], noAuthorizedOffSeasonUsage: true}
  await prisma.collectionResponse.update({where: {id: f.response.id}, data: {prefillData: proposal, prefillMetadata: metadata}})
  const owner = await getAuthorizedCampaignResponseContext(f.farmer, f.campaign.id, f.response.id)
  t.deepEqual(owner.data.needs.season, proposal.needs.season)
  t.deepEqual(owner.prefill, {active: true, noAuthorizedOffSeasonUsage: true})
  t.is(owner.response.status, 'NOT_STARTED')
  t.is(owner.response.revision, 0)
  t.is(owner.response.declarationId, null)
  const admin = await getAuthorizedCampaignResponseContext(f.admin, f.campaign.id, f.response.id)
  t.true(admin.prefill.active)
  t.deepEqual((await getCollectionCampaign(f.admin, f.campaign.id)).progress, {total: 1, submitted: 0, drafts: 0, remaining: 1})
  t.is((await listCollectionResponses(f.collector, f.campaign.id, {status: 'NOT_STARTED'})).total, 1)
  t.is((await listCollectionResponses(f.collector, f.campaign.id, {status: 'DRAFT'})).total, 0)
  const collector = await getAuthorizedCampaignResponseContext(f.collector, f.campaign.id, f.response.id)
  t.deepEqual(collector.prefill, {active: true, noAuthorizedOffSeasonUsage: true})
  t.deepEqual(collector.data.needs.season, proposal.needs.season)
  const listed = await listCollectionResponses(f.admin, f.campaign.id)
  for (const result of [owner, admin, collector, listed]) {
    t.false(JSON.stringify(result).includes('synthetic-source-hash'))
    t.false(JSON.stringify(result).includes('prefillData'))
    t.false(JSON.stringify(result).includes('prefillMetadata'))
  }
  t.is((await t.throwsAsync(getAuthorizedCampaignResponseContext(f.other, f.campaign.id, f.response.id))).status, 404)
  const saved = await saveCollectionResponseDraft(f.farmer, f.campaign.id, f.response.id, {revision: 0, data: {needs: {season: {volume: '999'}}}})
  t.false(saved.prefill.active)
  t.is(saved.data.needs.season.volume, '999')
  t.is(saved.response.revision, 1)
  const stored = await prisma.collectionResponse.findUnique({where: {id: f.response.id}})
  t.deepEqual(stored.prefillData, proposal)
  t.deepEqual(stored.prefillMetadata, metadata)
  t.is(stored.submittedData, null)
})

integration('deleting a delegation immediately removes collector response and result access', async t => {
  const f = await fixture()
  await prisma.declarantCollecteurExploitation.deleteMany({where: {collecteurUserId: f.collector.id, exploitationId: f.exploitation.id}})
  t.is((await listCollectionResponses(f.collector, f.campaign.id)).total, 0)
  t.is((await getCollectionResults(f.collector, f.campaign.id, {})).total, 0)
  t.is((await t.throwsAsync(getAuthorizedCampaignResponseContext(f.collector, f.campaign.id, f.response.id))).status, 404)
  t.is((await t.throwsAsync(saveCollectionResponseDraft(f.collector, f.campaign.id, f.response.id, {revision: 0, data: {comment: 'Interdit'}}))).status, 404)
  t.is((await t.throwsAsync(getCollectionResults(f.farmer, f.campaign.id, {}))).status, 403)
})

integration('campaign search matches point names and communes without widening collector access', async t => {
  const f = await fixture()
  await prisma.pointPrelevement.update({where: {id: f.point.id}, data: {name: 'Forage synthétique', usageName: 'Les Vergers', communeName: 'Marmande'}})
  for (const q of ['forage', 'vergers', 'MARMANDE']) {
    // eslint-disable-next-line no-await-in-loop -- Exercise each search field independently.
    const result = await listCollectionResponses(f.collector, f.campaign.id, {q, view: 'summary', pageSize: 1})
    t.is(result.total, 1)
    t.deepEqual(result.items.map(item => item.id), [f.response.id])
  }
  t.is((await listCollectionResponses(f.collector, f.campaign.id, {q: 'Commune absente', view: 'summary'})).total, 0)
  await prisma.declarantCollecteurExploitation.deleteMany({where: {collecteurUserId: f.collector.id, exploitationId: f.exploitation.id}})
  const revoked = await listCollectionResponses(f.collector, f.campaign.id, {q: 'Marmande', view: 'summary'})
  t.is(revoked.total, 0)
  t.deepEqual(revoked.items, [])
  t.is((await listCollectionResponses(f.farmer, f.campaign.id, {q: 'Marmande', view: 'summary'})).total, 1)
  t.is((await t.throwsAsync(listCollectionResponses(f.other, f.campaign.id, {q: 'Marmande', view: 'summary'}))).status, 404)
})

integration('campaign summaries expose only the authorized page coordinates as GeoJSON or null', async t => {
  const f = await fixture()
  await prisma.$executeRaw`UPDATE "PointPrelevement" SET coordinates = ST_SetSRID(ST_MakePoint(0.1, 44.7), 4326) WHERE id = ${f.point.id}::uuid`
  const own = await listCollectionResponses(f.farmer, f.campaign.id, {view: 'summary'})
  t.deepEqual(own.items[0].point.coordinates, {type: 'Point', coordinates: [0.1, 44.7]})
  t.false(Object.hasOwn(own.items[0], 'draftData'))
  t.deepEqual((await listCollectionResponses(f.collector, f.campaign.id, {view: 'summary'})).items[0].point.coordinates, own.items[0].point.coordinates)
  await prisma.declarantCollecteurExploitation.deleteMany({where: {collecteurUserId: f.collector.id, exploitationId: f.exploitation.id}})
  t.deepEqual((await listCollectionResponses(f.collector, f.campaign.id, {view: 'summary'})).items, [])
  await prisma.$executeRaw`UPDATE "PointPrelevement" SET coordinates = NULL WHERE id = ${f.point.id}::uuid`
  t.is((await listCollectionResponses(f.farmer, f.campaign.id, {view: 'summary'})).items[0].point.coordinates, null)
  t.deepEqual((await listCollectionResponses(f.farmer, f.campaign.id, {view: 'summary', page: 2, pageSize: 1})).items, [])
})

integration('closing is immediate, reopening requires a valid period, archive preserves all responses', async t => {
  const f = await fixture()
  await transitionCollectionCampaign(f.admin, f.campaign.id, 'close')
  const closed = await getAuthorizedCampaignResponseContext(f.farmer, f.campaign.id, f.response.id)
  t.false(closed.permissions.canEdit)
  t.is((await t.throwsAsync(saveCollectionResponseDraft(f.farmer, f.campaign.id, f.response.id, {revision: 0, data: {}}))).status, 409)
  await updateCollectionCampaign(f.admin, f.campaign.id, {closesOn: '2026-12-31'})
  await transitionCollectionCampaign(f.admin, f.campaign.id, 'open')
  t.true((await getAuthorizedCampaignResponseContext(f.farmer, f.campaign.id, f.response.id)).permissions.canEdit)
  await transitionCollectionCampaign(f.admin, f.campaign.id, 'archive')
  t.is(await prisma.collectionResponse.count({where: {campaignId: f.campaign.id}}), 1)
  t.is((await t.throwsAsync(transitionCollectionCampaign(f.admin, f.campaign.id, 'delete'))).status, 409)
  t.is((await t.throwsAsync(updateCollectionCampaign(f.admin, f.campaign.id, {name: 'Mutation interdite'}))).status, 409)
})

integration('only unused campaign drafts are deletable and population freezes upon opening', async t => {
  const f = await fixture({open: false})
  await updateCollectionCampaign(f.admin, f.campaign.id, {name: 'Nouveau nom'})
  t.is((await getCollectionCampaign(f.admin, f.campaign.id)).campaign.name, 'Nouveau nom')
  await transitionCollectionCampaign(f.admin, f.campaign.id, 'delete')
  t.is(await prisma.collectionCampaign.count({where: {id: f.campaign.id}}), 0)
  const g = await fixture()
  t.is((await t.throwsAsync(updateCollectionCampaign(g.admin, g.campaign.id, {exploitationIds: [g.exploitation.id]}))).status, 409)
  t.is((await t.throwsAsync(transitionCollectionCampaign(g.admin, g.campaign.id, 'delete'))).status, 409)
})

integration('candidate filters select delegated manual exploitations and allow one-shot selection', async t => {
  const f = await fixture()
  const result = await listCollectionCandidates(f.admin, {collecteurUserId: f.collector.id, page: 1, pageSize: 50, selectAll: true})
  t.deepEqual(result.selectedIds, [f.exploitation.id])
  t.is(result.items[0].point.name, f.point.name)
  await prisma.pointPrelevement.update({where: {id: f.point.id}, data: {collectionMode: 'EXTERNAL'}})
  t.is((await listCollectionCandidates(f.admin, {collecteurUserId: f.collector.id, page: 1, pageSize: 50})).total, 0)
})

integration('SQL protects response ownership and targeted exploitation identity', async t => {
  const f = await fixture()
  await t.throwsAsync(prisma.collectionResponse.update({where: {id: f.response.id}, data: {preleveurUserId: f.other.id}}))
  await t.throwsAsync(prisma.declarantPointPrelevement.update({where: {id: f.exploitation.id}, data: {declarantUserId: f.other.id}}))
  t.is((await prisma.collectionResponse.findUnique({where: {id: f.response.id}})).preleveurUserId, f.farmer.id)
})

integration('HTTP campaign guards require human sessions, preserve the API alias and reject wrong owners', async t => {
  const f = await fixture()
  const summary = await request(campaignApp(f.farmer)).get('/api/campaigns/summary')
  t.is(summary.status, 200)
  t.true(summary.body.data.items.some(row => row.id === f.campaign.id))
  t.is((await request(campaignApp()).get('/campaigns/summary')).status, 401)
  t.is((await request(campaignApp({id: f.admin.id, role: 'INSTRUCTOR'})).get('/campaigns/summary')).status, 403)
  t.is((await request(campaignApp(f.admin, {type: 'SERVICE_ACCOUNT_ACCESS', role: 'ADMIN'})).get('/campaigns/summary')).status, 403)
  t.is((await request(campaignApp(f.other)).get(`/campaigns/${f.campaign.id}/responses/${f.response.id}`)).status, 404)
})

for (const [name, expected, prepare] of [
  ['another delegated collector', 404, async f => {
    const actor = await user('DECLARANT', 'COLLECTEUR')
    await prisma.declarantCollecteurExploitation.create({data: {exploitationId: f.exploitation.id, collecteurUserId: actor.id}})
    return actor
  }],
  ['revoked delegation despite another delegated point for the same participant', 404, async f => {
    const point = await prisma.pointPrelevement.create({data: {name: `Other delegated point ${randomUUID()}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'}})
    owned.points.push(point.id)
    const exploitation = await prisma.declarantPointPrelevement.create({data: {declarantUserId: f.farmer.id,
      pointPrelevementId: point.id, usageId: f.exploitation.usageId, status: 'EN_ACTIVITE'}})
    owned.exploitations.push(exploitation.id)
    await prisma.declarantCollecteurExploitation.create({data: {exploitationId: exploitation.id, collecteurUserId: f.collector.id}})
    await prisma.declarantCollecteurExploitation.deleteMany({where: {exploitationId: f.exploitation.id, collecteurUserId: f.collector.id}})
  }],
  ['manual entry disabled', 403, async f => {
    await prisma.declarant.update({where: {userId: f.farmer.id}, data: {quickDeclarationEnabled: false}})
  }],
  ['external point', 403, async f => {
    await prisma.pointPrelevement.update({where: {id: f.point.id}, data: {collectionMode: 'EXTERNAL'}})
  }],
  ['inactive exploitation', 409, async f => {
    await prisma.declarantPointPrelevement.update({where: {id: f.exploitation.id}, data: {status: 'ABANDONNEE'}})
  }],
  ['closed campaign', 409, async f => { await transitionCollectionCampaign(f.admin, f.campaign.id, 'close') }]
]) {
  integration(`collector HTTP writes reject ${name} without creating a draft or receipt`, async t => {
    const f = await fixture()
    const actor = await prepare(f) ?? f.collector
    const app = campaignApp(actor)
    const path = `/api/campaigns/${f.campaign.id}/responses/${f.response.id}`
    const period = {usageId: f.exploitation.usageId, surface: '0', crops: 'Aucune'}
    const body = {revision: 0, data: {meters: [{serialNumber: `DENIED-${randomUUID()}`,
      offSeason: {...period, indexStart: '1', indexEnd: '2'}, season: {...period, indexEnd: '3'}}],
    needs: {offSeason: {...period, flow: '0', volume: '0'}, season: {...period, flow: '0', volume: '0'}}}}
    t.is((await request(app).put(path).send(body)).status, expected)
    t.is((await request(app).post(`${path}/submit`).send(body)).status, expected)
    const detail = await request(app).get(path)
    if (expected === 404) {
      t.is(detail.status, 404)
    } else {
      t.is(detail.status, 200)
      t.false(detail.body.data.response.permissions.canEdit)
      t.false(detail.body.data.response.permissions.canSubmit)
      const list = await request(app).get(`/api/campaigns/${f.campaign.id}/responses?view=summary`)
      t.is(list.status, 200)
      t.false(list.body.data.items[0].permissions.canEdit)
      t.false(list.body.data.items[0].permissions.canSubmit)
    }
    const unchanged = await prisma.collectionResponse.findUniqueOrThrow({where: {id: f.response.id}})
    t.is(unchanged.revision, 0)
    t.is(unchanged.draftData, null)
    t.is(unchanged.declarationId, null)
    t.is(await prisma.compteur.count({where: {serialNumber: body.data.meters[0].serialNumber}}), 0)
  })
}

integration('a response from another campaign cannot be read, saved or submitted under an authorized campaign', async t => {
  const f = await fixture()
  const other = await fixture()
  const app = campaignApp(f.collector)
  const path = `/campaigns/${f.campaign.id}/responses/${other.response.id}`
  const period = {usageId: f.exploitation.usageId, surface: '0', crops: 'Aucune'}
  const body = {revision: 0, data: {meters: [{serialNumber: `WRONG-${randomUUID()}`,
    offSeason: {...period, indexStart: '1', indexEnd: '2'}, season: {...period, indexEnd: '3'}}],
  needs: {offSeason: {...period, flow: '0', volume: '0'}, season: {...period, flow: '0', volume: '0'}}}}
  t.is((await request(app).get(path)).status, 404)
  t.is((await request(app).put(path).send(body)).status, 404)
  t.is((await request(app).post(`${path}/submit`).send(body)).status, 404)
  t.is((await prisma.collectionResponse.findUniqueOrThrow({where: {id: other.response.id}})).revision, 0)
})

integration('a real impersonated collector keeps the same delegated draft capabilities', async t => {
  const f = await fixture()
  const session = await createSessionToken(f.collector.id, 'DECLARANT', undefined, {
    authVersion: f.collector.authVersion, impersonatedByUserId: f.admin.id,
    impersonatedByRole: 'ADMIN', impersonatedByAuthVersion: f.admin.authVersion
  })
  const app = campaignApp()
  const path = `/api/campaigns/${f.campaign.id}/responses/${f.response.id}`
  const authorization = `Bearer ${session.token}`
  const saved = await request(app).put(path).set('Authorization', authorization).send({revision: 0, data: {comment: 'Saisie déléguée'}})
  t.is(saved.status, 200, saved.body.message)
  t.true(saved.body.data.response.permissions.respondingOnBehalf)
  t.is(saved.body.data.response.preleveurUserId, f.farmer.id)
  t.is((await getAuthorizedCampaignResponseContext(f.farmer, f.campaign.id, f.response.id)).data.comment, 'Saisie déléguée')
  await prisma.declarantCollecteurExploitation.deleteMany({where: {exploitationId: f.exploitation.id, collecteurUserId: f.collector.id}})
  t.is((await request(app).put(path).set('Authorization', authorization).send({revision: 1, data: {}})).status, 404)
})

integration('a real admin impersonation session can save and reload its preleveur response, without bypassing lifecycle or revision checks', async t => {
  const f = await fixture()
  const session = await createSessionToken(f.farmer.id, 'DECLARANT', undefined, {
    authVersion: f.farmer.authVersion, impersonatedByUserId: f.admin.id,
    impersonatedByRole: 'ADMIN', impersonatedByAuthVersion: f.admin.authVersion
  })
  const app = campaignApp()
  const path = `/api/campaigns/${f.campaign.id}/responses/${f.response.id}`
  const authorization = `Bearer ${session.token}`
  const context = await request(app).get(path).set('Authorization', authorization)
  t.is(context.status, 200)
  t.true(context.body.data.permissions.canEdit)
  const body = {revision: 0, data: {comment: 'Réponse synthétique enregistrée'}}
  const saved = await request(app).put(path).set('Authorization', authorization).send(body)
  t.is(saved.status, 200, saved.body.message)
  t.is(saved.body.data.response.revision, 1)
  t.deepEqual(saved.body.data.data, body.data)
  const reloaded = await request(app).get(path).set('Authorization', authorization)
  t.deepEqual(reloaded.body.data.data, body.data)
  t.is((await request(app).put(path).set('Authorization', authorization).send(body)).status, 409)

  await transitionCollectionCampaign(f.admin, f.campaign.id, 'close')
  const usage = await prisma.sandreWaterUse.findFirst({where: {kind: 'SUB_USAGE'}})
  const period = {usageId: usage.id, surface: '0', crops: 'Aucune'}
  const data = {meters: [{serialNumber: 'SYNTHETIC-METER', offSeason: {...period, indexStart: '1', indexEnd: '2'}, season: {...period, indexEnd: '3'}}],
    needs: {offSeason: {...period, flow: '0', volume: '0'}, season: {...period, flow: '0', volume: '0'}}}
  const submission = await request(app).post(`${path}/submit`).set('Authorization', authorization).send({revision: 1, data})
  t.is(submission.status, 409)
  t.is(submission.body.message, 'Cette campagne n’est pas ouverte à la saisie.')
  t.is((await request(app).put(path).set('Authorization', authorization).send({revision: 1, data: {}})).status, 409)
  const unchanged = await prisma.collectionResponse.findUnique({where: {id: f.response.id}})
  t.is(unchanged.revision, 1)
  t.is(unchanged.firstSubmittedAt, null)
  t.deepEqual(unchanged.draftData, body.data)

  // The real administrator's session generation is still checked on every request.
  await prisma.user.update({where: {id: f.admin.id}, data: {authVersion: {increment: 1}}})
  t.is((await request(app).get(path).set('Authorization', authorization)).status, 401)
})

integration('impersonation never grants response ownership or campaign administration', async t => {
  const f = await fixture()
  const path = `/campaigns/${f.campaign.id}/responses/${f.response.id}`
  const usage = await prisma.sandreWaterUse.findFirst({where: {kind: 'SUB_USAGE'}})
  const period = {usageId: usage.id, surface: '0', crops: 'Aucune'}
  const body = {revision: 0, data: {meters: [{serialNumber: 'SYNTHETIC-METER', offSeason: {...period, indexStart: '1', indexEnd: '2'}, season: {...period, indexEnd: '3'}}],
    needs: {offSeason: {...period, flow: '0', volume: '0'}, season: {...period, flow: '0', volume: '0'}}}}
  await Promise.all([[f.other, 404], [f.admin, 403], [{...f.admin, role: 'INSTRUCTOR'}, 403]].flatMap(([actor, expected]) =>
    [false, true].map(async impersonating => {
      const auth = {type: 'USER_SESSION', role: actor.role, user: actor,
        ...(impersonating ? {impersonation: {actor: f.admin}} : {})}
      const app = campaignApp(actor, auth)
      t.is((await request(app).put(path).send(body)).status, expected)
      t.is((await request(app).post(`${path}/submit`).send(body)).status, expected)
    })))
  const service = campaignApp(f.farmer, {type: 'SERVICE_ACCOUNT_IMPERSONATION', role: 'DECLARANT'})
  t.is((await request(service).put(path).send(body)).status, 403)
  t.is((await request(service).post(`${path}/submit`).send(body)).status, 403)
  const administrator = campaignApp(f.admin, {type: 'USER_SESSION', impersonation: {actor: f.admin}})
  await Promise.all(['open', 'close', 'archive'].map(async action => {
    t.is((await request(administrator).post(`/campaigns/${f.campaign.id}/${action}`)).status, 403)
  }))
  t.is((await request(administrator).patch(`/campaigns/${f.campaign.id}`).send({name: 'Forbidden'})).status, 403)
  t.is((await request(administrator).post(`/campaigns/${f.campaign.id}/meters/${randomUUID()}/approve`).send({})).status, 404)
  const unchanged = await prisma.collectionResponse.findUnique({where: {id: f.response.id}})
  t.is(unchanged.revision, 0)
  t.is(unchanged.firstSubmittedAt, null)
  t.is(unchanged.draftData, null)
})

integration('campaign volumes use each submitted response while physical shares and supersession remain separate', async t => {
  const f = await fixture()
  publicationFixtures.add(f.campaign.id)
  const point = await prisma.pointPrelevement.create({data: {name: `Autre point de test ${randomUUID()}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'}})
  const exploitation = await prisma.declarantPointPrelevement.create({data: {declarantUserId: f.farmer.id, pointPrelevementId: point.id, usageId: f.exploitation.usageId, status: 'EN_ACTIVITE'}})
  await prisma.declarantCollecteurExploitation.create({data: {collecteurUserId: f.collector.id, exploitationId: exploitation.id}})
  const response = await prisma.collectionResponse.create({data: {campaignId: f.campaign.id, exploitationId: exploitation.id, preleveurUserId: f.farmer.id}})
  const meter = await prisma.compteur.create({data: {serialNumber: `RESULTS-${randomUUID()}`}})
  await Promise.all([f.exploitation, exploitation].map(target => prisma.meterAllocation.create({data: {sourceId: randomUUID(), provider: 'documentary-test', scope: f.campaign.id, compteurId: meter.id, exploitationId: target.id, versions: {create: {version: 1, enabled: false}}}})))
  const usage = await prisma.sandreWaterUse.findFirst({where: {kind: 'SUB_USAGE'}})
  const fields = {usageId: usage.id, surface: '0', crops: 'Aucune'}
  const data = {meters: [{compteurId: meter.id, serialNumber: meter.serialNumber, offSeason: {...fields, indexStart: '100', indexEnd: '200'}, season: {...fields, indexEnd: '260'}}],
    needs: {offSeason: {...fields, flow: '1', volume: '10'}, season: {...fields, flow: '2', volume: '20'}}}
  const now = new Date('2026-11-02T12:00:00Z')
  const first = await submitCampaignResponse({user: f.farmer, campaignId: f.campaign.id, responseId: f.response.id, body: {revision: 0, data}}, {now})
  await submitCampaignResponse({user: f.farmer, campaignId: f.campaign.id, responseId: response.id, body: {revision: 0, data}}, {now})
  t.deepEqual(first.response.volumes, {offSeason: 100, season: 60, total: 160, partial: false})
  const review = await getCampaignMeterReview({user: f.admin, campaignId: f.campaign.id, compteurId: meter.id})
  await approveCampaignMeter({user: f.admin, campaignId: f.campaign.id, compteurId: meter.id, body: {expectedHash: review.expectedHash, confirmHistorical: true,
    allocations: [{exploitationId: f.exploitation.id, offSeasonPercentage: '60', seasonPercentage: '50'}, {exploitationId: exploitation.id, offSeasonPercentage: '40', seasonPercentage: '50'}]}}, {now})
  const result = await getCollectionResults(f.collector, f.campaign.id, {})
  t.is(result.totals.publishedVolumes.total, 320)
  t.false(result.totals.publishedVolumes.partial)
  t.is(result.items.find(row => row.id === f.response.id).volumes.total, 160)
  t.is(result.items.find(row => row.id === response.id).volumes.total, 160)
  const onlyFirst = await getCampaignResponseVolumes([await prisma.collectionResponse.findUnique({where: {id: f.response.id}})])
  t.is(onlyFirst.get(f.response.id).total, 160)
  t.is(onlyFirst.size, 1)
  const correction = structuredClone(first.response.submittedData)
  correction.meters[0].season.indexEnd = '280'
  await submitCampaignResponse({user: f.farmer, campaignId: f.campaign.id, responseId: f.response.id, body: {revision: 1, data: correction}}, {now})
  const withdrawn = await getCollectionResults(f.collector, f.campaign.id, {})
  t.is(withdrawn.totals.publishedVolumes.total, 340)
  t.false(withdrawn.totals.publishedVolumes.partial)
  t.is(await prisma.meterPublication.count({where: {compteurId: meter.id, active: true}}), 0)
})

integration('ordinary campaign results do not duplicate requested volumes or existing exact index prefills', async t => {
  const f = await fixture()
  publicationFixtures.add(f.campaign.id)
  const usage = await prisma.sandreWaterUse.findFirst({where: {kind: 'SUB_USAGE'}})
  const fields = {usageId: usage.id, surface: '0', crops: 'Aucune'}
  const data = {meters: [{compteurId: null, serialNumber: `GENERIC-${randomUUID()}`, offSeason: {...fields, indexStart: '100', indexEnd: '100'}, season: {...fields, indexEnd: '130'}}],
    needs: {offSeason: {...fields, flow: '1', volume: '1000'}, season: {...fields, flow: '2', volume: '2000'}}}
  const result = await submitCampaignResponse({user: f.farmer, campaignId: f.campaign.id, responseId: f.response.id, body: {revision: 0, data}}, {now: new Date('2026-11-02T12:00:00Z')})
  t.deepEqual(result.response.volumes, {offSeason: 0, season: 30, total: 30, partial: false})
  const sums = (await getCollectionResults(f.collector, f.campaign.id, {})).totals
  t.is(sums.requestedSeasonVolume, 2000)
  t.is(sums.publishedVolumes.total, 30)
  const next = await createCollectionCampaign({name: 'Autre collecte synthétique', opensOn: '2026-09-01', closesOn: '2026-12-31', collecteurUserId: f.collector.id, exploitationIds: [f.exploitation.id]}, {user: f.admin})
  await transitionCollectionCampaign(f.admin, next.id, 'open')
  const nextResponse = await prisma.collectionResponse.findFirst({where: {campaignId: next.id}})
  const initial = await getAuthorizedCampaignResponseContext(f.farmer, next.id, nextResponse.id)
  t.is(initial.data.meters[0].offSeason.indexStart, '100')
  t.is(initial.data.meters[0].season.indexEnd, '130')
  t.deepEqual(initial.data.needs, {offSeason: {}, season: {}})
})
