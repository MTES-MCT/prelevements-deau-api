import test from 'ava'
import {validateCampaignDraft} from '../campaigns.js'
import {prepareCampaignResponseMeters} from '../../services/campaign-response-meters.js'
import {calculateCampaignIndexTotals} from '../../services/campaign-index.js'
import {saveCampaignResponse, submitCampaignResponse} from '../../services/campaigns.js'

const id = suffix => `10000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
const campaign = {indexDates: ['2026-01-01', '2026-07-01'], periods: [
  {id: id(5), kind: 'INDEX', position: 0, startDate: '2026-01-01', endDate: '2026-07-01', startReadingDate: '2026-01-01', endReadingDate: '2026-07-01'}
]}

function fixture({registered = true, lastType = 'REPLACEMENT'} = {}) {
  const target = {id: id(1), pointPrelevementId: id(2), preleveurUserId: id(3), meters: registered ? [{compteurId: id(4), startDate: '2020-01-01'}] : []}
  const initialId = registered ? id(4) : null
  const first = {targetId: target.id, type: 'REPLACEMENT', at: '2026-02-01', previousCompteurId: initialId,
    nextMeter: {serialNumber: 'PREMIER NOUVEAU'}, previousIndex: '200', nextIndex: '0', reason: 'Premier remplacement'}
  const initial = prepareCampaignResponseMeters([target], {meterEvents: [first], readings: []}, {campaign})
  const firstPendingId = initial.draft.meterEvents[0].nextCompteurId
  const last = {...first, type: lastType, at: '2026-05-01', previousCompteurId: firstPendingId, reason: 'Dernier changement',
    ...(lastType === 'REPLACEMENT' ? {nextMeter: {serialNumber: 'SECOND NOUVEAU'}} : {nextCompteurId: firstPendingId})}
  if (lastType === 'RESET') {
    delete last.nextMeter
  }

  const both = prepareCampaignResponseMeters([target], {meterEvents: [first, last], readings: []}, {campaign})
  const lastId = both.draft.meterEvents[1].nextCompteurId
  const saved = {...both.draftForSave, readings: [
    {targetId: target.id, compteurId: initialId, readingDate: '2026-01-01', value: '100'},
    {targetId: target.id, compteurId: lastId, readingDate: '2026-07-01', value: '250.1234'}
  ]}
  return {target, first, last, initialId, firstPendingId, lastId, saved}
}

for (const registered of [true, false]) {
  for (const lastType of ['REPLACEMENT', 'RESET']) {
    test(`le dernier ${lastType} peut être supprimé dans une chaîne, ancien compteur référencé=${registered}`, t => {
      const {target, first, firstPendingId, lastId, saved} = fixture({registered, lastType})
      const before = structuredClone(saved)
      const originalMeters = structuredClone(target.meters)
      const incoming = {...saved, meterEvents: [first], readings: saved.readings.map(reading => ({...reading,
        compteurId: reading.compteurId === lastId ? firstPendingId : reading.compteurId}))}
      const prepared = prepareCampaignResponseMeters([target], incoming, {campaign, previousDraft: saved})
      const validated = validateCampaignDraft('INDEX', prepared.draftForSave, {campaign, targets: prepared.targets})
      const calculation = calculateCampaignIndexTotals({campaign, targets: prepared.targets, ...prepared.draft})
      t.true(calculation.canSubmit)
      t.is(calculation.totals[0].value, '350.1234')
      t.deepEqual(validated.readings.map(reading => reading.value), saved.readings.map(reading => reading.value))
      t.is(validated.readings[1].compteurId, firstPendingId)
      t.deepEqual(validated.meterEvents, [first])
      t.is(prepared.targets[0].meters.filter(meter => meter.pending).length, 1)
      t.deepEqual(target.meters, originalMeters)
      t.deepEqual(saved, before)
      const reloaded = prepareCampaignResponseMeters([target], validated, {campaign})
      t.deepEqual(reloaded.draftForSave, validated)
    })
  }
}

function legacyFixture() {
  const {target, first, last, initialId, saved, firstPendingId, lastId} = fixture()
  const invalid = {...last, type: 'RESET', at: '2026-03-01', previousCompteurId: initialId, nextCompteurId: initialId}
  delete invalid.nextMeter
  const legacy = {...saved, meterEvents: [first, invalid, last]}
  const incoming = {...legacy, meterEvents: [first, invalid], readings: saved.readings.map(reading => ({...reading,
    compteurId: reading.compteurId === lastId ? firstPendingId : reading.compteurId}))}
  return {target, legacy, incoming: structuredClone(incoming), first, invalid, last}
}

test('retirer le dernier changement répare progressivement un ancien brouillon sans effacer l’erreur d’une autre carte', t => {
  const {target, legacy, incoming, first, invalid, last} = legacyFixture()
  const prepared = prepareCampaignResponseMeters([target], incoming, {campaign, previousDraft: legacy})
  const error = t.throws(() => validateCampaignDraft('INDEX', prepared.draftForSave, {campaign, targets: prepared.targets}))
  t.is(error.statusCode, 400)
  t.true(error.data.issues.some(issue => issue.code === 'METER_EVENT_AFTER_EXIT' && issue.at === invalid.at))
  t.false(error.data.issues.some(issue => issue.at === last.at))
  const repaired = validateCampaignDraft('INDEX', prepared.draftForSave, {campaign, targets: prepared.targets, previousDraft: legacy})
  t.deepEqual(repaired.meterEvents, [first, invalid])
  t.deepEqual(repaired.readings.map(reading => reading.value), legacy.readings.map(reading => reading.value))
  const calculation = calculateCampaignIndexTotals({campaign, targets: prepared.targets, ...prepared.draft})
  t.false(calculation.canSubmit)
  t.true(calculation.issues.some(issue => issue.code === 'METER_EVENT_AFTER_EXIT' && issue.at === invalid.at))
  t.is(t.throws(() => validateCampaignDraft('INDEX', repaired, {campaign, targets: prepared.targets, previousDraft: legacy, complete: true})).statusCode, 400)
  t.deepEqual(legacy.meterEvents, [first, invalid, last])
})

for (const [label, mutate] of [
  ['valeur', draft => {
    draft.readings[1].value = '999'
  }],
  ['provenance', draft => {
    draft.readings[1].sourceChunkValueId = id(20)
    draft.readings[1].sourceValueUpdatedAt = '2026-09-10T12:00:00.000Z'
  }],
  ['confirmation d’identité', draft => {
    draft.readings[1].meterConfirmed = true
  }],
  ['motif d’événement', draft => {
    draft.meterEvents[0].reason = 'Autre motif'
  }],
  ['index d’événement', draft => {
    draft.meterEvents[0].previousIndex = '201'
  }],
  ['commentaire', draft => {
    draft.comment = 'Modification masquée'
  }],
  ['suppression de relevé', draft => {
    draft.readings.pop()
  }],
  ['ajout de carte', draft => {
    draft.meterEvents.push({...draft.meterEvents[1], at: '2026-06-01'})
  }],
  ['date invalide nouvelle', draft => {
    draft.meterEvents[1].at = '2026-07-02'
  }]
]) {
  test(`la réparation progressive ne permet pas de modifier autre chose en même temps : ${label}`, t => {
    const {target, legacy, incoming} = legacyFixture()
    mutate(incoming)
    const prepared = prepareCampaignResponseMeters([target], incoming, {campaign, previousDraft: legacy})
    t.is(t.throws(() => validateCampaignDraft('INDEX', prepared.draftForSave, {campaign, targets: prepared.targets, previousDraft: legacy})).statusCode, 400)
  })
}

test('une nouvelle erreur n’est pas rendue acceptable en déclarant un faux brouillon précédent dans le payload', t => {
  const {target, legacy, incoming} = legacyFixture()
  const prepared = prepareCampaignResponseMeters([target], incoming, {campaign, previousDraft: legacy})
  t.is(t.throws(() => validateCampaignDraft('INDEX', {...prepared.draftForSave, previousDraft: legacy}, {campaign, targets: prepared.targets})).statusCode, 400)
  const unchanged = prepareCampaignResponseMeters([target], legacy, {campaign})
  t.is(t.throws(() => validateCampaignDraft('INDEX', unchanged.draftForSave, {campaign, targets: unchanged.targets, previousDraft: legacy})).statusCode, 400)
})

function serviceFixture() {
  const data = legacyFixture()
  const user = {id: data.target.preleveurUserId, role: 'DECLARANT'}
  const targets = [{...data.target,
    pointPrelevement: {id: data.target.pointPrelevementId, name: 'Point', flowType: 'PRELEVEMENT', collectionMode: 'MANUAL', zones: []},
    exploitation: {status: 'EN_ACTIVITE', collecteurs: []}, preleveur: {userId: user.id, user: {}},
    meters: data.target.meters.map(meter => ({...meter, compteur: {id: meter.compteurId}}))}]
  const storedCampaign = {...campaign, id: id(10), status: 'OPEN', ownerCollecteurUserId: id(11), managers: [], targets}
  const row = {id: id(12), campaignId: storedCampaign.id, preleveurUserId: user.id, kind: 'INDEX', version: 3, status: 'DRAFT', draft: data.legacy, latestSubmission: null}
  const writes = []
  const client = {
    async $transaction(callback) {
      return callback(client)
    },
    async $queryRaw() {
      return []
    },
    campaign: {async findUnique() {
      return storedCampaign
    }},
    campaignResponse: {
      async findUnique() {
        return row
      },
      async findMany() {
        return [row]
      },
      async updateMany({where, data}) {
        if (where.version !== row.version || where.status !== row.status) {
          return {count: 0}
        }

        writes.push(data)
        Object.assign(row, data, {version: row.version + 1})
        return {count: 1}
      }
    },
    campaignSubmission: {async findUnique() {
      return null
    }},
    chunkValue: {async findMany() {
      return []
    }}
  }
  return {...data, user, storedCampaign, row, client, writes}
}

test('le vrai service sauvegarde la suppression seule et renvoie les erreurs restantes, sans aucune écriture d’inventaire', async t => {
  const {user, storedCampaign, row, client, writes, incoming, invalid} = serviceFixture()
  const inventoryBefore = structuredClone(storedCampaign.targets[0].meters)
  const result = await saveCampaignResponse(user, storedCampaign.id, 'INDEX', {preleveurUserId: user.id, expectedVersion: row.version, data: incoming}, {client})
  t.is(writes.length, 1)
  t.is(result.response.version, 4)
  t.deepEqual(result.response.draft.readings.map(reading => reading.value), ['100', '250.1234'])
  t.true(result.calculation.issues.some(issue => issue.code === 'METER_EVENT_AFTER_EXIT' && issue.at === invalid.at))
  t.false(result.calculation.canSubmit)
  t.deepEqual(storedCampaign.targets[0].meters, inventoryBefore)
  const error = await t.throwsAsync(() => submitCampaignResponse(user, storedCampaign.id, 'INDEX', {
    preleveurUserId: user.id, expectedVersion: row.version, idempotencyKey: id(25)
  }, {client}))
  t.is(error.statusCode, 400)
  t.is(writes.length, 1)
})

for (const failure of ['version', 'permission', 'valeur', 'périmètre']) {
  test(`le service refuse la réparation avant toute écriture en cas de ${failure} incorrecte`, async t => {
    const {user, storedCampaign, row, client, writes, incoming} = serviceFixture()
    if (failure === 'valeur') {
      incoming.readings[1].value = '999'
    }

    if (failure === 'périmètre') {
      incoming.meterEvents[0].targetId = id(99)
    }

    const error = await t.throwsAsync(() => saveCampaignResponse(failure === 'permission' ? {...user, id: id(99)} : user, storedCampaign.id, 'INDEX', {
      preleveurUserId: user.id, expectedVersion: failure === 'version' ? row.version - 1 : row.version, data: incoming
    }, {client}))
    t.is(error.statusCode, failure === 'version' ? 409 : (failure === 'valeur' ? 400 : 403))
    t.deepEqual(writes, [])
    t.is(row.version, 3)
  })
}
