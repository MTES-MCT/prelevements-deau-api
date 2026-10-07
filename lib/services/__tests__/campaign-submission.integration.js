/* eslint-disable no-await-in-loop -- Fixtures and reconstruction checks deliberately run serially against the disposable database. */
import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import {PassThrough} from 'node:stream'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {submitCampaignResponse} from '../campaign-submission.js'
import {getCampaignMeterReview, approveCampaignMeter} from '../campaign-meter-publication.js'
import {saveCollectionResponseDraft, getAuthorizedCampaignResponseContext, getCollectionResults, getCampaignResponseVolumes} from '../collection-campaigns.js'
import {reconstructVolumesFromIndexForPoint} from '../volumes-from-index.js'
import {meterHash, meterBusinessDateBoundary} from '../meter-core.js'
import {getDeclarationDetailHandler} from '../../handlers/declarations.js'
import {exportCollectionResultsHandler} from '../../handlers/collection-campaigns.js'
import {getCampaignResponsePublicationPlan, recheckCampaignResponsePublication, recheckCampaignResponsePublicationInTransaction} from '../campaign-auto-publication.js'
import {persistMeterReadingInTransaction} from '../meter-ingestion.js'
import {reprocessMeterStreamInTransaction} from '../meter-publication.js'
import {CAMPAIGN_VOLUME_BOUNDARIES} from '../campaign-publication-plan.js'

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

function submit(f, index = 0, {user = f.preleveur, data = f.data, revision = 0, submittedAt = now} = {}) {
  return submitCampaignResponse({user, campaignId: f.campaign.id, responseId: f.responses[index].id, body: {revision, data}}, {now: submittedAt})
}

async function activeVolumes(f) {
  return prisma.chunkValue.findMany({where: {metricTypeCode: 'volume', chunk: {exploitationId: {in: f.exploitations.map(row => row.id)}, instructionStatus: {not: 'REJECTED'}, source: {status: 'COMPLETED'}}}, include: {chunk: true}})
}

async function diagnostics(result) {
  return prisma.collectionResponse.findUniqueOrThrow({where: {id: result.response.id}, select: {publicationStatus: true, publicationIssues: true}})
}

async function historicalAllocations(f, {compteurId = f.meter.id, additive = false, delayed = false, supplier = false, missingEnd = false} = {}) {
  const allocations = await prisma.meterAllocation.findMany({where: {compteurId}, orderBy: {sourceId: 'asc'}})
  const snapshot = allocations.map((row, index) => ({key: row.sourceId,
    percentage: allocations.length === 1 ? '100' : (index ? '40' : '60'), inScope: true}))
  for (const [index, allocation] of allocations.entries()) {
    for (const period of [0, 1]) await prisma.meterAllocationVersion.create({data: {
      allocationId: allocation.id, version: period + 2, enabled: true, additive,
      percentage: snapshot[index].percentage, startDate: delayed && period === 0 ? new Date('2026-01-01Z') : CAMPAIGN_VOLUME_BOUNDARIES[period],
      endDate: CAMPAIGN_VOLUME_BOUNDARIES[period + 1], usageId: period ? f.seasonUsage.id : f.offUsage.id,
      metadata: {allocationSnapshot: snapshot, allocationSnapshotValidated: true,
        historicalPublication: {reference: 'synthetic-authoritative-history', confirmedBy: f.admin.id,
          confirmedAt: '2026-09-01T00:00:00Z', from: CAMPAIGN_VOLUME_BOUNDARIES[0].toISOString(), to: CAMPAIGN_VOLUME_BOUNDARIES[2].toISOString()}}
    }})
  }
  if (!supplier) return
  return prisma.$transaction(async tx => {
    const stream = await tx.meterStream.create({data: {compteurId, provider: allocations[0].provider, scope: allocations[0].scope,
      externalId: compteurId, enabled: true, activatedAt: new Date('2025-01-01Z'), allocationSnapshot: snapshot, allocationSnapshotValidated: true}})
    const ingestion = await tx.meterIngestion.create({data: {provider: stream.provider, scope: stream.scope, batchId: randomUUID(),
      mode: 'LIVE', fetchedAt: now, windowStart: CAMPAIGN_VOLUME_BOUNDARIES[0], windowEnd: CAMPAIGN_VOLUME_BOUNDARIES[2], payloadHash: 'synthetic', rawPayload: {}}})
    for (const index of (missingEnd ? [0, 1] : [0, 1, 2])) await persistMeterReadingInTransaction(tx,
      {stream, raw: {}, normalized: {observedAt: CAMPAIGN_VOLUME_BOUNDARIES[index], index: ['100', '200', '260'][index], admissible: true}}, ingestion,
      {unchanged: 0, accepted: 0, blocked: 0})
    await reprocessMeterStreamInTransaction(tx, stream)
    return stream
  })
}

integration('reported decreasing readings are submitted unchanged, informative in results and never generate reset volumes', async t => {
  const f = await fixture()
  const data = structuredClone(f.data)
  Object.assign(data.meters[0], {meterChanged: true, meterChangeReason: 'Compteur remplacé'})
  data.meters[0].offSeason.indexEnd = '20'
  data.meters[0].season.indexEnd = '50'
  const result = await submit(f, 0, {data})
  t.is(result.response.status, 'SUBMITTED')
  for (const field of ['publicationStatus', 'publicationIssues', 'publicationStatusLabel']) t.false(Object.hasOwn(result.response, field))
  t.deepEqual((await diagnostics(result)).publicationIssues.map(issue => issue.code), ['METER_CHANGE_REPORTED'])
  const readings = await prisma.chunkValue.findMany({where: {chunk: {source: {declarationId: result.response.declarationId}}, valueKind: 'DECLARED'}, orderBy: {periodStart: 'asc'}})
  t.deepEqual(readings.map(row => row.value.toString()), ['100', '20', '50'])
  t.deepEqual(await activeVolumes(f), [])
  await reconstructVolumesFromIndexForPoint(f.exploitations[0].pointPrelevementId)
  t.deepEqual(await activeVolumes(f), [])
  const results = await getCollectionResults(f.collector, f.campaign.id, {page: 1, pageSize: 20, view: 'summary'})
  t.deepEqual(results.items[0].meterChanges, [{compteurId: f.meter.id, serialNumber: f.meter.serialNumber, meterChangeReason: 'Compteur remplacé'}])
  t.is(results.totals.publishedVolumes.total, 30)
  t.true(results.totals.publishedVolumes.partial)
  t.false(results.warnings.some(text => text.includes('attente de validation')))
  t.false((await getCampaignMeterReview({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id})).canApprove)
})

