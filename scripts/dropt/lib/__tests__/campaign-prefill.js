import test from 'ava'
import {randomUUID} from 'node:crypto'
import {buildCampaignPrefillPlan, prefillCampaign, verifyCampaignPrefill} from '../campaign-prefill.js'
import {CAMPAIGN_PREFILL_HEADERS, parseCampaignPrefillRows} from '../campaign-prefill-source.js'

const irrigationId = randomUUID()
const usages = [{id: irrigationId, code: '2'}]

function record(overrides = {}) {
  return {eligible: true, sourceRows: [2], issues: [], identity: {pointOugc: 'SYNTHETIC-POINT', siret: '00000000000001', countingOugc: 'COUNT-01', serialNumber: 'SYNTHETIC-METER'},
    needs: {season: {volume: '1000', usageCode: '2'}, offSeason: {volume: '0'}},
    reading: {date: '2025-10-31', index: '100'}, indexEvidenceValues: ['100'], metadata: {noAuthorizedOffSeasonUsage: false}, ...overrides}
}

function response(overrides = {}) {
  const userId = randomUUID()
  return {id: randomUUID(), preleveurUserId: userId, exploitationId: randomUUID(), revision: 0, draftData: null, submittedData: null,
    prefillData: null, prefillMetadata: null, publicationStatus: 'NOT_SUBMITTED',
    exploitation: {declarantUserId: userId, status: 'EN_ACTIVITE', countingCode: 'COUNT-01', pointPrelevementNameAliases: [],
      pointPrelevement: {name: 'SYNTHETIC-POINT'}, declarant: {siret: '00000000000001', user: {}},
      meterAllocations: [{compteur: {id: randomUUID(), serialNumber: 'SYNTHETIC-METER'}}]}, ...overrides}
}
const source = records => ({records, issues: [], source: {sha256: 'a'.repeat(64)}})

test('exact point, owner and counting identity produces a proposal without mutating answers', t => {
  const current = response()
  const before = structuredClone(current)
  const plan = buildCampaignPrefillPlan(source([record()]), [current], usages)
  t.is(plan.counts.PREFILL, 1)
  t.is(plan.entries[0].prefillData.needs.season.usageId, irrigationId)
  t.is(plan.entries[0].prefillData.needs.offSeason.volume, '0')
  t.is(plan.entries[0].prefillData.meters[0].offSeason.indexStart, '100')
  t.deepEqual(current, before)
})

test('point aliases are exact, with no fuzzy or counting-only match', t => {
  const current = response()
  current.exploitation.pointPrelevementNameAliases = ['LEGACY-POINT']
  const original = record()
  t.is(buildCampaignPrefillPlan(source([record({identity: {...original.identity, pointOugc: 'LEGACY-POINT'}})]), [current], usages).counts.PREFILL, 1)
  for (const identity of [{...original.identity, siret: '00000000000002'}, {...original.identity, countingOugc: 'OTHER'}, {...original.identity, pointOugc: 'POINT'}]) {
    const plan = buildCampaignPrefillPlan(source([record({identity})]), [current], usages)
    t.is(plan.counts.PREFILL, 0)
    t.is(plan.issues[0].code, 'unmatched_response')
  }
})

test('ambiguous response and unknown serial never select a first match', t => {
  const current = response()
  const plan = buildCampaignPrefillPlan(source([record()]), [current, structuredClone(current)], usages)
  t.is(plan.issues[0].code, 'ambiguous_response')
  const original = record()
  const unknown = buildCampaignPrefillPlan(source([record({identity: {...original.identity, serialNumber: 'OTHER'}})]), [current], usages)
  t.deepEqual(unknown.entries[0].prefillData.meters, [])
  t.true(unknown.issues.some(issue => issue.code === 'unresolved_meter'))
})

test('missing serial resolves only a single current meter', t => {
  const current = response()
  const original = record()
  const input = source([record({identity: {...original.identity, serialNumber: null}})])
  t.is(buildCampaignPrefillPlan(input, [current], usages).entries[0].prefillData.meters.length, 1)
  current.exploitation.meterAllocations.push({compteur: {id: randomUUID(), serialNumber: 'OTHER'}})
  t.is(buildCampaignPrefillPlan(input, [current], usages).entries[0].prefillData.meters.length, 0)
})

test('mapped meter conflicts include excluded source records and zero evidence', t => {
  const current = response()
  const excluded = record({eligible: false, reading: null, sourceRows: [3], indexEvidenceValues: ['0', '101']})
  const plan = buildCampaignPrefillPlan(source([record(), excluded]), [current], usages)
  t.deepEqual(plan.entries[0].prefillData.meters, [])
  t.true(plan.issues.some(issue => issue.code === 'mapped_meter_index_conflict'))
})

