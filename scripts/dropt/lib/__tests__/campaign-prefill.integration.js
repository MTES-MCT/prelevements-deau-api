import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import {prisma} from '../../../../db/prisma.js'
import {requireDisposableDatabase} from '../../../../lib/util/test-helpers/disposable-database.js'
import {prefillCampaign, verifyCampaignPrefill} from '../campaign-prefill.js'
import {CAMPAIGN_PREFILL_HEADERS, parseCampaignPrefillRows} from '../campaign-prefill-source.js'
import {getAuthorizedCampaignResponseContext, listCollectionResponses, saveCollectionResponseDraft} from '../../../../lib/services/collection-campaigns.js'
import {submitCampaignResponse} from '../../../../lib/services/campaign-submission.js'

const enabled = process.env.DROPT_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function fixture({existingMeter = true} = {}) {
  const admin = await prisma.user.create({data: {role: 'ADMIN'}})
  const farmer = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {declarantRole: 'PRELEVEUR', preleveurType: 'IRRIGANT', siret: '00000000000001'}}}})
  const collector = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {declarantRole: 'COLLECTEUR'}}}})
  const usage = await prisma.sandreWaterUse.findUnique({where: {code: '2'}})
  const point = await prisma.pointPrelevement.create({data: {name: `PREFILL-${randomUUID()}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'}})
  const exploitation = await prisma.declarantPointPrelevement.create({data: {pointPrelevementId: point.id, declarantUserId: farmer.id, countingCode: 'SYNTHETIC-COUNT', usageId: usage.id, status: 'EN_ACTIVITE'}})
  const meter = existingMeter ? await prisma.compteur.create({data: {serialNumber: `PREFILL-${randomUUID()}`}}) : null
  if (meter) await prisma.meterAllocation.create({data: {sourceId: randomUUID(), provider: 'test', scope: 'test', compteurId: meter.id, exploitationId: exploitation.id}})
  const campaign = await prisma.collectionCampaign.create({data: {name: 'Préremplissage synthétique', createdByUserId: admin.id, collecteurUserId: collector.id}})
  const response = await prisma.collectionResponse.create({data: {campaignId: campaign.id, exploitationId: exploitation.id, preleveurUserId: farmer.id}})
  const cells = Array(25).fill(null)
  Object.assign(cells, {1: point.name, 2: '00000000000001', 3: 1000, 4: 10, 5: 2, 6: 999999, 7: 3, 8: 20,
    11: 100, 13: 200, 16: 0, 17: 'SYNTHETIC-COUNT', 19: meter?.serialNumber ?? null, 20: 50, 21: 123, 22: 'Irrigation', 23: 'Irrigation'})
  const source = {...parseCampaignPrefillRows([CAMPAIGN_PREFILL_HEADERS, cells]), source: {sha256: 'a'.repeat(64)}}
  return {admin, farmer, campaign, response, source, meter, point, exploitation, usage,
    options: {campaignId: campaign.id, actorUserId: admin.id, target: 'local'}}
}

integration('an anonymous source proposal survives draft reload and only creates one physical meter on submission', async t => {
  const f = await fixture({existingMeter: false})
  await prisma.collectionCampaign.update({where: {id: f.campaign.id}, data: {status: 'OPEN', opensOn: new Date('2026-09-01Z'), closesOn: new Date('2027-12-31Z')}})
  const meterCount = await prisma.compteur.count()
  const sourceCount = await prisma.source.count()
  const simulation = await prefillCampaign(prisma, f.source, f.options)
  const applied = await prefillCampaign(prisma, f.source, {...f.options, apply: true, expectedReport: simulation})
  t.deepEqual(applied.entries[0].prefillData.meters, [{compteurId: null, serialNumber: null, offSeason: {indexStart: '123'}, season: {}}])
  t.true((await verifyCampaignPrefill(prisma, f.source, {...f.options, expectedReport: applied})).complete)
  t.is((await prefillCampaign(prisma, f.source, f.options)).counts.ALREADY_APPLIED, 1)
  const initial = await getAuthorizedCampaignResponseContext(f.farmer, f.campaign.id, f.response.id)
  t.true(initial.prefill.active)
  t.deepEqual(initial.meters, [])
  t.deepEqual(initial.data.meters, applied.entries[0].prefillData.meters)
  t.is(initial.response.status, 'NOT_STARTED')
  await saveCollectionResponseDraft(f.farmer, f.campaign.id, f.response.id, {revision: 0, data: initial.data})
  const draft = await getAuthorizedCampaignResponseContext(f.farmer, f.campaign.id, f.response.id)
  t.deepEqual(draft.data, initial.data)
  t.is(await prisma.compteur.count(), meterCount)
  t.is(await prisma.source.count(), sourceCount)
  t.is(await prisma.meterAllocation.count({where: {exploitationId: f.exploitation.id}}), 0)
  const data = structuredClone(draft.data)
  const agriculture = {usageId: f.usage.id, surface: '1', crops: ['Culture synthétique']}
  data.meters[0].offSeason = {...data.meters[0].offSeason, ...agriculture, indexEnd: '200'}
  data.meters[0].season = {...agriculture, indexEnd: '260'}
  data.needs.offSeason.crops = agriculture.crops
  data.needs.season.crops = agriculture.crops
  const submit = revision => submitCampaignResponse({user: f.farmer, campaignId: f.campaign.id, responseId: f.response.id,
    body: {revision, data}}, {now: new Date('2026-09-30T12:00:00Z')})
  const submitted = await submit(1)
  t.is(submitted.response.publicationStatus, 'PUBLISHED')
  t.truthy(submitted.response.submittedData.meters[0].compteurId)
  t.is(submitted.response.submittedData.meters[0].serialNumber, null)
  t.is(await prisma.compteur.count(), meterCount + 1)
  t.is(await prisma.meterAllocation.count({where: {exploitationId: f.exploitation.id}}), 1)
  t.is((await submit(1)).response.revision, 2)
  t.is(await prisma.compteur.count(), meterCount + 1)
  t.is((await prisma.collectionResponse.findUnique({where: {id: f.response.id}})).prefillMetadata.sourceSha256, f.source.source.sha256)
  t.is(f.source.records[0].reading.date, '2025-10-31')
})

integration('source provenance stays on October 31 while exact November 1 observations take precedence over the proposal', async t => {
  const f = await fixture()
  const addReading = async (date, value) => prisma.source.create({data: {type: 'BATCH', status: 'COMPLETED', chunks: {create: {
    compteurId: f.meter.id, exploitationId: f.exploitation.id, pointPrelevementId: f.point.id,
    preleveurUserId: f.farmer.id, usageId: f.usage.id, instructionStatus: 'VALIDATED',
    minDate: new Date(`${date}T00:00:00Z`), maxDate: new Date(`${date}T00:00:00Z`), chunkValues: {create: {
      metricTypeCode: 'index', value, unit: 'm³', frequency: 'instant', valueKind: 'DECLARED',
      periodStart: new Date(`${date}T00:00:00Z`), periodEnd: new Date(`${date}T00:15:00Z`)
    }}
  }}}})
  await addReading('2025-10-31', '111')
  const proposal = await prefillCampaign(prisma, f.source, f.options)
  t.is(f.source.records[0].reading.date, '2025-10-31')
  t.is(proposal.entries[0].prefillData.meters[0].offSeason.indexStart, '123')
  await addReading('2025-11-01', '456')
  const current = await prefillCampaign(prisma, f.source, f.options)
  t.deepEqual(current.entries[0].prefillData.meters, [])
  t.true(current.issues.some(issue => issue.code === 'existing_index_conflict'))
  const context = await getAuthorizedCampaignResponseContext(f.admin, f.campaign.id, f.response.id)
  t.is(context.data.meters[0].offSeason.indexStart, '456')
  const readings = await prisma.chunkValue.findMany({where: {chunk: {compteurId: f.meter.id}}, orderBy: {periodStart: 'asc'}})
  t.deepEqual(readings.map(row => [row.periodStart.toISOString().slice(0, 10), row.value.toString()]), [['2025-10-31', '111'], ['2025-11-01', '456']])
})

integration('a new own observation suppresses an anonymous proposal without exposing another beneficiary history', async t => {
  const f = await fixture({existingMeter: false})
  const simulation = await prefillCampaign(prisma, f.source, f.options)
  await prefillCampaign(prisma, f.source, {...f.options, apply: true, expectedReport: simulation})
  const other = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
  const otherExploitation = await prisma.declarantPointPrelevement.create({data: {pointPrelevementId: f.point.id, declarantUserId: other.id, usageId: f.usage.id}})
  const addReading = (exploitationId, preleveurUserId) => prisma.source.create({data: {type: 'BATCH', status: 'COMPLETED', chunks: {create: {
    exploitationId, pointPrelevementId: f.point.id, preleveurUserId, usageId: f.usage.id, instructionStatus: 'VALIDATED',
    minDate: new Date('2025-11-01Z'), maxDate: new Date('2025-11-01Z'), chunkValues: {create: {
      metricTypeCode: 'index', value: '0', unit: 'm³', frequency: 'instant', valueKind: 'DECLARED',
      periodStart: new Date('2025-11-01Z'), periodEnd: new Date('2025-11-01T00:15:00Z')
    }}
  }}}})
  await addReading(otherExploitation.id, other.id)
  t.is((await getAuthorizedCampaignResponseContext(f.admin, f.campaign.id, f.response.id)).data.meters[0].offSeason.indexStart, '123')
  await addReading(f.exploitation.id, f.farmer.id)
  const context = await getAuthorizedCampaignResponseContext(f.admin, f.campaign.id, f.response.id)
  t.deepEqual(context.data.meters, [])
  const stored = await prisma.collectionResponse.findUnique({where: {id: f.response.id}})
  t.is(stored.prefillData.meters[0].offSeason.indexStart, '123')
  t.is(stored.revision, 0)
})

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