integration('a reported change removes only derived intervals in its scope and durably prevents bridging earlier and later sources', async t => {
  const f = await fixture()
  const otherMeter = await prisma.compteur.create({data: {serialNumber: `OTHER-${randomUUID()}`}})
  const sources = []
  for (const [compteurId, values] of [[f.meter.id, ['1000', '50']], [otherMeter.id, ['10', '30']]]) {
    sources.push(await prisma.source.create({data: {type: 'BATCH', status: 'COMPLETED', globalInstructionStatus: 'VALIDATED', chunks: {create: {
      compteurId, exploitationId: f.exploitations[0].id, pointPrelevementId: f.exploitations[0].pointPrelevementId,
      preleveurUserId: f.preleveur.id, usageId: f.offUsage.id, instructionStatus: 'VALIDATED',
      minDate: new Date('2025-10-01Z'), maxDate: new Date('2026-12-01Z'), chunkValues: {create: values.map((value, index) => ({
        metricTypeCode: 'index', value, unit: 'm³', frequency: 'instant', valueKind: 'DECLARED',
        periodStart: new Date(index ? '2026-12-01Z' : '2025-10-01Z'), periodEnd: new Date(index ? '2026-12-01T00:15:00Z' : '2025-10-01T00:15:00Z')
      }))}
    }}}, include: {chunks: {include: {chunkValues: true}}}}))
  }
  await reconstructVolumesFromIndexForPoint(f.exploitations[0].pointPrelevementId)
  t.is((await activeVolumes(f)).length, 2)
  const otherBefore = (await activeVolumes(f)).filter(row => row.chunk.compteurId === otherMeter.id)
  const data = structuredClone(f.data)
  Object.assign(data.meters[0], {meterChanged: true, meterChangeReason: 'Remplacement malgré des index croissants'})
  await submit(f, 0, {data})
  t.deepEqual((await activeVolumes(f)).filter(row => row.chunk.compteurId === otherMeter.id), otherBefore)
  t.is((await activeVolumes(f)).filter(row => row.chunk.compteurId === f.meter.id).length, 0)
  await reconstructVolumesFromIndexForPoint(f.exploitations[0].pointPrelevementId)
  t.is((await activeVolumes(f)).filter(row => row.chunk.compteurId === f.meter.id).length, 0)
  t.is((await activeVolumes(f)).find(row => row.chunk.compteurId === otherMeter.id).value.toString(), '20')
  for (const source of sources) {
    t.deepEqual(await prisma.chunkValue.findMany({where: {chunkId: source.chunks[0].id, valueKind: 'DECLARED'}, orderBy: {periodStart: 'asc'}}), source.chunks[0].chunkValues.sort((a, b) => a.periodStart - b.periodStart))
  }
})

integration('a flag-only correction withdraws shared campaign publication and stale approval cannot republish it', async t => {
  const f = await fixture({shared: true})
  const first = await submit(f)
  await submit(f, 1)
  const review = await getCampaignMeterReview({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id})
  const body = {expectedHash: review.expectedHash, confirmHistorical: true, allocations: f.exploitations.map(row => ({exploitationId: row.id, offSeasonPercentage: '50', seasonPercentage: '50', additive: false}))}
  await approveCampaignMeter({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id, body}, {now})
  t.is((await activeVolumes(f)).length, 4)
  const data = structuredClone(first.response.submittedData)
  Object.assign(data.meters[0], {meterChanged: true, meterChangeReason: 'Remplacement signalé après envoi'})
  const result = await submit(f, 0, {data, revision: 1})
  t.is((await activeVolumes(f)).length, 0)
  const peer = await getAuthorizedCampaignResponseContext(f.preleveur, f.campaign.id, f.responses[1].id)
  t.deepEqual((await diagnostics(peer)).publicationIssues.map(issue => issue.code), ['METER_CHANGE_REPORTED'])
  t.false(Object.hasOwn(peer.response, 'publicationStatusLabel'))
  t.is((await t.throwsAsync(approveCampaignMeter({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id, body}, {now}))).status, 409)
  t.is((await submit(f, 0, {data: result.response.submittedData, revision: 1})).response.revision, 2)
  t.is((await activeVolumes(f)).length, 0)
})

integration('withdrawing a mistaken report clears informational labels on every shared receipt even before a stream exists', async t => {
  const f = await fixture({shared: true})
  const first = await submit(f)
  await submit(f, 1)
  const data = structuredClone(first.response.submittedData)
  Object.assign(data.meters[0], {meterChanged: true, meterChangeReason: 'Signalement erroné'})
  await submit(f, 0, {data, revision: 1})
  t.is(await prisma.meterStream.count({where: {compteurId: f.meter.id}}), 0)
  await submit(f, 0, {data: first.response.submittedData, revision: 2})
  const peer = await getAuthorizedCampaignResponseContext(f.preleveur, f.campaign.id, f.responses[1].id)
  t.false((await diagnostics(peer)).publicationIssues.some(issue => issue.code === 'METER_CHANGE_REPORTED'))
  t.true((await getCampaignMeterReview({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id})).canApprove)
  t.false((await prisma.chunk.findMany({where: {compteurId: f.meter.id}})).some(chunk => chunk.metadata?.campaignMeterChangeBlocked))
  t.is((await t.throwsAsync(submit(f, 0, {data: {}, revision: 3}))).status, 400)
})

for (const firstActor of ['collector', 'preleveur']) {
  integration(`${firstActor} submits, the other actor corrects, and receipt attribution preserves the beneficiary and initial creator`, async t => {
    const f = await fixture({existingMeter: false})
    const initialActor = f[firstActor]
    const correctionActor = firstActor === 'collector' ? f.preleveur : f.collector
    const first = await submit(f, 0, {user: initialActor})
    const declarationId = first.response.declarationId
    const compteurId = first.response.submittedData.meters[0].compteurId
    const receipt = () => prisma.declaration.findUniqueOrThrow({where: {id: declarationId}, include: {source: {include: {chunks: true}}}})
    const assertAttribution = (declaration, actor) => {
      t.is(declaration.declarantUserId, f.preleveur.id)
      t.is(declaration.createdByDeclarantUserId, initialActor.id)
      t.is(declaration.source.chunks.length, 3)
      for (const chunk of declaration.source.chunks) {
        t.is(chunk.preleveurUserId, f.preleveur.id)
        t.is(chunk.exploitationId, f.exploitations[0].id)
        t.is(chunk.submittedByDeclarantUserId, actor.id)
        t.is(chunk.collecteurUserId, actor.id === f.collector.id ? actor.id : null)
      }
    }
    const original = await receipt()
    assertAttribution(original, initialActor)
    const allocation = await prisma.meterAllocation.findFirstOrThrow({where: {compteurId, exploitationId: f.exploitations[0].id}})
    t.is(allocation.metadata.declaredBy, initialActor.id)
    t.is(first.response.preleveurUserId, f.preleveur.id)
    t.is((await diagnostics(first)).publicationStatus, 'PUBLISHED')
    const replay = await submit(f, 0, {user: correctionActor, data: first.response.submittedData, revision: 0})
    t.is(replay.response.revision, 1)
    t.is(replay.response.declarationId, declarationId)
    t.deepEqual(await receipt(), original, 'An exact cross-actor replay must not change attribution or timestamps.')

    const changed = structuredClone(first.response.submittedData)
    changed.meters[0].season.indexEnd = '280'
    await saveCollectionResponseDraft(correctionActor, f.campaign.id, f.responses[0].id, {revision: 1, data: changed})
    t.is((await t.throwsAsync(submit(f, 0, {user: initialActor, data: changed, revision: 1}))).status, 409)
    const corrected = await submit(f, 0, {user: correctionActor, data: changed, revision: 2})
    t.is(corrected.response.revision, 3)
    t.is(corrected.response.declarationId, declarationId)
    t.is(corrected.response.preleveurUserId, f.preleveur.id)
    assertAttribution(await receipt(), correctionActor)
    t.is((await activeVolumes(f)).reduce((sum, row) => sum + Number(row.value), 0), 180)
    t.is(await prisma.declaration.count({where: {importSourceId: `collection-response:${f.responses[0].id}`}}), 1)
    t.is((await prisma.meterAllocation.findUniqueOrThrow({where: {id: allocation.id}})).metadata.declaredBy, initialActor.id)

    const changedAgain = structuredClone(corrected.response.submittedData)
    changedAgain.meters[0].season.indexEnd = '290'
    const resumed = await submit(f, 0, {user: initialActor, data: changedAgain, revision: 3})
    t.is(resumed.response.revision, 4)
    assertAttribution(await receipt(), initialActor)
    t.is((await activeVolumes(f)).reduce((sum, row) => sum + Number(row.value), 0), 190)
    await prisma.declarantCollecteurExploitation.deleteMany({where: {collecteurUserId: f.collector.id, exploitationId: f.exploitations[0].id}})
    t.is((await t.throwsAsync(submit(f, 0, {user: f.collector, data: resumed.response.submittedData, revision: 4}))).status, 404)
    t.is((await submit(f, 0, {user: f.preleveur, data: resumed.response.submittedData, revision: 4})).response.revision, 4)
  })
}

