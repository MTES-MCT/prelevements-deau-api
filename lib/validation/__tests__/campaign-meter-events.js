import test from 'ava'
import {validateCampaignDraft} from '../campaigns.js'
import {prepareCampaignResponseMeters} from '../../services/campaign-response-meters.js'
import {calculateCampaignIndexTotals} from '../../services/campaign-index.js'

const id = suffix => `10000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
const firstId = id(2)
const secondId = id(3)
const thirdId = id(4)
const target = {id: id(1), pointPrelevementId: id(5), preleveurUserId: id(8), meters: [firstId, secondId, thirdId].map(compteurId => ({compteurId}))}
const campaign = {indexDates: ['2026-01-01', '2026-07-01'], periods: [
  {id: id(6), kind: 'INDEX', position: 0, startDate: '2026-01-01', endDate: '2026-07-01', startReadingDate: '2026-01-01', endReadingDate: '2026-07-01'}
]}
const reset = overrides => ({targetId: target.id, type: 'RESET', at: '2026-04-01', previousCompteurId: firstId, previousIndex: null, nextIndex: null, reason: 'À compléter', ...overrides})
const replacement = overrides => ({...reset(), type: 'REPLACEMENT', nextCompteurId: secondId, ...overrides})
const validate = (meterEvents, overrides = {}) => validateCampaignDraft('INDEX', {readings: [], meterEvents}, {campaign, targets: [target], ...overrides})

function hasIssue(t, action, code, at) {
  const error = t.throws(action)
  t.is(error.statusCode, 400)
  const issue = error.data.issues.find(issue => issue.code === code && (!at || issue.at === at))
  t.truthy(issue)
  t.is(issue.targetId, target.id)
  t.is(issue.field, 'at')
  t.is(typeof issue.message, 'string')
  return issue
}

test('les deux bornes de campagne restent autorisées sans exiger les index ni les relevés', t => {
  for (const at of campaign.indexDates) {
    const draft = validate([reset({at})])
    t.deepEqual(draft.readings, [])
    t.is(draft.meterEvents[0].previousIndex, null)
    t.is(draft.meterEvents[0].nextIndex, null)
  }
})

for (const at of ['2025-12-31', '2026-07-02']) {
  test(`la date hors campagne est localisée et expliquée dès le brouillon : ${at}`, t => {
    const issue = hasIssue(t, () => validate([reset({at})]), 'METER_EVENT_OUTSIDE_CAMPAIGN', at)
    t.regex(issue.message, /01\/01\/2026 et le 01\/07\/2026/)
    t.is(issue.compteurId, firstId)
  })
}

test('les bornes de l’affectation de l’ancien compteur sont inclusives', t => {
  const targets = [{...target, meters: [{compteurId: firstId, startDate: '2026-02-01', endDate: '2026-06-01'}]}]
  for (const at of ['2026-02-01', '2026-06-01']) {
    t.notThrows(() => validate([reset({at})], {targets}))
  }

  for (const at of ['2026-01-31', '2026-06-02']) {
    hasIssue(t, () => validate([reset({at})], {targets}), 'METER_EVENT_OUTSIDE_PREVIOUS_BINDING', at)
  }
})

test('la date doit aussi appartenir à l’affectation du nouveau compteur réel', t => {
  const targets = [{...target, meters: [{compteurId: firstId}, {compteurId: secondId, startDate: new Date('2026-03-01'), endDate: new Date('2026-06-01')}]}]
  for (const at of ['2026-02-28', '2026-06-02']) {
    const issue = hasIssue(t, () => validate([replacement({at})], {targets}), 'METER_EVENT_OUTSIDE_NEXT_BINDING', at)
    t.regex(issue.message, /du nouveau compteur/)
  }

  for (const at of ['2026-03-01', '2026-06-01']) {
    t.notThrows(() => validate([replacement({at})], {targets}))
  }
})

test('une affectation sérialisée en timestamp ISO conserve des bornes civiles inclusives', t => {
  const targets = [{...target, meters: [
    {compteurId: firstId, startDate: '2026-01-01T00:00:00.000Z', endDate: '2026-04-01T00:00:00.000Z'},
    {compteurId: secondId, startDate: '2026-04-01T00:00:00.000Z', endDate: '2026-07-01T00:00:00.000Z'}
  ]}]
  t.notThrows(() => validate([replacement()], {targets}))
  hasIssue(t, () => validate([replacement({at: '2026-03-31'})], {targets}), 'METER_EVENT_OUTSIDE_NEXT_BINDING')
  hasIssue(t, () => validate([replacement({at: '2026-04-02'})], {targets}), 'METER_EVENT_OUTSIDE_PREVIOUS_BINDING')
})

test('deux sorties du même compteur sont signalées sur les deux événements', t => {
  const events = [replacement(), replacement({at: '2026-05-01', nextCompteurId: thirdId})]
  for (const at of events.map(event => event.at)) {
    hasIssue(t, () => validate(events), 'MULTIPLE_METER_REPLACEMENTS', at)
  }
})

test('un compteur ne peut entrer dans deux remplacements distincts', t => {
  const events = [replacement(), replacement({at: '2026-05-01', previousCompteurId: thirdId})]
  hasIssue(t, () => validate(events), 'METER_ENTERED_MULTIPLE_TIMES', events[1].at)
})

test('une remise à zéro après le remplacement de l’ancien compteur n’est plus ignorée', t => {
  const events = [replacement(), reset({at: '2026-05-01'})]
  const issue = hasIssue(t, () => validate(events), 'METER_EVENT_AFTER_EXIT', events[1].at)
  t.is(issue.relatedAt, '2026-04-01')
})

test('une remise à zéro avant l’entrée du nouveau compteur est refusée même sans dates d’inventaire', t => {
  const events = [replacement(), reset({at: '2026-03-01', previousCompteurId: secondId})]
  hasIssue(t, () => validate(events), 'METER_EVENT_BEFORE_ENTRY', events[1].at)
})

test('deux changements en chaîne le même jour ne créent pas une phase de longueur nulle', t => {
  for (const second of [reset({previousCompteurId: secondId}), replacement({previousCompteurId: secondId, nextCompteurId: thirdId})]) {
    hasIssue(t, () => validate([replacement(), second]), 'METER_EVENT_BEFORE_ENTRY', second.at)
  }
})

test('une boucle entre compteurs est refusée quelle que soit la présentation des cartes', t => {
  const events = [replacement(), replacement({at: '2026-05-01', previousCompteurId: secondId, nextCompteurId: firstId})]
  hasIssue(t, () => validate(events), 'METER_EVENT_BEFORE_ENTRY', events[0].at)
  hasIssue(t, () => validate([...events].reverse()), 'METER_EVENT_BEFORE_ENTRY', events[0].at)
})

test('la chronologie valide ne dépend pas de l’ordre du tableau et le brouillon peut rester incomplet', t => {
  const events = [reset({at: '2026-02-01'}), replacement(), reset({at: '2026-05-01', previousCompteurId: secondId})]
  t.notThrows(() => validate(events))
  t.notThrows(() => validate([...events].reverse()))
})

test('des changements indépendants sur deux compteurs peuvent avoir la même date', t => {
  t.notThrows(() => validate([reset(), reset({previousCompteurId: secondId})]))
})

test('des changements indépendants sur deux points ne se mélangent pas', t => {
  const other = {...target, id: id(7)}
  t.notThrows(() => validate([replacement(), replacement({targetId: other.id})], {targets: [target, other]}))
})

test('la suppression d’une remise à zéro laisse les autres événements et toutes les valeurs intacts', t => {
  const first = reset({at: '2026-02-01', previousIndex: '200', nextIndex: '0'})
  const second = reset({at: '2026-05-01', previousIndex: '300', nextIndex: '0'})
  const readings = campaign.indexDates.map((readingDate, index) => ({targetId: target.id, compteurId: firstId, readingDate, value: index === 0 ? '100' : '50'}))
  const original = {meterEvents: [first, second], readings}
  const before = structuredClone(original)
  const after = validateCampaignDraft('INDEX', {...original, meterEvents: [second]}, {campaign, targets: [target]})
  t.deepEqual(after.readings, readings)
  t.deepEqual(after.meterEvents, [second])
  t.deepEqual(original, before)
  // Retirer toutes les remises à zéro peut laisser une baisse à corriger :
  // ce conflit ne doit pas empêcher l'enregistrement du brouillon incomplet.
  t.notThrows(() => validateCampaignDraft('INDEX', {...original, meterEvents: []}, {campaign, targets: [target]}))
})

test('la suppression indépendante d’un remplacement virtuel sans dépendance ne modifie aucun inventaire', t => {
  const scoped = {...target, meters: [{compteurId: firstId}]}
  const pending = {...replacement(), nextMeter: {serialNumber: 'Nouveau'}}
  delete pending.nextCompteurId
  const original = {readings: [], meterEvents: [reset({at: '2026-02-01'}), pending]}
  const prepared = prepareCampaignResponseMeters([scoped], original, {campaign})
  t.is(prepared.targets[0].meters.length, 2)
  const after = prepareCampaignResponseMeters([scoped], {...original, meterEvents: original.meterEvents.slice(0, 1)}, {campaign})
  t.notThrows(() => validateCampaignDraft('INDEX', after.draftForSave, {campaign, targets: after.targets}))
  t.deepEqual(after.targets[0].meters, scoped.meters)
  t.is(scoped.meters.length, 1)
})

test('supprimer un remplacement dont des relevés dépendent est refusé sans les effacer', t => {
  const scoped = {...target, meters: [{compteurId: firstId}]}
  const pending = {...replacement(), nextMeter: {serialNumber: 'Nouveau'}}
  delete pending.nextCompteurId
  const prepared = prepareCampaignResponseMeters([scoped], {readings: [], meterEvents: [pending]}, {campaign})
  const readings = [{targetId: target.id, compteurId: prepared.draft.meterEvents[0].nextCompteurId, readingDate: '2026-07-01', value: '50'}]
  const before = structuredClone(readings)
  t.is(t.throws(() => validateCampaignDraft('INDEX', {readings, meterEvents: []}, {campaign, targets: [scoped]})).statusCode, 400)
  t.deepEqual(readings, before)
  t.deepEqual(scoped.meters, [{compteurId: firstId}])
})

function removedReplacement({sourceMeterId, referenceKind, meterConfirmed = true, value = '250'} = {}) {
  const scoped = {...target, meters: [{compteurId: firstId}]}
  const pending = {...replacement(), nextMeter: {serialNumber: 'Nouveau'}}
  delete pending.nextCompteurId
  const before = prepareCampaignResponseMeters([scoped], {readings: [], meterEvents: [pending]}, {campaign})
  const pendingId = before.draft.meterEvents[0].nextCompteurId
  const source = {id: id(9), updatedAt: '2026-09-10T12:00:00.000Z', readingDate: '2026-07-01', value: '250', metricTypeCode: 'index', valueKind: 'DECLARED',
    chunk: {pointPrelevementId: target.pointPrelevementId, preleveurUserId: target.preleveurUserId, compteurId: sourceMeterId === 'pending' ? pendingId : sourceMeterId,
      instructionStatus: 'VALIDATED', source: {status: 'COMPLETED'}}}
  const readings = [{targetId: target.id, compteurId: firstId, readingDate: '2026-01-01', value: '100'},
    {targetId: target.id, compteurId: pendingId, readingDate: '2026-07-01', value, ...(referenceKind
      ? {
        [referenceKind]: source.id, sourceValueUpdatedAt: source.updatedAt, meterConfirmed,
        ...(referenceKind === 'correctionOfChunkValueId' ? {correctionReason: 'Correction conservée'} : {})
      }
      : {})}]
  const original = {...before.draftForSave, readings}
  const after = prepareCampaignResponseMeters([scoped], {...original, meterEvents: [],
    readings: readings.map(reading => ({...reading, compteurId: reading.compteurId === pendingId ? firstId : reading.compteurId}))}, {campaign, previousDraft: original})
  const draft = validateCampaignDraft('INDEX', after.draftForSave, {campaign, targets: after.targets})
  const calculation = calculateCampaignIndexTotals({campaign, targets: after.targets, ...draft, existingReadings: referenceKind ? [source] : []})
  return {original, draft, calculation, scoped, after, pendingId}
}

test('supprimer un remplacement connu vers pending peut rattacher les valeurs à l’ancien compteur sans supprimer de donnée', t => {
  const {original, draft, calculation, scoped, after, pendingId} = removedReplacement()
  t.true(calculation.canSubmit)
  t.is(calculation.totals[0].value, '150')
  t.deepEqual(draft.readings.map(reading => reading.value), ['100', '250'])
  t.deepEqual(draft.readings.map(reading => reading.compteurId), [firstId, firstId])
  t.is(original.readings[1].compteurId, pendingId)
  t.deepEqual(after.targets[0].meters, scoped.meters)
  t.deepEqual(scoped.meters, [{compteurId: firstId}])
})

for (const referenceKind of ['sourceChunkValueId', 'correctionOfChunkValueId']) {
  test(`la suppression conserve une source anonyme compatible et son contrôle d’identité : ${referenceKind}`, t => {
    const {draft, original, calculation} = removedReplacement({sourceMeterId: null, referenceKind})
    t.true(calculation.canSubmit)
    t.deepEqual(draft.readings[1], {...original.readings[1], compteurId: firstId})
    const unconfirmed = removedReplacement({sourceMeterId: null, referenceKind, meterConfirmed: false})
    t.false(unconfirmed.calculation.canSubmit)
    t.true(unconfirmed.calculation.issues.some(issue => issue.code === 'AMBIGUOUS_HISTORICAL_METER'))
    t.false(unconfirmed.draft.readings[1].meterConfirmed)
  })

  test(`une source identifiée sur un autre compteur reste incompatible après suppression : ${referenceKind}`, t => {
    const {draft, original, calculation} = removedReplacement({sourceMeterId: 'pending', referenceKind})
    t.false(calculation.canSubmit)
    t.true(calculation.issues.some(issue => issue.code === 'SOURCE_METER_MISMATCH'))
    t.deepEqual(draft.readings[1], {...original.readings[1], compteurId: firstId})
    t.true(removedReplacement({sourceMeterId: firstId, referenceKind}).calculation.canSubmit)
  })
}

test('une baisse d’index après suppression reste visible sans empêcher de conserver le brouillon', t => {
  const {draft, calculation} = removedReplacement({value: '50'})
  t.is(draft.readings[1].value, '50')
  t.false(calculation.canSubmit)
  t.true(calculation.issues.some(issue => issue.code === 'NEGATIVE_DELTA_REQUIRES_EVENT'))
})

test('les anciens brouillons aux événements incohérents exposent aussi leurs erreurs dans le calcul', t => {
  const meterEvents = [replacement(), reset({at: '2026-05-01', previousIndex: '300', nextIndex: '0'})]
  const result = calculateCampaignIndexTotals({campaign, targets: [target], readings: [], meterEvents})
  t.false(result.canSubmit)
  t.true(result.issues.some(issue => issue.code === 'METER_EVENT_AFTER_EXIT' && issue.at === '2026-05-01' && issue.targetId === target.id))
})

test('une carte dupliquée est identifiée sans exposer d’informations d’un autre périmètre', t => {
  hasIssue(t, () => validate([reset(), reset()]), 'DUPLICATE_METER_EVENT')
  const error = t.throws(() => validate([reset({targetId: id(99)})]))
  t.is(error.statusCode, 403)
  t.is(error.data, undefined)
})
