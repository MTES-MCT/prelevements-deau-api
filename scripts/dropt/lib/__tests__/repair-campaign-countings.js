import test from 'ava'
import {randomUUID} from 'node:crypto'
import {buildCampaignCountingRepairPlan, repairCampaignCountings} from '../repair-campaign-countings.js'
import {CAMPAIGN_PREFILL_HEADERS, parseCampaignPrefillRows} from '../campaign-prefill-source.js'

function fixture() {
  const userId = randomUUID()
  const usageId = randomUUID()
  const collectorId = randomUUID()
  const pointId = randomUUID()
  const exploitationId = randomUUID()
  const campaign = {id: randomUUID(), collecteurUserId: collectorId}
  const row = (code, volume) => {
    const cells = Array(25).fill(null)
    Object.assign(cells, {1: 'SYNTHETIC-POINT', 2: '00000000000001', 3: volume, 4: 10, 5: 2,
      7: 3, 8: 20, 11: volume, 13: 20, 16: 0, 17: code, 18: `AE-${code}`, 21: 123, 22: 'Irrigation', 23: 'Irrigation'})
    return cells
  }
  const source = {...parseCampaignPrefillRows([CAMPAIGN_PREFILL_HEADERS, row('COUNT-2', 200), row('COUNT-1', 100)]),
    source: {sha256: 'a'.repeat(64)}}
  const exploitation = {id: exploitationId, declarantUserId: userId, pointPrelevementId: pointId,
    status: 'EN_ACTIVITE', startDate: null, endDate: null, countingCode: null, usageId,
    excludeFromQuickDeclaration: true, pointPrelevementNameAliases: [], comment: null, abandonReason: null,
    sourceId: 'dropt-epidropt:exploitation:synthetic', mostRecentAvailableDate: null,
    pointPrelevement: {id: pointId, name: 'SYNTHETIC-POINT'}, declarant: {siret: '00000000000001', user: {}},
    meterAllocations: [], collecteurs: [{id: randomUUID(), collecteurUserId: collectorId}], secondaryUsageLinks: [{usageId: randomUUID()}],
    _count: {meterAllocations: 0, connectors: 0, documents: 0, documentLinks: 0, rules: 0, chunks: 0, collectionResponses: 1}}
  const response = {id: randomUUID(), campaignId: campaign.id, exploitationId, preleveurUserId: userId,
    revision: 0, draftData: null, submittedData: null, prefillData: null, prefillMetadata: null,
    publicationStatus: 'NOT_SUBMITTED', publicationIssues: [], exploitation}
  const state = {campaign, responses: [response], exploitations: [exploitation], usages: [{id: usageId, code: '2'}],
    absentSerialNumbers: [], unassignedChunks: []}
  return {source, state, response, exploitation}
}

test('same index without serial does not merge distinct countings or copy repeated needs; old identity is preserved', t => {
  const {source, state, response} = fixture()
  const before = structuredClone({source, state})
  const plan = buildCampaignCountingRepairPlan(source, state)
  t.is(plan.counts.SPLIT, 1)
  const [first, second] = plan.entries[0].destinations
  t.is(first.countingCode, 'COUNT-1')
  t.is(first.responseId, response.id)
  t.is(first.exploitationId, response.exploitationId)
  t.not(first.responseId, second.responseId)
  t.deepEqual(first.prefillData.meters[0].offSeason, {})
  t.deepEqual(second.prefillData.meters[0].offSeason, {})
  t.true(first.prefillMetadata.readingNeedsReview)
  t.is(second.prefillMetadata.readingReviewReason, 'SHARED_INDEX_WITHOUT_PHYSICAL_IDENTITY')
  t.deepEqual(first.prefillData.needs, {season: {}, offSeason: {}})
  t.deepEqual(second.prefillData.needs, {season: {}, offSeason: {}})
  t.true(second.exploitationData.excludeFromQuickDeclaration)
  t.deepEqual(second.collectors, first.collectors)
  t.deepEqual(second.secondaryUsageIds, first.secondaryUsageIds)
  t.deepEqual({source, state}, before)
  t.deepEqual(buildCampaignCountingRepairPlan({...source, records: [...source.records].reverse()}, state), plan)
})

test('independent per-counting source indexes remain proposed with their own provenance', t => {
  const {source, state} = fixture()
  source.records[0].reading.index = '456'
  const plan = buildCampaignCountingRepairPlan(source, state)
  const [first, second] = plan.entries[0].destinations
  t.is(first.prefillData.meters[0].offSeason.indexStart, '123')
  t.is(second.prefillData.meters[0].offSeason.indexStart, '456')
  t.falsy(first.prefillMetadata.readingNeedsReview)
  t.deepEqual(first.prefillMetadata.rows, [3])
  t.deepEqual(second.prefillMetadata.rows, [2])
})