integration('before October 31 campaign creates a stable receipt, computes both seasons and allows replay and correction', async t => {
  const f = await fixture({existingMeter: false})
  const submittedAt = new Date('2026-09-24T12:00:00Z')
  const result = await submit(f, 0, {submittedAt})
  t.is((await diagnostics(result)).publicationStatus, 'PUBLISHED')
  t.is(result.response.revision, 1)
  t.deepEqual(result.response.firstSubmittedAt, submittedAt)
  t.deepEqual(result.response.lastSubmittedAt, submittedAt)
  const readings = await prisma.chunkValue.findMany({where: {metricTypeCode: 'index', valueKind: 'DECLARED',
    chunk: {source: {declarationId: result.response.declarationId}}}, orderBy: {periodStart: 'asc'}})
  t.deepEqual(readings.map(reading => reading.periodStart.toISOString().slice(0, 10)), ['2025-11-01', '2026-05-31', '2026-10-31'])
  t.deepEqual(readings.map(reading => reading.value.toString()), ['100', '200', '260'])
  const meterId = result.response.submittedData.meters[0].compteurId
  t.truthy(meterId)
  t.is(await prisma.meterAllocation.count({where: {compteurId: meterId, exploitationId: f.exploitations[0].id}}), 1)
  const volumes = await activeVolumes(f)
  t.deepEqual(volumes.map(row => [row.periodStart.toISOString(), row.periodEnd.toISOString()]).sort(), [
    ['2025-11-01T00:15:00.000Z', '2026-05-31T00:15:00.000Z'],
    ['2026-05-31T00:15:00.000Z', '2026-10-31T00:15:00.000Z']
  ])
  t.is(volumes.reduce((sum, row) => sum + Number(row.value), 0), 160)
  t.is(volumes.find(row => Number(row.value) === 100).chunk.usageId, f.offUsage.id)
  t.is(volumes.find(row => Number(row.value) === 60).chunk.usageId, f.seasonUsage.id)
  const replay = await submit(f, 0, {submittedAt})
  t.is(replay.response.revision, 1)
  t.is(replay.response.declarationId, result.response.declarationId)
  const changed = structuredClone(result.response.submittedData)
  changed.meters[0].season.indexEnd = '280'
  const correctedAt = new Date('2026-09-25T12:00:00Z')
  const corrected = await submit(f, 0, {data: changed, revision: 1, submittedAt: correctedAt})
  t.is(corrected.response.declarationId, result.response.declarationId)
  t.is(corrected.response.revision, 2)
  t.deepEqual(corrected.response.firstSubmittedAt, submittedAt)
  t.deepEqual(corrected.response.lastSubmittedAt, correctedAt)
  t.is((await activeVolumes(f)).reduce((sum, row) => sum + Number(row.value), 0), 180)
  t.is(await prisma.declaration.count({where: {importSourceId: `collection-response:${f.responses[0].id}`}}), 1)
})

integration('legacy anonymous receipts replay unchanged, but a correction requires completing the same meter number', async t => {
  const f = await fixture()
  const first = await submit(f)
  const legacy = structuredClone(first.response.submittedData)
  legacy.meters[0].serialNumber = null
  await prisma.compteur.update({where: {id: f.meter.id}, data: {serialNumber: null}})
  await prisma.collectionResponse.update({where: {id: f.responses[0].id}, data: {draftData: legacy, submittedData: legacy}})
  const before = await prisma.collectionResponse.findUnique({where: {id: f.responses[0].id}})
  const volumes = await activeVolumes(f)
  const replay = await submit(f, 0, {data: {...legacy, meters: legacy.meters.map(meter => ({...meter, meterChanged: false, meterChangeReason: ''}))}})
  t.is(replay.response.revision, 1)
  t.deepEqual(await prisma.collectionResponse.findUnique({where: {id: f.responses[0].id}}), before)
  t.deepEqual(await activeVolumes(f), volumes)
  const corrected = structuredClone(legacy)
  corrected.meters[0].season.indexEnd = '280'
  t.truthy((await t.throwsAsync(submit(f, 0, {data: corrected, revision: 1}))).data.fields['meters.0.serialNumber'])
  corrected.meters[0].serialNumber = `COMPLETED-${randomUUID()}`
  const completed = await submit(f, 0, {data: corrected, revision: 1})
  t.is(completed.response.submittedData.meters[0].compteurId, f.meter.id)
  t.is((await prisma.compteur.findUnique({where: {id: f.meter.id}})).serialNumber, corrected.meters[0].serialNumber)
  t.is(await prisma.meterAllocation.count({where: {exploitationId: f.exploitations[0].id}}), 1)
})

integration('an allocated meter without a number must be completed and cannot be renumbered onto another meter', async t => {
  const f = await fixture()
  await prisma.compteur.update({where: {id: f.meter.id}, data: {serialNumber: null}})
  const data = structuredClone(f.data)
  data.meters[0].serialNumber = null
  t.truthy((await t.throwsAsync(submit(f, 0, {data}))).data.fields['meters.0.serialNumber'])
  const other = await fixture()
  data.meters[0].serialNumber = other.meter.serialNumber.toLowerCase()
  t.is((await t.throwsAsync(submit(f, 0, {data}))).status, 409)
  t.is((await prisma.compteur.findUnique({where: {id: f.meter.id}})).serialNumber, null)
  t.is((await prisma.collectionResponse.findUnique({where: {id: f.responses[0].id}})).revision, 0)
})

integration('an arbitrary meter UUID cannot be claimed without a number or a previous submitted claim', async t => {
  const f = await fixture({existingMeter: false})
  const other = await fixture()
  const data = structuredClone(f.data)
  data.meters[0] = {...data.meters[0], compteurId: other.meter.id, serialNumber: null}
  t.is((await t.throwsAsync(submit(f, 0, {data}))).status, 403)
  t.is(await prisma.meterAllocation.count({where: {exploitationId: f.exploitations[0].id}}), 0)
  t.is(await prisma.declaration.count({where: {importSourceId: `collection-response:${f.responses[0].id}`}}), 0)
})

integration('legacy submission hashes still accept an exact replay after server meter resolution', async t => {
  const f = await fixture({existingMeter: false})
  const first = await submit(f)
  const legacyHash = meterHash({...f.data, meters: f.data.meters.map(({compteurId: _compteurId, ...meter}) => ({...meter, serialNumber: meter.serialNumber.toUpperCase()}))})
  await prisma.collectionResponse.update({where: {id: f.responses[0].id}, data: {submittedHash: legacyHash}})
  const replay = await submit(f, 0, {data: first.response.submittedData})
  t.is(replay.response.revision, 1)
  t.is(replay.response.declarationId, first.response.declarationId)
  t.is(await prisma.meterAllocation.count({where: {exploitationId: f.exploitations[0].id}}), 1)
})

