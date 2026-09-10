import test from 'ava'
import {validateCampaignDraft} from '../campaigns.js'
import {prepareCampaignResponseMeters} from '../../services/campaign-response-meters.js'

const id = suffix => `10000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
const dates = ['2026-01-01', '2026-04-01', '2026-07-01']
const target = {id: id(1), pointPrelevementId: id(2), meters: []}
const campaign = {
  indexDates: dates,
  periods: dates.slice(1).map((end, index) => ({
    id: id(index + 3), kind: 'INDEX', position: index, startDate: dates[index], endDate: end,
    startReadingDate: dates[index], endReadingDate: end
  }))
}
const reset = {targetId: target.id, type: 'RESET', at: dates[1], previousCompteurId: null, nextCompteurId: null, previousIndex: '200', nextIndex: '0', reason: 'Remise à zéro'}
const replacement = {
  targetId: target.id, type: 'REPLACEMENT', at: dates[1], previousCompteurId: null, nextMeter: {serialNumber: 'NOUVEAU'}, previousIndex: '200', nextIndex: '0', reason: 'Remplacement'
}
const readings = dates.map((readingDate, index) => ({targetId: target.id, compteurId: null, readingDate, value: String(index * 100)}))

test('un ancien compteur non référencé accepte une remise à zéro avec deux identités nulles', t => {
  const draft = validateCampaignDraft('INDEX', {readings, meterEvents: [reset]}, {campaign, targets: [target]})
  t.is(draft.meterEvents[0].previousCompteurId, null)
  t.is(draft.meterEvents[0].nextCompteurId, null)
  t.deepEqual(target.meters, [])
  const known = {...target, meters: [{compteurId: id(10), startDate: '2025-01-01'}], meterlessInitial: true}
  t.is(t.throws(() => validateCampaignDraft('INDEX', {meterEvents: [reset]}, {campaign, targets: [known]})).statusCode, 403)
  t.is(t.throws(() => validateCampaignDraft('INDEX', {meterEvents: [{...reset, previousCompteurId: id(10)}]}, {campaign, targets: [known]})).statusCode, 400)
})

test('le remplacement conserve les valeurs déjà saisies seulement après une confirmation explicite de rattachement', t => {
  const raw = {readings, meterEvents: [replacement]}
  const before = structuredClone(raw)
  const unchanged = prepareCampaignResponseMeters([target], raw, {campaign})
  t.deepEqual(unchanged.draftForSave.readings, readings)
  t.is(t.throws(() => validateCampaignDraft('INDEX', unchanged.draftForSave, {campaign, targets: unchanged.targets})).statusCode, 400)
  const confirmed = prepareCampaignResponseMeters([target], {...raw, meterEvents: [{...replacement, reassignFollowingReadings: true}]}, {campaign})
  const pending = confirmed.targets[0].meters[0]
  t.deepEqual(confirmed.draftForSave.readings.map(reading => reading.compteurId), [null, null, pending.compteurId])
  t.deepEqual(confirmed.draftForSave.readings.map(reading => reading.value), ['0', '100', '200'])
  t.deepEqual(confirmed.draftForSave.meterEvents[0].nextMeter, {serialNumber: 'NOUVEAU'})
  t.false(Object.hasOwn(confirmed.draftForSave.meterEvents[0], 'reassignFollowingReadings'))
  t.notThrows(() => validateCampaignDraft('INDEX', confirmed.draftForSave, {campaign, targets: confirmed.targets}))
  t.deepEqual(raw, before)
  t.deepEqual(target.meters, [])
})

test('la confirmation ne réattribue pas un autre point, la date du changement ou une lecture déjà identifiée', t => {
  const other = {...target, id: id(20)}
  const raw = {
    readings: [...readings, {...readings[2], targetId: other.id}, {...readings[2], compteurId: id(21)}],
    meterEvents: [{...replacement, reassignFollowingReadings: true}]
  }
  const prepared = prepareCampaignResponseMeters([target, other], raw, {campaign})
  t.deepEqual(prepared.draftForSave.readings[1], readings[1])
  t.deepEqual(prepared.draftForSave.readings[3], raw.readings[3])
  t.deepEqual(prepared.draftForSave.readings[4], raw.readings[4])
  t.is(prepared.draftForSave.readings[2].compteurId, prepared.targets[0].meters[0].compteurId)
})

test('le rattachement confirmé conserve les références historiques et confirme leur identité sans inventer une valeur', t => {
  const source = {...readings[2], sourceChunkValueId: id(30), sourceValueUpdatedAt: '2026-08-01T12:00:00.000Z', meterConfirmed: false}
  const prepared = prepareCampaignResponseMeters([target], {readings: [source], meterEvents: [{...replacement, reassignFollowingReadings: true}]}, {campaign})
  t.deepEqual(prepared.draftForSave.readings[0], {...source, compteurId: prepared.targets[0].meters[0].compteurId, meterConfirmed: true})
  t.notThrows(() => validateCampaignDraft('INDEX', prepared.draftForSave, {campaign, targets: prepared.targets}))
})

test('la réattribution vers un compteur réel reste limitée à la phase initiale sans identité', t => {
  const known = {...target, meters: [{compteurId: id(40), compteur: {id: id(40)}, startDate: dates[1]}]}
  const {nextMeter, ...event} = replacement
  const prepared = prepareCampaignResponseMeters([known], {readings, meterEvents: [{...event, nextCompteurId: id(40), reassignFollowingReadings: true}]}, {campaign})
  t.is(prepared.draftForSave.readings[2].compteurId, id(40))
  t.notThrows(() => validateCampaignDraft('INDEX', prepared.draftForSave, {campaign, targets: prepared.targets}))
  known.meters[0].startDate = '2025-01-01'
  t.is(t.throws(() => prepareCampaignResponseMeters([known], {readings, meterEvents: [{...event, nextCompteurId: id(40), reassignFollowingReadings: true}]}, {campaign})).statusCode, 403)
})

test('les demandes de réattribution étrangères ou incohérentes sont refusées sans modifier les relevés', t => {
  const confirmed = {...replacement, reassignFollowingReadings: true}
  t.is(t.throws(() => prepareCampaignResponseMeters([], {readings, meterEvents: [confirmed]}, {campaign})).statusCode, 403)
  t.is(t.throws(() => prepareCampaignResponseMeters([target], {readings, meterEvents: [{...reset, reassignFollowingReadings: true}]}, {campaign})).statusCode, 400)
  const known = {...target, meters: [{compteurId: id(50), compteur: {id: id(50)}}]}
  t.is(t.throws(() => prepareCampaignResponseMeters([known], {readings, meterEvents: [confirmed]}, {campaign})).statusCode, 403)
  t.deepEqual(readings.map(reading => reading.compteurId), [null, null, null])
})

test('deux relevés présents sur la même nouvelle identité ne sont jamais écrasés par le rattachement', t => {
  const initial = prepareCampaignResponseMeters([target], {readings: [], meterEvents: [replacement]}, {campaign})
  const pendingId = initial.targets[0].meters[0].compteurId
  const prepared = prepareCampaignResponseMeters([target], {
    readings: [readings[2], {...readings[2], compteurId: pendingId, value: '250'}],
    meterEvents: [{...replacement, reassignFollowingReadings: true}]
  }, {campaign})
  t.is(prepared.draftForSave.readings.length, 2)
  t.deepEqual(prepared.draftForSave.readings.map(reading => reading.value), ['200', '250'])
  t.is(t.throws(() => validateCampaignDraft('INDEX', prepared.draftForSave, {campaign, targets: prepared.targets})).statusCode, 400)
})

test('les dates et les cibles restent contrôlées pour les événements null et le flag ne peut pas être arbitraire', t => {
  for (const event of [{...reset, at: '2025-12-31'}, {...reset, at: '2026-07-02'}, {...replacement, nextMeter: undefined, nextCompteurId: null}]) {
    const error = t.throws(() => validateCampaignDraft('INDEX', {meterEvents: [event]}, {campaign, targets: [target]}))
    t.true([400, 403].includes(error.statusCode))
  }

  t.is(t.throws(() => validateCampaignDraft('INDEX', {meterEvents: [{...reset, targetId: id(60)}]}, {campaign, targets: [target]})).statusCode, 403)
  t.is(t.throws(() => validateCampaignDraft('INDEX', {meterEvents: [{...replacement, reassignFollowingReadings: 'invalide'}]}, {campaign, targets: [target]})).statusCode, 400)
})
