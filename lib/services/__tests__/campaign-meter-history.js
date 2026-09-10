import test from 'ava'
import {loadCampaignMeterHistory} from '../campaign-meter-history.js'

const binding = (compteurId, overrides = {}) => ({id: `association-${compteurId}`, pointPrelevementId: 'point', compteurId, startDate: '2020-01-01', endDate: null, ...overrides})
const replacement = (overrides = {}) => ({targetId: 'target', type: 'REPLACEMENT', at: '2026-03-01', previousCompteurId: 'old', nextCompteurId: 'new', ...overrides})
const response = events => ({campaign: {targets: [{id: 'target', pointPrelevementId: 'point'}]}, latestSubmission: {snapshot: {meterEvents: events}}})
function client(responses) {
  const queries = []
  return {queries, campaignResponse: {async findMany(query) {
    queries.push(query)
    return responses
  }}}
}

test('les affectations suivantes tiennent compte du changement transmis sans modifier l’inventaire', async t => {
  const bindings = [binding('old'), binding('new')]
  const original = structuredClone(bindings)
  const database = client([response([replacement()])])
  const result = await loadCampaignMeterHistory(bindings, database)
  t.is(result[0].endDate.toISOString(), '2026-03-01T00:00:00.000Z')
  t.is(result[1].startDate.toISOString(), '2026-03-01T00:00:00.000Z')
  t.deepEqual(bindings, original)
  t.is(database.queries.length, 1)
  t.deepEqual(database.queries[0].where, {kind: 'INDEX', latestSubmissionId: {not: null}, campaign: {targets: {some: {pointPrelevementId: {in: ['point']}}}}})
  t.false(JSON.stringify(database.queries[0].select).includes('draft'))
})

test('la dernière transmission fait foi pendant une correction et après sa soumission', async t => {
  const row = {...response([replacement()]), status: 'DRAFT', draft: {meterEvents: [replacement({at: '2026-04-01'})]}}
  const database = client([row])
  const bindings = [binding('old'), binding('new')]
  const before = await loadCampaignMeterHistory(bindings, database)
  t.is(before[0].endDate.toISOString().slice(0, 10), '2026-03-01')
  row.latestSubmission.snapshot.meterEvents = row.draft.meterEvents
  const after = await loadCampaignMeterHistory(bindings, database)
  t.is(after[0].endDate.toISOString().slice(0, 10), '2026-04-01')
  row.latestSubmission.snapshot.meterEvents = []
  t.deepEqual(await loadCampaignMeterHistory(bindings, database), bindings)
})

test('les réaffectations et les autres points restent indépendants', async t => {
  const bindings = [binding('old'), binding('old', {id: 'return', startDate: '2026-08-01'}), binding('old', {id: 'outside', pointPrelevementId: 'outside'}), binding('new')]
  const result = await loadCampaignMeterHistory(bindings, client([response([replacement(), replacement({targetId: 'unknown', previousCompteurId: 'new'})])]))
  t.truthy(result[0].endDate)
  t.is(result[1].endDate, null)
  t.is(result[2].endDate, null)
  t.is(result[3].endDate, null)
})

test('une chaîne et un premier compteur référencé bornent les phases sans toucher aux remises à zéro', async t => {
  const bindings = [binding('old'), binding('new'), binding('last')]
  const events = [replacement(), replacement({at: '2026-05-01', previousCompteurId: 'new', nextCompteurId: 'last'}), replacement({at: '2026-07-01', type: 'RESET', previousCompteurId: 'last'})]
  const result = await loadCampaignMeterHistory(bindings, client([response(events)]))
  t.is(result[0].endDate.toISOString().slice(0, 10), '2026-03-01')
  t.is(result[1].endDate.toISOString().slice(0, 10), '2026-05-01')
  t.is(result[2].endDate, null)
  const first = await loadCampaignMeterHistory([binding('new')], client([response([replacement({previousCompteurId: null})])]))
  t.is(first[0].startDate.toISOString().slice(0, 10), '2026-03-01')
})

test('pas de requête sans affectation et aucune date canonique plus restrictive n’est étendue', async t => {
  t.deepEqual(await loadCampaignMeterHistory([], {}), [])
  const bindings = [binding('old', {endDate: '2026-02-01'}), binding('new', {startDate: '2026-04-01'})]
  t.deepEqual(await loadCampaignMeterHistory(bindings, client([response([replacement()])])), bindings)
})
