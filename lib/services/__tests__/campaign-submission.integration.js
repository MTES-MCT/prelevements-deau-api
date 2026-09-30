/* eslint-disable no-await-in-loop -- Fixtures and reconstruction checks deliberately run serially against the disposable database. */
import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import {PassThrough} from 'node:stream'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {submitCampaignResponse} from '../campaign-submission.js'
import {getCampaignMeterReview, approveCampaignMeter} from '../campaign-meter-publication.js'
import {saveCollectionResponseDraft, getAuthorizedCampaignResponseContext, getCollectionResults} from '../collection-campaigns.js'
import {reconstructVolumesFromIndexForPoint} from '../volumes-from-index.js'
import {meterHash, meterBusinessDateBoundary} from '../meter-core.js'
import {getDeclarationDetailHandler} from '../../handlers/declarations.js'
import {exportCollectionResultsHandler} from '../../handlers/collection-campaigns.js'

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

function submit(f, index = 0, {data = f.data, revision = 0, submittedAt = now} = {}) {
  return submitCampaignResponse({user: f.preleveur, campaignId: f.campaign.id, responseId: f.responses[index].id, body: {revision, data}}, {now: submittedAt})
}

async function activeVolumes(f) {
  return prisma.chunkValue.findMany({where: {metricTypeCode: 'volume', chunk: {exploitationId: {in: f.exploitations.map(row => row.id)}, instructionStatus: {not: 'REJECTED'}, source: {status: 'COMPLETED'}}}, include: {chunk: true}})
}

integration('before October 31 campaign creates a stable receipt, computes both seasons and allows replay and correction', async t => {
  const f = await fixture({existingMeter: false})
  const submittedAt = new Date('2026-09-24T12:00:00Z')
  const result = await submit(f, 0, {submittedAt})
  t.is(result.response.publicationStatus, 'PUBLISHED')
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

integration('anonymous meters remain distinct and replay, correct and receive a number without changing their identity', async t => {
  const f = await fixture({existingMeter: false})
  const data = structuredClone(f.data)
  delete data.meters[0].serialNumber
  const first = await submit(f, 0, {data})
  const meterId = first.response.submittedData.meters[0].compteurId
  t.truthy(meterId)
  t.is(first.response.submittedData.meters[0].serialNumber, null)
  t.is(first.response.publicationStatus, 'PUBLISHED')
  t.is((await activeVolumes(f)).reduce((sum, row) => sum + Number(row.value), 0), 160)
  const replay = await submit(f, 0, {data: {...data, meters: [{...data.meters[0], serialNumber: ''}]}})
  t.is(replay.response.revision, 1)
  t.is(replay.response.submittedData.meters[0].compteurId, meterId)
  t.is((await submit(f, 0, {data: first.response.submittedData})).response.revision, 1)
  const other = await fixture({existingMeter: false})
  const otherData = structuredClone(other.data)
  otherData.meters[0].serialNumber = null
  const otherResult = await submit(other, 0, {data: otherData})
  t.not(otherResult.response.submittedData.meters[0].compteurId, meterId)
  const correction = structuredClone(first.response.submittedData)
  correction.meters[0].season.indexEnd = '280'
  const corrected = await submit(f, 0, {data: correction, revision: 1})
  t.is(corrected.response.declarationId, first.response.declarationId)
  t.is(corrected.response.submittedData.meters[0].compteurId, meterId)
  t.is((await activeVolumes(f)).reduce((sum, row) => sum + Number(row.value), 0), 180)
  const numbered = structuredClone(corrected.response.submittedData)
  numbered.meters[0].serialNumber = `COMPLETED-${randomUUID()}`
  const completed = await submit(f, 0, {data: numbered, revision: 2})
  t.is(completed.response.submittedData.meters[0].compteurId, meterId)
  t.is((await prisma.compteur.findUnique({where: {id: meterId}})).serialNumber, numbered.meters[0].serialNumber)
  t.is(completed.response.publicationStatus, 'PUBLISHED')
  t.is((await submit(f, 0, {data: correction, revision: 2})).response.revision, 3)
  t.is(await prisma.meterAllocation.count({where: {exploitationId: f.exploitations[0].id}}), 1)
})

integration('an allocated meter without a number can be submitted and cannot be renumbered onto another meter', async t => {
  const f = await fixture()
  await prisma.compteur.update({where: {id: f.meter.id}, data: {serialNumber: null}})
  const data = structuredClone(f.data)
  data.meters[0].serialNumber = null
  const result = await submit(f, 0, {data})
  t.is(result.response.submittedData.meters[0].compteurId, f.meter.id)
  t.is(result.response.publicationStatus, 'PUBLISHED')
  const other = await fixture()
  const collision = structuredClone(data)
  collision.meters[0].serialNumber = other.meter.serialNumber.toLowerCase()
  t.is((await t.throwsAsync(submit(f, 0, {data: collision, revision: 1}))).status, 409)
  t.is((await prisma.compteur.findUnique({where: {id: f.meter.id}})).serialNumber, null)
  t.is((await prisma.collectionResponse.findUnique({where: {id: f.responses[0].id}})).revision, 1)
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
  t.is(result.response.publicationStatus, 'PUBLISHED')
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
  t.is(result.response.publicationStatus, 'PUBLISHED')
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
  t.deepEqual(Object.keys(error.data.fields), ['meters.0.season.indexEnd'])
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
  t.is(result.response.publicationStatus, 'PUBLISHED')
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
  t.deepEqual(Object.keys(error.data.fields), ['meters.0.offSeason.indexEnd'])
  t.deepEqual(error.data.validationErrors, error.data.fields)
  t.is((await prisma.chunkValue.findUnique({where: {id: source.chunks[0].chunkValues[0].id}})).value.toString(), '225')
  const response = await prisma.collectionResponse.findUnique({where: {id: f.responses[0].id}})
  t.is(response.revision, 0)
  t.is(response.declarationId, null)
  await prisma.chunk.update({where: {id: source.chunks[0].id}, data: {instructionStatus: 'REJECTED'}})
  t.is((await submit(f)).response.publicationStatus, 'PUBLISHED')
})

integration('before October 31 shared receipts wait for review; physical publication conserves 60/40 then 50/50', async t => {
  const f = await fixture({shared: true})
  const submittedAt = new Date('2026-09-24T12:00:00Z')
  const first = await submit(f, 0, {submittedAt})
  await submit(f, 1, {submittedAt})
  t.is(first.response.publicationStatus, 'PENDING_REVIEW')
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
  t.is(needsOnly.response.publicationStatus, 'PUBLISHED')
  t.is((await activeVolumes(f)).reduce((sum, row) => sum + Number(row.value), 0), 160)
  const changed = structuredClone(first.response.submittedData)
  changed.meters[0].season.indexEnd = '280'
  const corrected = await submit(f, 0, {data: changed, revision: 2, submittedAt})
  t.is(corrected.response.publicationStatus, 'PENDING_REVIEW')
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
    minDate: new Date('2025-11-01Z'), maxDate: new Date('2026-10-31Z'), chunkValues: {create: {
      metricTypeCode: 'volume prélevé', value: '99', unit: 'm³', frequency: 'irregular',
      periodStart: new Date('2025-11-01Z'), periodEnd: new Date('2026-10-31Z'), valueKind: 'DECLARED'
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