integration('concurrent completion of the same serial number keeps one owner and returns a conflict', async t => {
  const first = await fixture()
  const second = await fixture()
  const serialNumber = `CONCURRENT-${randomUUID()}`
  await prisma.compteur.updateMany({where: {id: {in: [first.meter.id, second.meter.id]}}, data: {serialNumber: null}})
  const inputs = [first, second].map(f => ({...f.data, meters: [{...f.data.meters[0], serialNumber}]}))
  const results = await Promise.allSettled([submit(first, 0, {data: inputs[0]}), submit(second, 0, {data: inputs[1]})])
  t.is(results.filter(result => result.status === 'fulfilled').length, 1)
  t.is(results.find(result => result.status === 'rejected').reason.status, 409)
  t.is(await prisma.compteur.count({where: {serialNumber}}), 1)
  t.is(await prisma.collectionResponse.count({where: {id: {in: [first.responses[0].id, second.responses[0].id]}, firstSubmittedAt: {not: null}}}), 1)
})

integration('crop arrays survive draft reload, submission and CSV export alongside historical text', async t => {
  const f = await fixture()
  const data = structuredClone(f.data)
  data.meters[0].offSeason.crops = ['Céréales', 'Maïs']
  data.meters[0].season.crops = ['Légumes', 'Haricots']
  data.needs.offSeason.crops = []
  await saveCollectionResponseDraft(f.preleveur, f.campaign.id, f.responses[0].id, {revision: 0, data})
  const draft = await getAuthorizedCampaignResponseContext(f.preleveur, f.campaign.id, f.responses[0].id)
  t.deepEqual(draft.data.meters[0].offSeason.crops, ['Céréales', 'Maïs'])
  t.deepEqual(draft.data.needs.offSeason.crops, [])
  t.is(draft.response.declarationId, null)
  data.needs.offSeason.crops = ['Oléagineux', 'Tournesol']
  const result = await submit(f, 0, {data, revision: 1})
  t.is((await diagnostics(result)).publicationStatus, 'PUBLISHED')
  const reloaded = await getAuthorizedCampaignResponseContext(f.collector, f.campaign.id, f.responses[0].id)
  t.deepEqual(reloaded.response.submittedData.meters[0].offSeason.crops, ['Céréales', 'Maïs'])
  t.deepEqual(reloaded.response.submittedData.meters[0].season.crops, ['Légumes', 'Haricots'])
  t.deepEqual(reloaded.response.submittedData.needs.offSeason.crops, ['Oléagineux', 'Tournesol'])
  t.is(reloaded.response.submittedData.needs.season.crops, 'Culture synthétique')
  t.is(await prisma.chunkValue.count({where: {metricTypeCode: 'index', chunk: {source: {declarationId: result.response.declarationId}}}}), 3)
  const output = new PassThrough()
  output.set = () => output
  let csv = ''
  output.on('data', chunk => { csv += chunk.toString() })
  await exportCollectionResultsHandler({user: f.collector, params: {campaignId: f.campaign.id}, query: {}}, output)
  for (const label of ['Céréales, Maïs', 'Légumes, Haricots', 'Oléagineux, Tournesol', 'Culture synthétique', 'Hors étiage 2027–2028']) t.true(csv.includes(`;"${label}";`))
})

integration('replenishment proposals round-trip through draft, submission and exports without agricultural fields', async t => {
  const f = await fixture()
  const root = await prisma.sandreWaterUse.findUniqueOrThrow({where: {code: '12'}})
  const child = await prisma.sandreWaterUse.findUniqueOrThrow({where: {code: '12E'}})
  const data = structuredClone(f.data)
  for (const section of [data.meters[0], data.needs]) {
    for (const period of ['offSeason', 'season']) {
      section[period].usageId = period === 'offSeason' ? child.id : root.id
      delete section[period].surface
      delete section[period].crops
    }
  }
  const proposal = {meters: [{compteurId: f.meter.id, offSeason: {indexStart: '100'}}], needs: data.needs}
  await prisma.collectionResponse.update({where: {id: f.responses[0].id}, data: {
    prefillData: proposal, prefillMetadata: {version: 1, rows: [2], sourceSha256: 'synthetic-source-hash'}
  }})
  const initial = await getAuthorizedCampaignResponseContext(f.preleveur, f.campaign.id, f.responses[0].id)
  t.true(initial.prefill.active)
  t.is(initial.data.meters[0].offSeason.indexStart, '100')
  t.deepEqual(initial.data.needs, data.needs)
  await saveCollectionResponseDraft(f.preleveur, f.campaign.id, f.responses[0].id, {revision: 0, data})
  const result = await submit(f, 0, {data, revision: 1})
  t.is((await diagnostics(result)).publicationStatus, 'PUBLISHED')
  t.false(result.prefill.active)
  t.deepEqual(result.response.submittedData, data)
  t.is((await activeVolumes(f)).reduce((sum, row) => sum + Number(row.value), 0), 160)
  const output = new PassThrough()
  output.set = () => output
  let csv = ''
  output.on('data', chunk => { csv += chunk.toString() })
  await exportCollectionResultsHandler({user: f.collector, params: {campaignId: f.campaign.id}, query: {}}, output)
  t.true(csv.includes(`;"${child.label}";`))
  t.true(csv.includes(`;"${root.label}";`))
  t.false(csv.includes('synthetic-source-hash'))
  t.false(csv.includes('undefined'))
  t.false(csv.includes('null'))
})

integration('irrigation still requires agricultural fields even after the structural validation accepts them as optional', async t => {
  const f = await fixture({existingMeter: false})
  const irrigation = await prisma.sandreWaterUse.findUniqueOrThrow({where: {code: '2A'}})
  const data = structuredClone(f.data)
  data.needs.offSeason.usageId = irrigation.id
  delete data.needs.offSeason.surface
  delete data.needs.offSeason.crops
  const error = await t.throwsAsync(submit(f, 0, {data}))
  t.is(error.status, 400)
  t.deepEqual(Object.keys(error.data.fields), ['needs.offSeason.surface', 'needs.offSeason.crops'])
  t.is(await prisma.compteur.count({where: {serialNumber: data.meters[0].serialNumber}}), 0)
  t.is(await prisma.declaration.count({where: {importSourceId: `collection-response:${f.responses[0].id}`}}), 0)
})

integration('campaign refuses incomplete or decreasing readings without any writes even before October 31', async t => {
  const f = await fixture()
  const submittedAt = new Date('2026-09-24T12:00:00Z')
  const missing = structuredClone(f.data)
  delete missing.meters[0].offSeason.indexStart
  t.is((await t.throwsAsync(submit(f, 0, {data: missing, submittedAt}))).status, 400)
  const decreasing = structuredClone(f.data)
  decreasing.meters[0].season.indexEnd = '50'
  const error = await t.throwsAsync(submit(f, 0, {data: decreasing, submittedAt}))
  t.is(error.status, 400)
  t.deepEqual(Object.keys(error.data.fields), ['meters.0.meterChanged', 'meters.0.meterChangeReason'])
  t.is(await prisma.declaration.count({where: {importSourceId: `collection-response:${f.responses[0].id}`}}), 0)
})

