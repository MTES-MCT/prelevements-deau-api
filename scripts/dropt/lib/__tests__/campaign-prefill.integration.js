import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import {prisma} from '../../../../db/prisma.js'
import {requireDisposableDatabase} from '../../../../lib/util/test-helpers/disposable-database.js'
import {prefillCampaign, verifyCampaignPrefill} from '../campaign-prefill.js'
import {CAMPAIGN_PREFILL_HEADERS, parseCampaignPrefillRows} from '../campaign-prefill-source.js'
import {getAuthorizedCampaignResponseContext, listCollectionResponses} from '../../../../lib/services/collection-campaigns.js'

const enabled = process.env.DROPT_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function fixture() {
  const admin = await prisma.user.create({data: {role: 'ADMIN'}})
  const farmer = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {declarantRole: 'PRELEVEUR', preleveurType: 'IRRIGANT', siret: '00000000000001'}}}})
  const collector = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {declarantRole: 'COLLECTEUR'}}}})
  const usage = await prisma.sandreWaterUse.findUnique({where: {code: '2'}})
  const point = await prisma.pointPrelevement.create({data: {name: `PREFILL-${randomUUID()}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'}})
  const exploitation = await prisma.declarantPointPrelevement.create({data: {pointPrelevementId: point.id, declarantUserId: farmer.id, countingCode: 'SYNTHETIC-COUNT', usageId: usage.id, status: 'EN_ACTIVITE'}})
  const meter = await prisma.compteur.create({data: {serialNumber: `PREFILL-${randomUUID()}`}})
  await prisma.meterAllocation.create({data: {sourceId: randomUUID(), provider: 'test', scope: 'test', compteurId: meter.id, exploitationId: exploitation.id}})
  const campaign = await prisma.collectionCampaign.create({data: {name: 'Préremplissage synthétique', createdByUserId: admin.id, collecteurUserId: collector.id}})
  const response = await prisma.collectionResponse.create({data: {campaignId: campaign.id, exploitationId: exploitation.id, preleveurUserId: farmer.id}})
  const cells = Array(25).fill(null)
  Object.assign(cells, {1: point.name, 2: '00000000000001', 3: 1000, 4: 10, 5: 2, 6: 999999, 7: 3, 8: 20,
    11: 100, 13: 200, 16: 0, 17: 'SYNTHETIC-COUNT', 19: meter.serialNumber, 20: 50, 21: 123, 22: 'Irrigation', 23: 'Irrigation'})
  const source = {...parseCampaignPrefillRows([CAMPAIGN_PREFILL_HEADERS, cells]), source: {sha256: 'a'.repeat(64)}}
  return {admin, farmer, campaign, response, source, options: {campaignId: campaign.id, actorUserId: admin.id, target: 'local'}}
}

for (const target of ['local', 'testing', 'prod']) integration(`${target} report cycle on disposable database preserves responses, counts and physical readings`, async t => {
  const f = await fixture()
  f.options.target = target
  const original = await prisma.collectionResponse.findUnique({where: {id: f.response.id}})
  const sourceCount = await prisma.source.count()
  const indexCount = await prisma.chunkValue.count()
  const simulation = await prefillCampaign(prisma, f.source, f.options)
  t.is(simulation.counts.PREFILL, 1)
  t.deepEqual(await prisma.collectionResponse.findUnique({where: {id: f.response.id}}), original)
  const application = await prefillCampaign(prisma, f.source, {...f.options, apply: true, expectedReport: simulation})
  t.true(application.applied)
  const saved = await prisma.collectionResponse.findUnique({where: {id: f.response.id}})
  t.is(saved.prefillData.needs.offSeason.volume, '300')
  t.is(saved.prefillData.meters[0].offSeason.indexStart, '123')
  for (const key of ['draftData', 'submittedData', 'revision', 'firstSubmittedAt', 'lastSubmittedAt', 'declarationId', 'publicationStatus']) t.deepEqual(saved[key], original[key])
  t.is(await prisma.source.count(), sourceCount)
  t.is(await prisma.chunkValue.count(), indexCount)
  const context = await getAuthorizedCampaignResponseContext(f.admin, f.campaign.id, f.response.id)
  t.true(context.prefill.active)
  t.is(context.data.needs.offSeason.volume, '300')
  const list = await listCollectionResponses(f.admin, f.campaign.id, {})
  t.is(list.items[0].status, 'NOT_STARTED')
  t.false(JSON.stringify(list).includes('sourceSha256'))
  t.true((await verifyCampaignPrefill(prisma, f.source, {...f.options, expectedReport: application})).complete)
  const again = await prefillCampaign(prisma, f.source, f.options)
  t.is(again.counts.ALREADY_APPLIED, 1)
  t.is(again.counts.PREFILL, 0)
  await prefillCampaign(prisma, f.source, {...f.options, apply: true, expectedReport: again})
  t.deepEqual(await prisma.collectionResponse.findUnique({where: {id: f.response.id}}), saved)
})

integration('new draft after preflight blocks all writes and subsequent simulation preserves it', async t => {
  const f = await fixture()
  const simulation = await prefillCampaign(prisma, f.source, f.options)
  await prisma.collectionResponse.update({where: {id: f.response.id}, data: {draftData: {comment: 'Déjà saisi'}, revision: 1}})
  await t.throwsAsync(prefillCampaign(prisma, f.source, {...f.options, apply: true, expectedReport: simulation}), {message: /État modifié/})
  const current = await prisma.collectionResponse.findUnique({where: {id: f.response.id}})
  t.is(current.prefillData, null)
  t.is(current.draftData.comment, 'Déjà saisi')
  t.is((await prefillCampaign(prisma, f.source, f.options)).counts.PRESERVED_RESPONSE, 1)
})

integration('source, actor, target and reviewed simulation are mandatory', async t => {
  const f = await fixture()
  await t.throwsAsync(prefillCampaign(prisma, f.source, {...f.options, apply: true}), {message: /Rapport/})
  await t.throwsAsync(prefillCampaign(prisma, f.source, {...f.options, actorUserId: f.farmer.id}), {message: /administrateur actif/})
  const simulation = await prefillCampaign(prisma, f.source, f.options)
  const changed = {...f.source, source: {sha256: 'b'.repeat(64)}}
  await t.throwsAsync(prefillCampaign(prisma, changed, {...f.options, apply: true, expectedReport: simulation}), {message: /Rapport/})
  for (const target of ['testing', 'prod']) {
    await t.throwsAsync(prefillCampaign(prisma, f.source, {...f.options, target, apply: true, expectedReport: simulation}), {message: /Rapport/})
    await t.throwsAsync(prefillCampaign(prisma, f.source, {...f.options, target, apply: true, expectedReport: {...simulation, target}}), {message: /État modifié/})
  }
  t.is((await prisma.collectionResponse.findUnique({where: {id: f.response.id}})).prefillData, null)
})

integration('verify notices altered prefills without replacing them', async t => {
  const f = await fixture()
  const simulation = await prefillCampaign(prisma, f.source, f.options)
  const application = await prefillCampaign(prisma, f.source, {...f.options, apply: true, expectedReport: simulation})
  const corrected = {meters: [], needs: {season: {volume: '77'}, offSeason: {}}, comment: ''}
  await prisma.collectionResponse.update({where: {id: f.response.id}, data: {prefillData: corrected}})
  t.false((await verifyCampaignPrefill(prisma, f.source, {...f.options, expectedReport: application})).complete)
  t.is((await prefillCampaign(prisma, f.source, f.options)).counts.PRESERVED_PREFILL, 1)
})
