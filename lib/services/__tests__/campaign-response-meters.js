import test from 'ava'
import {prepareCampaignResponseMeters, publishCampaignResponseMeters} from '../campaign-response-meters.js'
import {loadCampaignTargetCoordinates} from '../campaigns.js'

function fixture() {
  const target = {id: 'target', pointPrelevementId: 'point', pointPrelevement: {id: 'point'}, meters: [{compteurId: 'old', compteur: {id: 'old'}}]}
  const event = {targetId: target.id, type: 'REPLACEMENT', at: '2026-02-01', previousCompteurId: 'old', nextMeter: {serialNumber: 'NEW'}, previousIndex: '200', nextIndex: '0', reason: 'Compteur cassé'}
  const draft = {comment: 'Conserver', readings: [], meterEvents: [event]}
  return {target, event, draft}
}

test('un brouillon produit un compteur virtuel stable sans altérer le brouillon ni l’inventaire', t => {
  const {target, draft} = fixture()
  const prepared = prepareCampaignResponseMeters([target], draft)
  const meter = prepared.targets[0].meters[1]
  t.regex(meter.compteurId, /^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-a[\da-f]{3}-[\da-f]{12}$/)
  t.true(meter.pending)
  t.deepEqual(meter.pendingEvent, {previousCompteurId: 'old', at: '2026-02-01'})
  t.is(prepareCampaignResponseMeters([target], structuredClone(draft)).targets[0].meters[1].compteurId, meter.compteurId)
  t.is(prepared.draft.meterEvents[0].nextCompteurId, meter.compteurId)
  t.false(Object.hasOwn(prepared.draft.meterEvents[0], 'nextMeter'))
  t.deepEqual(draft.meterEvents[0].nextMeter, {serialNumber: 'NEW'})
  t.is(target.meters.length, 1)
  t.is(prepared.draft.comment, 'Conserver')
  t.is(prepareCampaignResponseMeters([target], {...draft, meterEvents: []}).targets[0].meters.length, 1)
  const changed = prepareCampaignResponseMeters([target], {...draft, meterEvents: [{...draft.meterEvents[0], at: '2026-02-02'}]})
  t.not(changed.targets[0].meters[1].compteurId, meter.compteurId)
})

test('un compteur virtuel ne permet pas d’étendre le périmètre et n’est pas dupliqué en mémoire', t => {
  const {target, event, draft} = fixture()
  t.is(t.throws(() => prepareCampaignResponseMeters([], draft)).statusCode, 403)
  const prepared = prepareCampaignResponseMeters([target], {...draft, meterEvents: [event, event]})
  t.is(prepared.targets[0].meters.length, 2)
})

test('la publication conserve les affectations historiques distinctes d’un même compteur', async t => {
  const {target} = fixture()
  target.meters = [
    {associationId: 'first', compteurId: 'old', startDate: '2020-01-01', endDate: '2025-12-31'},
    {associationId: 'second', compteurId: 'old', startDate: '2026-02-01', endDate: null}
  ]
  const result = await publishCampaignResponseMeters([target], {readings: [], meterEvents: []}, {})
  t.deepEqual(result.targets[0].meters, target.meters)
})

test('les coordonnées sont chargées en une requête limitée aux points autorisés, sans mutation', async t => {
  const {target} = fixture()
  const targets = [target, {...target, id: 'second'}, {...target, id: 'without-coordinates', pointPrelevementId: 'missing'}]
  let calls = 0
  const client = {async $queryRaw(strings, ids) {
    calls++
    t.true(strings.join('').includes('WHERE id = ANY('))
    t.deepEqual(ids, ['point', 'missing'])
    return [{id: 'point', coordinates: {type: 'Point', coordinates: [2, 46]}}, {id: 'outside', coordinates: {type: 'Point', coordinates: [10, 10]}}]
  }}
  const result = await loadCampaignTargetCoordinates(targets, client)
  t.is(calls, 1)
  t.deepEqual(result[0].pointPrelevement.coordinates, {type: 'Point', coordinates: [2, 46]})
  t.is(result[2].pointPrelevement.coordinates, null)
  t.false(Object.hasOwn(target.pointPrelevement, 'coordinates'))
  t.deepEqual(await loadCampaignTargetCoordinates([], client), [])
  t.is(calls, 1)
})