integration('root usages and sub-usages remain selectable, published and labelled in campaign results', async t => {
  const f = await fixture()
  const root = await prisma.sandreWaterUse.create({data: {code: `C${randomUUID().slice(0, 12)}`, kind: 'USAGE', label: 'Usage parent synthétique'}})
  const data = structuredClone(f.data)
  data.meters[0].offSeason.usageId = root.id
  data.needs.offSeason.usageId = root.id
  const context = await getAuthorizedCampaignResponseContext(f.preleveur, f.campaign.id, f.responses[0].id)
  t.truthy(context.waterUses.find(usage => usage.id === root.id && usage.kind === 'USAGE'))
  t.truthy(context.waterUses.find(usage => usage.id === f.seasonUsage.id && usage.parentId === f.seasonUsage.parentId))
  const result = await submit(f, 0, {data})
  t.is((await diagnostics(result)).publicationStatus, 'PUBLISHED')
  t.is(result.response.submittedData.needs.offSeason.usageId, root.id)
  const volumes = await activeVolumes(f)
  t.is(volumes.find(row => Number(row.value) === 100).chunk.usageId, root.id)
  t.is(volumes.find(row => Number(row.value) === 60).chunk.usageId, f.seasonUsage.id)
  const exploitation = await prisma.declarantPointPrelevement.findUnique({where: {id: f.exploitations[0].id}, include: {secondaryUsageLinks: true}})
  t.true(exploitation.usageId === root.id || exploitation.secondaryUsageLinks.some(link => link.usageId === root.id))
  const results = await getCollectionResults(f.collector, f.campaign.id, {page: 1, pageSize: 20})
  t.is(results.waterUses.find(usage => usage.id === root.id).label, root.label)
  t.is(results.totals.publishedVolumes.total, 160)
  const output = new PassThrough()
  output.set = () => output
  let csv = ''
  output.on('data', chunk => { csv += chunk.toString() })
  await exportCollectionResultsHandler({user: f.collector, params: {campaignId: f.campaign.id}, query: {}}, output)
  t.true(csv.includes(';"Usage";'))
  t.true(csv.includes(`;"${root.label}";`))
  t.true(csv.includes(`;"${f.seasonUsage.label}";`))
  t.false(csv.includes(root.id))
})

integration('an incomplete draft with decreasing indices reloads without publishing a receipt or volumes', async t => {
  const f = await fixture()
  const data = structuredClone(f.data)
  data.meters[0].offSeason.indexEnd = '50'
  data.meters[0].season.indexEnd = ''
  const saved = await saveCollectionResponseDraft(f.preleveur, f.campaign.id, f.responses[0].id, {revision: 0, data})
  t.is(saved.response.revision, 1)
  const reloaded = await getAuthorizedCampaignResponseContext(f.preleveur, f.campaign.id, f.responses[0].id)
  t.is(reloaded.data.meters[0].offSeason.indexEnd, '50')
  t.is(reloaded.data.meters[0].season.indexEnd, '')
  t.is(reloaded.response.declarationId, null)
  t.is(reloaded.response.firstSubmittedAt, null)
  t.is((await activeVolumes(f)).length, 0)
})

integration('unknown usages target each invalid section without creating a meter or a receipt', async t => {
  const f = await fixture({existingMeter: false})
  const data = structuredClone(f.data)
  for (const period of ['offSeason', 'season']) {
    data.meters[0][period].usageId = randomUUID()
    data.needs[period].usageId = randomUUID()
  }
  const error = await t.throwsAsync(submit(f, 0, {data}))
  t.is(error.status, 400)
  t.deepEqual(Object.keys(error.data.fields), ['meters.0.offSeason.usageId', 'meters.0.season.usageId', 'needs.offSeason.usageId', 'needs.season.usageId'])
  t.is(await prisma.compteur.count({where: {serialNumber: data.meters[0].serialNumber}}), 0)
  t.is(await prisma.declaration.count({where: {importSourceId: `collection-response:${f.responses[0].id}`}}), 0)
})

integration('a conflicting historical index identifies its exact field and never replaces existing data', async t => {
  const f = await fixture()
  const source = await prisma.source.create({data: {type: 'BATCH', status: 'COMPLETED', globalInstructionStatus: 'VALIDATED', chunks: {create: {
    compteurId: f.meter.id, exploitationId: f.exploitations[0].id, pointPrelevementId: f.exploitations[0].pointPrelevementId,
    preleveurUserId: f.preleveur.id, usageId: f.offUsage.id, instructionStatus: 'VALIDATED',
    minDate: new Date('2026-05-31Z'), maxDate: new Date('2026-05-31Z'), chunkValues: {create: {
      metricTypeCode: 'index', value: '225', unit: 'm³', frequency: 'instant',
      periodStart: new Date('2026-05-31Z'), periodEnd: new Date('2026-05-31T00:15:00Z'), valueKind: 'DECLARED'
    }}
  }}}, include: {chunks: {include: {chunkValues: true}}}})
  const error = await t.throwsAsync(submit(f))
  t.is(error.status, 409)
  t.deepEqual(Object.keys(error.data.fields), ['meters.0.meterChanged', 'meters.0.meterChangeReason'])
  t.deepEqual(error.data.validationErrors, error.data.fields)
  t.is((await prisma.chunkValue.findUnique({where: {id: source.chunks[0].chunkValues[0].id}})).value.toString(), '225')
  const response = await prisma.collectionResponse.findUnique({where: {id: f.responses[0].id}})
  t.is(response.revision, 0)
  t.is(response.declarationId, null)
  await prisma.chunk.update({where: {id: source.chunks[0].id}, data: {instructionStatus: 'REJECTED'}})
  t.is((await diagnostics(await submit(f))).publicationStatus, 'PUBLISHED')
})

integration('before October 31 shared receipts wait for review; physical publication conserves 60/40 then 50/50', async t => {
  const f = await fixture({shared: true})
  const submittedAt = new Date('2026-09-24T12:00:00Z')
  const first = await submit(f, 0, {user: f.collector, submittedAt})
  await submit(f, 1, {submittedAt})
  t.is((await diagnostics(first)).publicationStatus, 'PENDING_REVIEW')
  t.is((await activeVolumes(f)).length, 0)
  for (const exploitation of f.exploitations) await reconstructVolumesFromIndexForPoint(exploitation.pointPrelevementId)
  t.is((await activeVolumes(f)).length, 0)
  const review = await getCampaignMeterReview({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id})
  t.true(review.canApprove)
  const body = {expectedHash: review.expectedHash, confirmHistorical: true, allocations: f.exploitations.map((row, index) => ({exploitationId: row.id,
    offSeasonPercentage: index ? '40' : '60', seasonPercentage: '50', additive: false}))}
  const result = await approveCampaignMeter({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id, body}, {now: submittedAt})
  t.is(result.status, 'PUBLISHED')
  t.deepEqual(await approveCampaignMeter({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id, body}, {now: submittedAt}), result)
  const volumes = await activeVolumes(f)
  t.is(volumes.length, 4)
  t.is(volumes.reduce((sum, row) => sum + Number(row.value), 0), 160)
  t.is(volumes.filter(row => row.chunk.exploitationId === f.exploitations[0].id).reduce((sum, row) => sum + Number(row.value), 0), 90)
  t.true(volumes.every(row => row.chunk.calculationStrategy === 'METER'))
  const boundaries = ['2025-11-01', '2026-05-31', '2026-10-31'].map(date => meterBusinessDateBoundary(date).toISOString())
  t.deepEqual([...new Set(volumes.map(row => `${row.periodStart.toISOString()}/${row.periodEnd.toISOString()}`))].sort(), [
    `${boundaries[0]}/${boundaries[1]}`, `${boundaries[1]}/${boundaries[2]}`
  ])
  t.is(volumes.find(row => Number(row.value) === 60).chunk.usageId, f.offUsage.id)
  const changedNeeds = structuredClone(first.response.submittedData)
  changedNeeds.needs.season.volume = '700'
  const needsOnly = await submit(f, 0, {data: changedNeeds, revision: 1, submittedAt})
  t.is((await diagnostics(needsOnly)).publicationStatus, 'PUBLISHED')
  t.is((await activeVolumes(f)).reduce((sum, row) => sum + Number(row.value), 0), 160)
  const changed = structuredClone(first.response.submittedData)
  changed.meters[0].season.indexEnd = '280'
  const corrected = await submit(f, 0, {data: changed, revision: 2, submittedAt})
  t.is((await diagnostics(corrected)).publicationStatus, 'PENDING_REVIEW')
  t.is((await activeVolumes(f)).length, 0)
  const next = await getCampaignMeterReview({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id})
  t.true(next.contradictoryReadings)
  t.is((await t.throwsAsync(approveCampaignMeter({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id,
    body: {...body, expectedHash: next.expectedHash}}, {now: new Date('2026-09-25T12:00:00Z')}))).status, 409)
  const approved = await approveCampaignMeter({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id,
    body: {...body, expectedHash: next.expectedHash, canonicalResponseId: f.responses[0].id}}, {now: new Date('2026-09-25T12:00:00Z')})
  t.is(approved.status, 'PUBLISHED')
  t.is((await activeVolumes(f)).reduce((sum, row) => sum + Number(row.value), 0), 180)
})