test('missing readings never invent zero indexes but can restore distinct counting identities', t => {
  const {source, state} = fixture()
  for (const record of source.records) { record.reading = null; record.needs = {season: {}, offSeason: {}} }
  const plan = buildCampaignCountingRepairPlan(source, state)
  t.is(plan.counts.SPLIT, 1)
  t.true(plan.entries[0].destinations.every(destination => destination.prefillData.meters.length === 0))
})

test('an old collapsed meter-only prefill is corrected without copying aggregated needs', t => {
  const {source, state, response} = fixture()
  response.prefillMetadata = {sourceSha256: source.source.sha256, rows: [2, 3], fields: ['meters']}
  response.prefillData = {meters: [{compteurId: null, serialNumber: null, offSeason: {indexStart: '123'}, season: {}}],
    needs: {season: {}, offSeason: {}}, comment: ''}
  t.is(buildCampaignCountingRepairPlan(source, state).counts.SPLIT, 1)
  response.prefillData.needs.season.volume = '300'
  t.is(buildCampaignCountingRepairPlan(source, state).entries[0].reason, 'PRESERVED_PREFILL')
})

test('response activity, dependencies and missing dependency evidence are excluded', t => {
  const mutations = [
    response => { response.draftData = {comment: 'Saisie conservée'} },
    response => { response.revision = 1 },
    response => { response.firstSubmittedAt = new Date() },
    response => { response.exploitation._count.meterAllocations = 1 },
    response => { response.exploitation._count.chunks = 1 },
    response => { response.exploitation._count.documents = 1 },
    response => { response.exploitation._count.collectionResponses = 2 },
    response => { delete response.exploitation._count.rules }
  ]
  for (const mutate of mutations) {
    const {source, state, response} = fixture()
    mutate(response)
    t.is(buildCampaignCountingRepairPlan(source, state).counts.SPLIT, 0)
  }
})

test('shared physical serials, absent AE identity and ownership ambiguity never create another meter', t => {
  const {source, state} = fixture()
  for (const record of source.records) record.identity.serialNumber = 'SAME-PHYSICAL-METER'
  state.absentSerialNumbers = ['same-physical-meter']
  t.is(buildCampaignCountingRepairPlan(source, state).entries[0].reason, 'SHARED_PHYSICAL_SERIAL')
  for (const record of source.records) record.identity.serialNumber = null
  source.records[0].identity.countingAeag = null
  t.is(buildCampaignCountingRepairPlan(source, state).entries[0].reason, 'AMBIGUOUS_SOURCE_COUNTINGS')
  source.records[0].identity.countingAeag = 'AE-COUNT-2'
  state.exploitations.push({...state.exploitations[0], id: randomUUID()})
  t.is(buildCampaignCountingRepairPlan(source, state).entries[0].reason, 'EXISTING_SIBLING_EXPLOITATIONS')
})

test('replay makes no changes even if a repaired answer has subsequently been started', t => {
  const {source, state, response} = fixture()
  const plan = buildCampaignCountingRepairPlan(source, state)
  state.responses = plan.entries[0].destinations.map(destination => ({...response, id: destination.responseId,
    exploitationId: destination.exploitationId, draftData: {comment: 'Saisi ensuite'},
    prefillData: destination.prefillData, prefillMetadata: destination.prefillMetadata,
    exploitation: {...response.exploitation, id: destination.exploitationId, countingCode: destination.countingCode}}))
  const replay = buildCampaignCountingRepairPlan(source, state)
  t.is(replay.counts.SPLIT, 0)
  t.is(replay.counts.ALREADY_APPLIED, 1)
})

test('explicit operation authorization and a durable backup callback are mandatory', async t => {
  const {source, state} = fixture()
  await t.throwsAsync(repairCampaignCountings({}, source, {target: 'prod'}), {message: /Autorisation explicite/})
  const options = {target: 'prod', campaignId: state.campaign.id, actorUserId: randomUUID(), allowCountingSplit: true, apply: true}
  const expectedReport = {version: 1, operation: 'repair-campaign-countings', complete: true, applied: false,
    sourceSha256: source.source.sha256, target: options.target, campaignId: options.campaignId,
    actorUserId: options.actorUserId, allowCountingSplit: true, planHash: 'a'.repeat(64), entries: []}
  await t.throwsAsync(repairCampaignCountings({}, source, {...options, expectedReport}), {message: /Sauvegarde privée/})
})
