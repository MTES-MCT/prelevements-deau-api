/* eslint-disable no-await-in-loop -- Fixtures and reconstruction checks deliberately run serially against the disposable database. */
import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {submitCampaignResponse} from '../campaign-submission.js'
import {getCampaignMeterReview, approveCampaignMeter} from '../campaign-meter-publication.js'
import {saveCollectionResponseDraft, getAuthorizedCampaignResponseContext} from '../collection-campaigns.js'
import {reconstructVolumesFromIndexForPoint} from '../volumes-from-index.js'
import {getDeclarationDetailHandler} from '../../handlers/declarations.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
const now = new Date('2026-11-02T12:00:00Z')
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function fixture({shared = false, existingMeter = true} = {}) {
  const admin = await prisma.user.create({data: {role: 'ADMIN'}})
  const collector = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {declarantRole: 'COLLECTEUR'}}}})
  const preleveur = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
  const root = await prisma.sandreWaterUse.findFirst({where: {kind: 'USAGE'}})
  const offUsage = await prisma.sandreWaterUse.create({data: {code: `C${randomUUID().slice(0, 12)}`, kind: 'SUB_USAGE', label: 'Usage synthétique hors étiage', parentId: root.id}})
  const seasonUsage = await prisma.sandreWaterUse.create({data: {code: `C${randomUUID().slice(0, 12)}`, kind: 'SUB_USAGE', label: 'Usage synthétique étiage', parentId: root.id}})
  const campaign = await prisma.collectionCampaign.create({data: {name: 'Campagne synthétique', status: 'OPEN',
    collecteurUserId: collector.id, createdByUserId: admin.id, opensOn: new Date('2026-09-01Z'), closesOn: new Date('2026-12-31Z')}})
  const meter = existingMeter ? await prisma.compteur.create({data: {serialNumber: `SYN-${randomUUID()}`}}) : null
  const responses = []
  const exploitations = []
  for (let index = 0; index < (shared ? 2 : 1); index++) {
    const point = await prisma.pointPrelevement.create({data: {name: `Point synthétique ${randomUUID()}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'}})
    const exploitation = await prisma.declarantPointPrelevement.create({data: {declarantUserId: preleveur.id,
      pointPrelevementId: point.id, usageId: root.id, status: 'EN_ACTIVITE'}})
    await prisma.declarantCollecteurExploitation.create({data: {exploitationId: exploitation.id, collecteurUserId: collector.id}})
    if (meter) await prisma.meterAllocation.create({data: {sourceId: randomUUID(), provider: 'synthetic-reference', scope: campaign.id,
      compteurId: meter.id, exploitationId: exploitation.id, versions: {create: {version: 1, enabled: false}}}})
    const response = await prisma.collectionResponse.create({data: {campaignId: campaign.id, exploitationId: exploitation.id, preleveurUserId: preleveur.id}})
    responses.push(response)
    exploitations.push(exploitation)
  }
  const fields = usageId => ({usageId, surface: '1.5', crops: 'Culture synthétique'})
  const data = {meters: [{compteurId: meter?.id ?? null, serialNumber: meter?.serialNumber ?? `NEW-${randomUUID()}`,
    offSeason: {...fields(offUsage.id), indexStart: '100', indexEnd: '200'}, season: {...fields(seasonUsage.id), indexEnd: '260'}}],
  needs: {offSeason: {...fields(offUsage.id), flow: '5', volume: '400'}, season: {...fields(seasonUsage.id), flow: '8', volume: '600'}}, comment: ''}
  return {admin, collector, preleveur, campaign, meter, responses, exploitations, data, offUsage, seasonUsage}
}

function submit(f, index = 0, {data = f.data, revision = 0} = {}) {
  return submitCampaignResponse({user: f.preleveur, campaignId: f.campaign.id, responseId: f.responses[index].id, body: {revision, data}}, {now})
}

async function activeVolumes(f) {
  return prisma.chunkValue.findMany({where: {metricTypeCode: 'volume', chunk: {exploitationId: {in: f.exploitations.map(row => row.id)}, instructionStatus: {not: 'REJECTED'}, source: {status: 'COMPLETED'}}}, include: {chunk: true}})
}

integration('campaign creates a stable receipt, computes both seasons and replays without a new submission', async t => {
  const f = await fixture({existingMeter: false})
  const result = await submit(f)
  t.is(result.response.publicationStatus, 'PUBLISHED')
  t.is(result.response.revision, 1)
  const meterId = result.response.submittedData.meters[0].compteurId
  t.truthy(meterId)
  t.is(await prisma.meterAllocation.count({where: {compteurId: meterId, exploitationId: f.exploitations[0].id}}), 1)
  const volumes = await activeVolumes(f)
  t.is(volumes.reduce((sum, row) => sum + Number(row.value), 0), 160)
  t.is(volumes.find(row => Number(row.value) === 100).chunk.usageId, f.offUsage.id)
  t.is(volumes.find(row => Number(row.value) === 60).chunk.usageId, f.seasonUsage.id)
  const replay = await submit(f)
  t.is(replay.response.revision, 1)
  t.is(replay.response.declarationId, result.response.declarationId)
  const changed = structuredClone(result.response.submittedData)
  changed.meters[0].season.indexEnd = '280'
  const corrected = await submit(f, 0, {data: changed, revision: 1})
  t.is(corrected.response.declarationId, result.response.declarationId)
  t.is(corrected.response.revision, 2)
  t.is((await activeVolumes(f)).reduce((sum, row) => sum + Number(row.value), 0), 180)
  t.is(await prisma.declaration.count({where: {importSourceId: `collection-response:${f.responses[0].id}`}}), 1)
})

integration('campaign refuses future index submissions and incomplete or decreasing readings without any writes', async t => {
  const f = await fixture()
  const args = {user: f.preleveur, campaignId: f.campaign.id, responseId: f.responses[0].id, body: {revision: 0, data: f.data}}
  t.is((await t.throwsAsync(submitCampaignResponse(args, {now: new Date('2026-09-24Z')}))).status, 409)
  const missing = structuredClone(f.data)
  delete missing.meters[0].offSeason.indexStart
  t.is((await t.throwsAsync(submit(f, 0, {data: missing}))).status, 400)
  const decreasing = structuredClone(f.data)
  decreasing.meters[0].season.indexEnd = '50'
  t.is((await t.throwsAsync(submit(f, 0, {data: decreasing}))).status, 409)
  t.is(await prisma.declaration.count({where: {importSourceId: `collection-response:${f.responses[0].id}`}}), 0)
})

integration('shared receipts do not calculate volumes; physical publication conserves 60/40 then 50/50', async t => {
  const f = await fixture({shared: true})
  const first = await submit(f)
  await submit(f, 1)
  t.is(first.response.publicationStatus, 'PENDING_REVIEW')
  t.is((await activeVolumes(f)).length, 0)
  for (const exploitation of f.exploitations) await reconstructVolumesFromIndexForPoint(exploitation.pointPrelevementId)
  t.is((await activeVolumes(f)).length, 0)
  const review = await getCampaignMeterReview({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id})
  t.true(review.canApprove)
  const body = {expectedHash: review.expectedHash, confirmHistorical: true, allocations: f.exploitations.map((row, index) => ({exploitationId: row.id,
    offSeasonPercentage: index ? '40' : '60', seasonPercentage: '50', additive: false}))}
  const result = await approveCampaignMeter({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id, body}, {now})
  t.is(result.status, 'PUBLISHED')
  t.deepEqual(await approveCampaignMeter({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id, body}, {now}), result)
  const volumes = await activeVolumes(f)
  t.is(volumes.length, 4)
  t.is(volumes.reduce((sum, row) => sum + Number(row.value), 0), 160)
  t.is(volumes.filter(row => row.chunk.exploitationId === f.exploitations[0].id).reduce((sum, row) => sum + Number(row.value), 0), 90)
  t.true(volumes.every(row => row.chunk.calculationStrategy === 'METER'))
  t.is(volumes.find(row => Number(row.value) === 60).chunk.usageId, f.offUsage.id)
  const changedNeeds = structuredClone(first.response.submittedData)
  changedNeeds.needs.season.volume = '700'
  const needsOnly = await submit(f, 0, {data: changedNeeds, revision: 1})
  t.is(needsOnly.response.publicationStatus, 'PUBLISHED')
  t.is((await activeVolumes(f)).reduce((sum, row) => sum + Number(row.value), 0), 160)
  const changed = structuredClone(first.response.submittedData)
  changed.meters[0].season.indexEnd = '280'
  const corrected = await submit(f, 0, {data: changed, revision: 2})
  t.is(corrected.response.publicationStatus, 'PENDING_REVIEW')
  t.is((await activeVolumes(f)).length, 0)
  const next = await getCampaignMeterReview({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id})
  t.true(next.contradictoryReadings)
  t.is((await t.throwsAsync(approveCampaignMeter({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id,
    body: {...body, expectedHash: next.expectedHash}}, {now: new Date('2026-11-03Z')}))).status, 409)
  const approved = await approveCampaignMeter({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id,
    body: {...body, expectedHash: next.expectedHash, canonicalResponseId: f.responses[0].id}}, {now: new Date('2026-11-03Z')})
  t.is(approved.status, 'PUBLISHED')
  t.is((await activeVolumes(f)).reduce((sum, row) => sum + Number(row.value), 0), 180)
})

integration('a known number from another exploitation is a claim, not an automatic association', async t => {
  const f = await fixture({existingMeter: false})
  const other = await fixture()
  const data = structuredClone(f.data)
  data.meters[0].serialNumber = other.meter.serialNumber
  const result = await submit(f, 0, {data})
  t.is(result.response.publicationStatus, 'PENDING_REVIEW')
  t.is(await prisma.meterAllocation.count({where: {compteurId: other.meter.id, exploitationId: f.exploitations[0].id}}), 0)
  t.is((await activeVolumes(f)).length, 0)
  t.is((await t.throwsAsync(getAuthorizedCampaignResponseContext(other.preleveur, f.campaign.id, f.responses[0].id))).status, 404)
})

integration('supplier streams and observations are never altered by campaign review', async t => {
  const f = await fixture()
  const stream = await prisma.meterStream.create({data: {provider: 'synthetic-provider', scope: 'external', externalId: f.meter.id,
    compteurId: f.meter.id, enabled: false, checkpoint: new Date('2026-09-01Z')}})
  const result = await submit(f)
  t.is(result.response.publicationStatus, 'PENDING_REVIEW')
  const review = await getCampaignMeterReview({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id})
  t.false(review.canApprove)
  t.is((await t.throwsAsync(approveCampaignMeter({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id,
    body: {expectedHash: review.expectedHash, confirmHistorical: true, allocations: [{exploitationId: f.exploitations[0].id, offSeasonPercentage: '100', seasonPercentage: '100'}]}}, {now}))).status, 409)
  t.deepEqual(await prisma.meterStream.findUnique({where: {id: stream.id}}), stream)
  t.is(await prisma.meterReading.count({where: {compteurId: f.meter.id}}), 0)
})

integration('saving a correction draft leaves the submitted receipt untouched and hidden from collector', async t => {
  const f = await fixture()
  const result = await submit(f)
  const changed = structuredClone(result.response.submittedData)
  changed.meters[0].season.indexEnd = '290'
  await saveCollectionResponseDraft(f.preleveur, f.campaign.id, f.responses[0].id, {revision: 1, data: changed})
  const collector = await getAuthorizedCampaignResponseContext(f.collector, f.campaign.id, f.responses[0].id)
  t.is(collector.response.draftData, null)
  t.is(collector.response.submittedData.meters[0].season.indexEnd, '260')
  t.is((await activeVolumes(f)).reduce((sum, row) => sum + Number(row.value), 0), 160)
  t.is((await t.throwsAsync(submit(f, 0, {data: changed, revision: 1}))).status, 409)
})

integration('invalid needs roll back a newly entered meter, its attachment and the entire receipt', async t => {
  const f = await fixture({existingMeter: false})
  const invalid = structuredClone(f.data)
  invalid.needs.season.usageId = randomUUID()
  t.is((await t.throwsAsync(submit(f, 0, {data: invalid}))).status, 400)
  t.is(await prisma.compteur.count({where: {serialNumber: invalid.meters[0].serialNumber}}), 0)
  const response = await prisma.collectionResponse.findUnique({where: {id: f.responses[0].id}})
  t.is(response.revision, 0)
  t.is(response.submittedData, null)
  t.is(response.declarationId, null)
})

integration('a resolved ordinary-volume conflict can calculate again without overwriting the other declaration', async t => {
  const f = await fixture()
  const source = await prisma.source.create({data: {type: 'BATCH', status: 'COMPLETED', globalInstructionStatus: 'VALIDATED', chunks: {create: {
    exploitationId: f.exploitations[0].id, pointPrelevementId: f.exploitations[0].pointPrelevementId,
    preleveurUserId: f.preleveur.id, usageId: f.offUsage.id, instructionStatus: 'VALIDATED',
    minDate: new Date('2025-10-31Z'), maxDate: new Date('2026-10-31Z'), chunkValues: {create: {
      metricTypeCode: 'volume prélevé', value: '99', unit: 'm³', frequency: 'irregular',
      periodStart: new Date('2025-10-31Z'), periodEnd: new Date('2026-10-31Z'), valueKind: 'DECLARED'
    }}
  }}}, include: {chunks: {include: {chunkValues: true}}}})
  const submitted = await submit(f)
  t.is(submitted.response.publicationStatus, 'PENDING_REVIEW')
  t.is((await activeVolumes(f)).length, 0)
  t.is((await prisma.chunkValue.findUnique({where: {id: source.chunks[0].chunkValues[0].id}})).value.toString(), '99')
  await prisma.chunk.update({where: {id: source.chunks[0].id}, data: {instructionStatus: 'REJECTED'}})
  const corrected = await submit(f, 0, {data: {...submitted.response.submittedData, comment: 'Conflit vérifié'}, revision: 1})
  t.is(corrected.response.publicationStatus, 'PUBLISHED')
  t.is((await activeVolumes(f)).reduce((sum, row) => sum + Number(row.value), 0), 160)
  t.is((await prisma.chunkValue.findUnique({where: {id: source.chunks[0].chunkValues[0].id}})).value.toString(), '99')
})

integration('review includes dated attachment changes and preserves explicitly out-of-campaign shares', async t => {
  const f = await fixture({shared: true})
  await submit(f)
  await submit(f, 1)
  const before = await getCampaignMeterReview({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id})
  const version = await prisma.meterAllocationVersion.findFirst({where: {allocation: {compteurId: f.meter.id}}})
  await prisma.meterAllocationVersion.update({where: {id: version.id}, data: {startDate: new Date('2025-10-01Z')}})
  const after = await getCampaignMeterReview({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id})
  t.not(after.expectedHash, before.expectedHash)
  const outside = await fixture()
  await prisma.meterAllocation.create({data: {sourceId: randomUUID(), provider: 'synthetic-reference', scope: f.campaign.id,
    compteurId: f.meter.id, exploitationId: outside.exploitations[0].id, versions: {create: {version: 1, enabled: false}}}})
  const review = await getCampaignMeterReview({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id})
  t.true(review.canApprove)
  t.false(review.beneficiaries.find(row => row.exploitationId === outside.exploitations[0].id).inCampaign)
  const allocations = [...f.exploitations, outside.exploitations[0]].map((row, index) => ({exploitationId: row.id,
    offSeasonPercentage: ['50', '30', '20'][index], seasonPercentage: ['50', '30', '20'][index], additive: false}))
  const result = await approveCampaignMeter({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id,
    body: {expectedHash: review.expectedHash, confirmHistorical: true, allocations}}, {now})
  t.is(result.status, 'PUBLISHED')
  t.is((await activeVolumes(f)).reduce((sum, row) => sum + Number(row.value), 0), 128)
  t.is((await activeVolumes(outside)).length, 0)
})

integration('two meters on the same dates remain distinct in declaration history', async t => {
  const f = await fixture()
  const second = await prisma.compteur.create({data: {serialNumber: `SECOND-${randomUUID()}`}})
  await prisma.meterAllocation.create({data: {sourceId: randomUUID(), provider: 'synthetic-reference', scope: f.campaign.id,
    compteurId: second.id, exploitationId: f.exploitations[0].id, versions: {create: {version: 1, enabled: false}}}})
  const data = structuredClone(f.data)
  data.meters.push({...structuredClone(data.meters[0]), compteurId: second.id, serialNumber: second.serialNumber})
  const result = await submit(f, 0, {data})
  t.is(result.response.publicationStatus, 'PENDING_REVIEW')
  let payload
  await getDeclarationDetailHandler({user: {...f.preleveur, declarant: {declarantRole: 'PRELEVEUR'}}, params: {declarationId: result.response.declarationId}},
    {json: value => { payload = value }}, error => { throw error })
  const declaration = payload.data?.declaration ?? payload.declaration ?? payload.data ?? payload
  t.is(declaration.source.chunks.length, 6)
  for (const chunk of declaration.source.chunks) {
    t.is(chunk.latestIndexReadings.length, 3)
    t.true(chunk.latestIndexReadings.every(row => row.compteurId === chunk.compteurId && row.valueStatus === 'ACTIVE'))
    t.true(chunk.chunkValues.every(row => !row.isOverwritten))
  }
})