integration('a known number from another exploitation is a claim, not an automatic association', async t => {
  const f = await fixture({existingMeter: false})
  const other = await fixture()
  const data = structuredClone(f.data)
  data.meters[0].serialNumber = other.meter.serialNumber
  const result = await submit(f, 0, {data})
  t.is((await diagnostics(result)).publicationStatus, 'PENDING_REVIEW')
  t.deepEqual(result.response.volumes, {offSeason: 100, season: 60, total: 160, partial: false})
  t.is(await prisma.meterAllocation.count({where: {compteurId: other.meter.id, exploitationId: f.exploitations[0].id}}), 0)
  t.is((await activeVolumes(f)).length, 0)
  t.is((await t.throwsAsync(getAuthorizedCampaignResponseContext(other.preleveur, f.campaign.id, f.responses[0].id))).status, 404)
})

integration('supplier streams and observations are never altered by campaign review', async t => {
  const f = await fixture()
  const stream = await prisma.meterStream.create({data: {provider: 'synthetic-provider', scope: 'external', externalId: f.meter.id,
    compteurId: f.meter.id, enabled: false, checkpoint: new Date('2026-09-01Z')}})
  const result = await submit(f)
  t.is((await diagnostics(result)).publicationStatus, 'PENDING_REVIEW')
  const review = await getCampaignMeterReview({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id})
  t.false(review.canApprove)
  t.is((await t.throwsAsync(approveCampaignMeter({user: f.admin, campaignId: f.campaign.id, compteurId: f.meter.id,
    body: {expectedHash: review.expectedHash, confirmHistorical: true, allocations: [{exploitationId: f.exploitations[0].id, offSeasonPercentage: '100', seasonPercentage: '100'}]}}, {now}))).status, 409)
  t.deepEqual(await prisma.meterStream.findUnique({where: {id: stream.id}}), stream)
  t.is(await prisma.meterReading.count({where: {compteurId: f.meter.id}}), 0)
})

integration('saving a shared correction draft leaves the submitted receipt and published volumes untouched', async t => {
  const f = await fixture()
  const result = await submit(f)
  const changed = structuredClone(result.response.submittedData)
  changed.meters[0].season.indexEnd = '290'
  await saveCollectionResponseDraft(f.preleveur, f.campaign.id, f.responses[0].id, {revision: 1, data: changed})
  const collector = await getAuthorizedCampaignResponseContext(f.collector, f.campaign.id, f.responses[0].id)
  t.deepEqual(collector.response.draftData, changed)
  t.deepEqual(collector.data, changed)
  t.true(collector.response.permissions.canEdit)
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
    minDate: new Date('2025-11-01Z'), maxDate: new Date('2026-10-31Z'), chunkValues: {create: {
      metricTypeCode: 'volume prélevé', value: '99', unit: 'm³', frequency: 'irregular',
      periodStart: new Date('2025-11-01Z'), periodEnd: new Date('2026-10-31Z'), valueKind: 'DECLARED'
    }}
  }}}, include: {chunks: {include: {chunkValues: true}}}})
  const submitted = await submit(f)
  t.is((await diagnostics(submitted)).publicationStatus, 'PENDING_REVIEW')
  t.is((await activeVolumes(f)).length, 0)
  t.is((await prisma.chunkValue.findUnique({where: {id: source.chunks[0].chunkValues[0].id}})).value.toString(), '99')
  await prisma.chunk.update({where: {id: source.chunks[0].id}, data: {instructionStatus: 'REJECTED'}})
  const corrected = await submit(f, 0, {data: {...submitted.response.submittedData, comment: 'Conflit vérifié'}, revision: 1})
  t.is((await diagnostics(corrected)).publicationStatus, 'PUBLISHED')
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
  t.is((await diagnostics(result)).publicationStatus, 'PENDING_REVIEW')
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

integration('proven historical shared allocations publish automatically when beneficiaries submit, without changing the authority', async t => {
  const f = await fixture({shared: true})
  await historicalAllocations(f)
  const authoritative = await prisma.meterAllocationVersion.findMany({where: {allocation: {compteurId: f.meter.id}}, orderBy: {id: 'asc'}})
  const first = await submit(f)
  t.is((await diagnostics(first)).publicationStatus, 'PENDING_REVIEW')
  t.is((await diagnostics(first)).publicationIssues[0].code, 'BENEFICIARY_RESPONSE_MISSING')
  t.false(Object.hasOwn(first.response, 'publicationStatusLabel'))
  const second = await submit(f, 1)
  t.is((await diagnostics(second)).publicationStatus, 'PUBLISHED')
  t.is((await prisma.collectionResponse.findUnique({where: {id: f.responses[0].id}})).publicationStatus, 'PUBLISHED')
  const volumes = await activeVolumes(f)
  t.is(volumes.length, 4)
  t.is(volumes.reduce((sum, row) => sum + Number(row.value), 0), 160)
  t.true(volumes.every(row => row.chunk.calculationStrategy === 'METER'))
  t.deepEqual(await prisma.meterAllocationVersion.findMany({where: {id: {in: authoritative.map(row => row.id)}}, orderBy: {id: 'asc'}}), authoritative)
  const derived = await prisma.meterAllocationVersion.findMany({where: {allocation: {compteurId: f.meter.id, provider: 'manual-collection'}, enabled: true}})
  t.is(derived.length, 4)
  t.true(derived.every(row => authoritative.some(original => original.id === row.metadata.authoritativeAllocationVersionId)))
  const results = await getCollectionResults(f.collector, f.campaign.id, {page: 1, pageSize: 20})
  t.is(results.totals.publishedVolumes.total, 320)
})