function meterClient({candidates = [], bindings = []} = {}) {
  const writes = []
  const queries = []
  return {writes, queries,
    compteur: {
      async findMany(query) {
        queries.push(query)
        return candidates
      },
      async create({data}) {
        writes.push({type: 'compteur', data})
        return data
      }
    },
    compteurPointPrelevement: {
      async findMany() {
        return bindings
      },
      async create({data}) {
        writes.push({type: 'association', data})
        return {id: 'association', ...data}
      }
    },
    campaignTargetMeter: {async upsert({create}) {
      writes.push({type: 'campaign-meter', data: create})
      return {id: 'campaign-meter', ...create}
    }}
  }
}

test('la publication utilise le même UUID et une affectation datée sans toucher à l’ancien compteur', async t => {
  const {target, draft} = fixture()
  const prepared = prepareCampaignResponseMeters([target], draft)
  const pending = prepared.targets[0].meters[1]
  prepared.draft.readings = [{targetId: target.id, compteurId: pending.compteurId, readingDate: '2026-06-01', value: '300'}]
  const client = meterClient()
  const result = await publishCampaignResponseMeters(prepared.targets, prepared.draft, client)
  t.deepEqual(client.queries[0].where.points, {some: {pointPrelevementId: 'point'}})
  t.deepEqual(client.writes.map(write => write.type), ['compteur', 'association', 'campaign-meter'])
  t.is(client.writes[0].data.id, pending.compteurId)
  t.is(client.writes[1].data.startDate.toISOString(), '2026-02-01T00:00:00.000Z')
  t.is(result.draft.readings[0].compteurId, pending.compteurId)
  t.is(result.draft.meterEvents[0].nextCompteurId, pending.compteurId)
  t.false(result.targets[0].meters.some(meter => meter.pending))
  t.is(target.meters.length, 1)
})

test('un compteur identique déjà affecté à ce point est réutilisé et les relevés sont normalisés', async t => {
  const {target, draft} = fixture()
  const prepared = prepareCampaignResponseMeters([target], draft)
  const pending = prepared.targets[0].meters[1]
  prepared.draft.readings = [{targetId: target.id, compteurId: pending.compteurId, readingDate: '2026-06-01', value: '300'}]
  const client = meterClient({candidates: [{id: 'existing', serialNumber: 'NEW'}], bindings: [{id: 'association', compteurId: 'existing', pointPrelevementId: 'point', startDate: '2026-02-01', endDate: null}]})
  const result = await publishCampaignResponseMeters(prepared.targets, prepared.draft, client)
  t.deepEqual(client.writes.map(write => write.type), ['campaign-meter'])
  t.is(result.draft.readings[0].compteurId, 'existing')
  t.is(result.draft.meterEvents[0].nextCompteurId, 'existing')
  t.is(prepared.draft.readings[0].compteurId, pending.compteurId)
})

for (const options of [
  {candidates: [{id: 'existing', serialNumber: 'different'}]},
  {candidates: [{id: 'first', serialNumber: 'NEW'}, {id: 'second', serialNumber: 'NEW'}]},
  {candidates: [{id: 'existing', serialNumber: 'NEW'}], bindings: [{id: 'other', pointPrelevementId: 'outside', startDate: null, endDate: null}]},
  {candidates: [{id: 'existing', serialNumber: 'NEW'}], bindings: [{id: 'other', pointPrelevementId: 'point', startDate: '2026-01-01', endDate: null}]}
]) {
  test(`une identité ambiguë ou une affectation superposée est refusée : ${JSON.stringify(options)}`, async t => {
    const {target, draft} = fixture()
    const prepared = prepareCampaignResponseMeters([target], draft)
    const client = meterClient(options)
    const error = await t.throwsAsync(() => publishCampaignResponseMeters(prepared.targets, prepared.draft, client))
    t.is(error.statusCode, 409)
    t.false(error.message.includes('outside'))
    t.deepEqual(client.writes, [])
  })
}