test('excluded duplicate rows retain index evidence for each distinct meter, including a serial-less allocation match', t => {
  const meterA = {id: randomUUID(), serialNumber: 'SYNTHETIC-A'}
  const meterB = {id: randomUUID(), serialNumber: 'SYNTHETIC-B'}
  const first = response()
  first.exploitation.pointPrelevement.name = 'SYNTHETIC-POINT-A'
  first.exploitation.countingCode = 'COUNT-A'
  first.exploitation.meterAllocations = [{compteur: meterA}, {compteur: meterB}]
  const second = response()
  second.exploitation.pointPrelevement.name = 'SYNTHETIC-POINT-B'
  second.exploitation.countingCode = 'COUNT-B'
  second.exploitation.meterAllocations = [{compteur: meterB}]
  const row = (point, counting, serial, index) => {
    const cells = Array(25).fill(null)
    Object.assign(cells, {1: point, 2: '00000000000001', 3: 1000, 17: counting, 19: serial, 21: index})
    return cells
  }
  const input = {...parseCampaignPrefillRows([
    CAMPAIGN_PREFILL_HEADERS,
    row('SYNTHETIC-POINT-A', 'COUNT-A', meterA.serialNumber, 100),
    row('SYNTHETIC-POINT-A', 'COUNT-A', meterB.serialNumber, 200),
    row('SYNTHETIC-POINT-B', 'COUNT-B', null, 999)
  ]), source: {sha256: 'a'.repeat(64)}}
  t.false(input.records[0].eligible)
  const plan = buildCampaignPrefillPlan(input, [first, second], usages)
  const proposed = plan.entries.find(entry => entry.responseId === second.id)
  t.deepEqual(proposed.prefillData.meters, [])
  t.true(plan.issues.some(issue => issue.code === 'mapped_meter_index_conflict' && issue.sourceRows.includes(4)))
})

test('existing observed indexes are preserved, with disagreements reported', t => {
  const current = response()
  const meterId = current.exploitation.meterAllocations[0].compteur.id
  for (const value of ['100', '0', '101']) {
    const plan = buildCampaignPrefillPlan(source([record()]), [current], usages, [{value,
      chunk: {compteurId: meterId, exploitationId: current.exploitationId, preleveurUserId: current.preleveurUserId}}])
    t.deepEqual(plan.entries[0].prefillData.meters, [])
    t.true(plan.issues.some(issue => issue.code === (value === '100' ? 'existing_index_preserved' : 'existing_index_conflict')))
  }
})

test('a consistent observation of another beneficiary does not hide this response source proposal', t => {
  const current = response()
  const meterId = current.exploitation.meterAllocations[0].compteur.id
  const other = {value: '100', chunk: {compteurId: meterId, exploitationId: randomUUID(), preleveurUserId: randomUUID()}}
  const plan = buildCampaignPrefillPlan(source([record()]), [current], usages, [other])
  t.is(plan.entries[0].prefillData.meters[0].offSeason.indexStart, '100')
  t.false(plan.issues.some(issue => issue.code === 'existing_index_preserved'))
  const own = {value: '100', chunk: {compteurId: meterId, exploitationId: current.exploitationId, preleveurUserId: current.preleveurUserId}}
  const ownPlan = buildCampaignPrefillPlan(source([record()]), [current], usages, [own, other])
  t.deepEqual(ownPlan.entries[0].prefillData.meters, [])
  t.true(ownPlan.issues.some(issue => issue.code === 'existing_index_preserved'))
})

test('a contradictory observation of any beneficiary still blocks a physical index proposal', t => {
  const current = response()
  const meterId = current.exploitation.meterAllocations[0].compteur.id
  const other = {value: '101', chunk: {compteurId: meterId, exploitationId: randomUUID(), preleveurUserId: randomUUID()}}
  const plan = buildCampaignPrefillPlan(source([record()]), [current], usages, [other])
  t.deepEqual(plan.entries[0].prefillData.meters, [])
  t.true(plan.issues.some(issue => issue.code === 'existing_index_conflict'))
})

test('existing drafts, submissions and different prefills are preserved; same import is idempotent', t => {
  for (const changes of [{draftData: {}}, {submittedData: {}}, {revision: 1}, {firstSubmittedAt: new Date()}, {declarationId: randomUUID()}]) {
    t.is(buildCampaignPrefillPlan(source([record()]), [response(changes)], usages).counts.PRESERVED_RESPONSE, 1)
  }
  const current = response()
  const first = buildCampaignPrefillPlan(source([record()]), [current], usages).entries[0]
  current.prefillData = first.prefillData
  current.prefillMetadata = first.prefillMetadata
  t.is(buildCampaignPrefillPlan(source([record()]), [current], usages).counts.ALREADY_APPLIED, 1)
  current.prefillData.needs.season.volume = '2000'
  t.is(buildCampaignPrefillPlan(source([record()]), [current], usages).counts.PRESERVED_PREFILL, 1)
})

test('different source proposals for one response are excluded, never summed twice', t => {
  const plan = buildCampaignPrefillPlan(source([record(), record({sourceRows: [3], needs: {season: {volume: '2000'}, offSeason: {}}})]), [response()], usages)
  t.is(plan.counts.EXCLUDED_CONFLICT, 1)
  t.false(Object.hasOwn(plan.entries[0], 'prefillData'))
})

test('prefill and verification reject unsupported targets before accessing a database', async t => {
  for (const target of [undefined, 'demo', 'production']) {
    await t.throwsAsync(prefillCampaign({}, source([]), {target}), {message: /Cible de préremplissage/})
    await t.throwsAsync(verifyCampaignPrefill({}, source([]), {target}), {message: /Cible de préremplissage/})
  }
})

test('prod prefill and verification require reports from the same target', async t => {
  const options = {target: 'prod', campaignId: randomUUID(), actorUserId: randomUUID()}
  const report = {version: 1, operation: 'prefill-campaign', complete: true, sourceSha256: 'a'.repeat(64),
    campaignId: options.campaignId, actorUserId: options.actorUserId, planHash: 'b'.repeat(64), entries: []}
  for (const target of ['local', 'testing']) {
    await t.throwsAsync(prefillCampaign({}, source([]), {...options, apply: true, expectedReport: {...report, target, applied: false}}), {message: /Rapport de préremplissage incompatible/})
    await t.throwsAsync(verifyCampaignPrefill({}, source([]), {...options, expectedReport: {...report, target, applied: true}}), {message: /Rapport de préremplissage incompatible/})
  }
})