integration('historical recheck and its preview preserve submitted content, a later draft and receipt indices, and replay without writes', async t => {
  const f = await fixture({shared: true})
  const first = await submit(f)
  await submit(f, 1)
  const draft = structuredClone(first.response.submittedData)
  draft.needs.season.volume = '987'
  await saveCollectionResponseDraft(f.preleveur, f.campaign.id, f.responses[0].id, {revision: 1, data: draft})
  await historicalAllocations(f)
  const before = await prisma.collectionResponse.findUnique({where: {id: f.responses[0].id}})
  const indices = await prisma.chunkValue.findMany({where: {valueKind: 'DECLARED', chunk: {source: {declarationId: before.declarationId}}}, orderBy: {id: 'asc'}})
  const preview = await getCampaignResponsePublicationPlan(before.id, {now})
  t.is(preview.publicationStatus, 'PUBLISHED')
  t.true(preview.meters[0].plannedPublication)
  t.deepEqual(await prisma.collectionResponse.findUnique({where: {id: before.id}}), before)
  t.is(await prisma.meterStream.count({where: {compteurId: f.meter.id}}), 0)
  t.true((await recheckCampaignResponsePublication({responseId: before.id}, {now})).changed)
  const after = await prisma.collectionResponse.findUnique({where: {id: before.id}})
  for (const key of ['draftData', 'submittedData', 'submittedHash', 'revision', 'firstSubmittedAt', 'lastSubmittedAt', 'declarationId']) t.deepEqual(after[key], before[key], key)
  t.deepEqual(await prisma.chunkValue.findMany({where: {valueKind: 'DECLARED', chunk: {source: {declarationId: before.declarationId}}}, orderBy: {id: 'asc'}}), indices)
  const publications = await prisma.meterPublication.findMany({where: {compteurId: f.meter.id}, orderBy: {id: 'asc'}})
  const versions = await prisma.meterAllocationVersion.findMany({where: {allocation: {compteurId: f.meter.id}}, orderBy: {id: 'asc'}})
  const ingestions = await prisma.meterIngestion.findMany({where: {scope: f.campaign.id}, orderBy: {id: 'asc'}})
  t.false((await recheckCampaignResponsePublication({responseId: before.id}, {now})).changed)
  t.deepEqual(await prisma.meterPublication.findMany({where: {compteurId: f.meter.id}, orderBy: {id: 'asc'}}), publications)
  t.deepEqual(await prisma.collectionResponse.findUnique({where: {id: before.id}}), after)
  t.deepEqual(await prisma.meterAllocationVersion.findMany({where: {allocation: {compteurId: f.meter.id}}, orderBy: {id: 'asc'}}), versions)
  t.deepEqual(await prisma.meterIngestion.findMany({where: {scope: f.campaign.id}, orderBy: {id: 'asc'}}), ingestions)
})

integration('complete matching supplier publication is reused in campaign totals with no supplier writes or duplicate volume', async t => {
  const f = await fixture()
  const stream = await historicalAllocations(f, {supplier: true})
  const before = {stream: await prisma.meterStream.findUnique({where: {id: stream.id}}),
    readings: await prisma.meterReading.findMany({where: {compteurId: f.meter.id}, orderBy: {id: 'asc'}}),
    publications: await prisma.meterPublication.findMany({where: {compteurId: f.meter.id}, orderBy: {id: 'asc'}})}
  const volumes = await activeVolumes(f)
  t.is(volumes.length, 2)
  const submitted = await submit(f)
  t.is((await diagnostics(submitted)).publicationStatus, 'PUBLISHED')
  t.is(submitted.response.volumes.total, 160)
  t.deepEqual(await activeVolumes(f), volumes)
  t.deepEqual(await prisma.meterStream.findUnique({where: {id: stream.id}}), before.stream)
  t.deepEqual(await prisma.meterReading.findMany({where: {compteurId: f.meter.id}, orderBy: {id: 'asc'}}), before.readings)
  t.deepEqual(await prisma.meterPublication.findMany({where: {compteurId: f.meter.id}, orderBy: {id: 'asc'}}), before.publications)
  t.is(await prisma.meterStream.count({where: {compteurId: f.meter.id, provider: 'manual-collection'}}), 0)
  t.is((await getCollectionResults(f.collector, f.campaign.id, {page: 1, pageSize: 20})).totals.publishedVolumes.total, 160)
})

integration('missing supplier coverage and inconsistent readings remain explicit technical issues without changing provider data', async t => {
  const missing = await fixture()
  const stream = await historicalAllocations(missing, {supplier: true, missingEnd: true})
  const before = await prisma.meterStream.findUnique({where: {id: stream.id}})
  const result = await submit(missing)
  t.is((await diagnostics(result)).publicationStatus, 'PENDING_REVIEW')
  t.is((await diagnostics(result)).publicationIssues[0].code, 'PROVIDER_READING_COVERAGE')
  t.regex((await diagnostics(result)).publicationIssues[0].message, /données manquantes/)
  t.deepEqual(await prisma.meterStream.findUnique({where: {id: stream.id}}), before)
  t.is(await prisma.meterReading.count({where: {compteurId: missing.meter.id}}), 2)
  const conflicting = await fixture()
  await historicalAllocations(conflicting, {supplier: true})
  const data = structuredClone(conflicting.data)
  data.meters[0].season.indexEnd = '270'
  const conflict = await submit(conflicting, 0, {data})
  t.is((await diagnostics(conflict)).publicationIssues[0].code, 'READING_CONFLICT')
  t.deepEqual(conflict.response.volumes, {offSeason: 100, season: 70, total: 170, partial: false})
  t.is((await activeVolumes(conflicting)).reduce((sum, row) => sum + Number(row.value), 0), 160)
})

integration('dated additive allocations allow two meters while a historical gap never falls back to a current 100 percent share', async t => {
  const f = await fixture()
  const second = await prisma.compteur.create({data: {serialNumber: `ADDITIVE-${randomUUID()}`}})
  await prisma.meterAllocation.create({data: {sourceId: randomUUID(), provider: 'synthetic-reference', scope: f.campaign.id,
    compteurId: second.id, exploitationId: f.exploitations[0].id, versions: {create: {version: 1, enabled: false}}}})
  await historicalAllocations(f, {additive: true})
  await historicalAllocations(f, {compteurId: second.id, additive: true})
  const data = structuredClone(f.data)
  data.meters.push({...structuredClone(data.meters[0]), compteurId: second.id, serialNumber: second.serialNumber})
  const result = await submit(f, 0, {data})
  t.is((await diagnostics(result)).publicationStatus, 'PUBLISHED')
  t.is(result.response.volumes.total, 320)
  t.is((await activeVolumes(f)).length, 4)
  const gap = await fixture()
  await historicalAllocations(gap, {delayed: true})
  const blocked = await submit(gap)
  t.is((await diagnostics(blocked)).publicationStatus, 'PENDING_REVIEW')
  t.is((await diagnostics(blocked)).publicationIssues[0].code, 'HISTORICAL_ALLOCATION_UNRESOLVED')
  t.is((await activeVolumes(gap)).length, 0)
  t.is(await prisma.meterStream.count({where: {compteurId: gap.meter.id}}), 0)
})

integration('a failed physical publication postcondition rolls back all new physical artifacts before recording the issue', async t => {
  const f = await fixture({shared: true})
  await submit(f)
  await submit(f, 1)
  await historicalAllocations(f)
  const versions = await prisma.meterAllocationVersion.findMany({where: {allocation: {compteurId: f.meter.id}}, orderBy: {id: 'asc'}})
  const result = await prisma.$transaction(async tx => {
    // Inject an incomplete publication result after the engine has written its
    // intervals, exercising recovery without weakening database protections.
    const client = new Proxy(tx, {get(target, key) {
      if (key === 'meterPublication') return {...target.meterPublication, findMany: args => args.where.streamId
        ? Promise.resolve([]) : target.meterPublication.findMany(args)}
      return target[key]
    }})
    return recheckCampaignResponsePublicationInTransaction(client, f.responses[0].id, {now})
  })
  t.is(result.publicationStatus, 'PENDING_REVIEW')
  t.is(result.publicationIssues[0].code, 'PUBLICATION_CONFLICT')
  t.is(await prisma.meterStream.count({where: {compteurId: f.meter.id}}), 0)
  t.is(await prisma.meterReading.count({where: {compteurId: f.meter.id}}), 0)
  t.is(await prisma.meterPublication.count({where: {compteurId: f.meter.id}}), 0)
  t.is(await prisma.meterIngestion.count({where: {scope: f.campaign.id}}), 0)
  t.deepEqual(await prisma.meterAllocationVersion.findMany({where: {allocation: {compteurId: f.meter.id}}, orderBy: {id: 'asc'}}), versions)
})

integration('superseded supplier publications never change volumes calculated from the submitted campaign indices', async t => {
  const f = await fixture()
  const stream = await historicalAllocations(f, {supplier: true})
  const submitted = await submit(f)
  t.is(submitted.response.volumes.total, 160)
  await prisma.$transaction(async tx => {
    const ingestion = await tx.meterIngestion.create({data: {provider: stream.provider, scope: stream.scope, batchId: randomUUID(), mode: 'LIVE',
      fetchedAt: new Date('2026-11-03T12:00:00Z'), windowStart: CAMPAIGN_VOLUME_BOUNDARIES[0], windowEnd: CAMPAIGN_VOLUME_BOUNDARIES[2], payloadHash: 'corrected', rawPayload: {}}})
    for (const index of [0, 1, 2]) await persistMeterReadingInTransaction(tx, {stream, raw: {},
      normalized: {observedAt: CAMPAIGN_VOLUME_BOUNDARIES[index], index: ['100', '200', '260'][index], admissible: true, quality: 'CORRECTED'}},
    ingestion, {unchanged: 0, accepted: 0, blocked: 0})
    await reprocessMeterStreamInTransaction(tx, stream)
  })
  const stale = await getAuthorizedCampaignResponseContext(f.preleveur, f.campaign.id, f.responses[0].id)
  t.is(stale.response.volumes.total, 160)
  t.false(stale.response.volumes.partial)
  const before = await prisma.meterPublication.findMany({where: {compteurId: f.meter.id}, orderBy: {id: 'asc'}})
  await recheckCampaignResponsePublication({responseId: f.responses[0].id}, {now})
  const refreshed = await getAuthorizedCampaignResponseContext(f.preleveur, f.campaign.id, f.responses[0].id)
  t.is(refreshed.response.volumes.total, 160)
  t.deepEqual(await prisma.meterPublication.findMany({where: {compteurId: f.meter.id}, orderBy: {id: 'asc'}}), before)
  t.is((await activeVolumes(f)).length, 2)
})

integration('an additive checkbox and validated flag cannot substitute for a coherent dated snapshot on the other meter', async t => {
  const f = await fixture()
  const other = await prisma.compteur.create({data: {serialNumber: `OTHER-ADDITIVE-${randomUUID()}`}})
  const allocation = await prisma.meterAllocation.create({data: {sourceId: randomUUID(), provider: 'synthetic-reference', scope: f.campaign.id,
    compteurId: other.id, exploitationId: f.exploitations[0].id}})
  await historicalAllocations(f, {additive: true})
  await historicalAllocations(f, {compteurId: other.id, supplier: true, additive: true})
  await prisma.meterAllocationVersion.updateMany({where: {allocationId: allocation.id}, data: {enabled: false}})
  await prisma.meterAllocationVersion.create({data: {allocationId: allocation.id, version: 10, enabled: true, additive: true, percentage: '100',
    startDate: CAMPAIGN_VOLUME_BOUNDARIES[0], endDate: CAMPAIGN_VOLUME_BOUNDARIES[2],
    metadata: {allocationSnapshotValidated: true, allocationSnapshot: [{key: allocation.sourceId, percentage: '90', inScope: true}]}}})
  const data = structuredClone(f.data)
  data.meters.push({...structuredClone(data.meters[0]), compteurId: other.id, serialNumber: other.serialNumber})
  const result = await submit(f, 0, {data})
  t.is((await diagnostics(result)).publicationStatus, 'PENDING_REVIEW')
  t.true((await diagnostics(result)).publicationIssues.some(row => row.compteurId === f.meter.id && row.code === 'EXISTING_VOLUME'))
  t.is(await prisma.meterStream.count({where: {compteurId: f.meter.id}}), 0)
  t.is((await activeVolumes(f)).length, 2)
})

integration('an automatic physical correction A to B to A publishes the restored indices, not the intermediate revision', async t => {
  const f = await fixture()
  await historicalAllocations(f)
  const original = await submit(f)
  t.is(original.response.volumes.total, 160)
  const corrected = structuredClone(original.response.submittedData)
  corrected.meters[0].season.indexEnd = '280'
  const intermediate = await submit(f, 0, {data: corrected, revision: 1, submittedAt: new Date('2026-11-03T12:00:00Z')})
  t.is((await diagnostics(intermediate)).publicationStatus, 'PUBLISHED')
  t.is(intermediate.response.volumes.total, 180)
  const restored = await submit(f, 0, {data: original.response.submittedData, revision: 2, submittedAt: new Date('2026-11-04T12:00:00Z')})
  t.is((await diagnostics(restored)).publicationStatus, 'PUBLISHED')
  t.is(restored.response.volumes.total, 160)
  const last = await prisma.meterReading.findUnique({where: {compteurId_observedAt: {compteurId: f.meter.id, observedAt: CAMPAIGN_VOLUME_BOUNDARIES[2]}}, include: {currentRevision: true}})
  t.is(last.currentRevision.index.toString(), '260')
  t.is((await activeVolumes(f)).reduce((sum, row) => sum + Number(row.value), 0), 160)
  t.is(await prisma.meterIngestion.count({where: {provider: 'manual-collection', scope: f.campaign.id}}), 3)
  t.false((await recheckCampaignResponsePublication({responseId: f.responses[0].id}, {now: new Date('2026-11-05T12:00:00Z')})).changed)
})

integration('historical pending responses immediately calculate submitted indices without a receipt, repair or draft mutation', async t => {
  const f = await fixture()
  const submittedData = {...structuredClone(f.data), meters: [{...structuredClone(f.data.meters[0]), meterChanged: true, meterChangeReason: 'Signalement historique'}]}
  const draftData = structuredClone(submittedData)
  draftData.meters[0].season.indexEnd = '999'
  await prisma.collectionResponse.update({where: {id: f.responses[0].id}, data: {
    submittedData, draftData, revision: 7, firstSubmittedAt: now, lastSubmittedAt: now,
    publicationStatus: 'PENDING_REVIEW', publicationIssues: [{code: 'ATTACHMENT_REVIEW', compteurId: f.meter.id}]
  }})
  const before = await prisma.collectionResponse.findUnique({where: {id: f.responses[0].id}})
  const response = await getAuthorizedCampaignResponseContext(f.preleveur, f.campaign.id, before.id)
  t.is(response.response.status, 'SUBMITTED')
  t.true(response.response.hasDraft)
  t.deepEqual(response.data, draftData)
  t.deepEqual(response.response.volumes, {offSeason: 100, season: 60, total: 160, partial: false})
  for (const field of ['publicationStatus', 'publicationIssues', 'publicationStatusLabel']) t.false(Object.hasOwn(response.response, field))
  const projected = await getCampaignResponseVolumes([{id: before.id, firstSubmittedAt: now}])
  t.deepEqual(projected.get(before.id), response.response.volumes)
  const results = await getCollectionResults(f.collector, f.campaign.id, {view: 'summary', page: 1, pageSize: 20})
  t.deepEqual(results.items[0].volumes, response.response.volumes)
  t.deepEqual(results.totals.publishedVolumes, {offSeason: 100, season: 60, total: 160, partial: false})
  for (const field of ['submittedData', 'draftData', 'publicationStatus', 'publicationIssues', 'publicationStatusLabel']) t.false(Object.hasOwn(results.items[0], field))
  t.deepEqual(await prisma.collectionResponse.findUnique({where: {id: before.id}}), before)
  t.is((await activeVolumes(f)).length, 0)
  const outsider = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
  t.is((await t.throwsAsync(getAuthorizedCampaignResponseContext(outsider, f.campaign.id, before.id))).status, 404)
})
