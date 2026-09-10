import test from 'ava'
import {calculateCampaignIndexTotals} from '../campaign-index.js'
import {prepareCampaignResponseMeters} from '../campaign-response-meters.js'

const dates = ['2026-01-01', '2026-04-01', '2026-07-01']
const campaign = {
  id: 'campaign', indexDates: dates,
  periods: dates.slice(1).map((date, position) => ({
    id: `period-${position}`, kind: 'INDEX', position,
    startDate: dates[position], endDate: date,
    startReadingDate: dates[position], endReadingDate: date
  }))
}
const target = {id: 'target', pointPrelevementId: 'point', preleveurUserId: 'farmer', meters: []}
const reading = (date, value, compteurId = null, extra = {}) => ({
  targetId: target.id, compteurId, readingDate: date, value,
  ...extra
})
const reset = extra => ({
  targetId: target.id, type: 'RESET', at: '2026-02-01',
  previousCompteurId: null, nextCompteurId: null,
  previousIndex: '150', nextIndex: '10', reason: 'Remise à zéro après intervention', ...extra
})
const replacement = extra => ({
  targetId: target.id, type: 'REPLACEMENT', at: '2026-02-01', previousCompteurId: null,
  nextMeter: {serialNumber: 'COMPTEUR-NEUF'}, previousIndex: '150', nextIndex: '10',
  reason: 'Ancien compteur remplacé', ...extra
})
const defaultReadings = () => dates.map((date, index) => reading(date, ['100', '210', '300'][index]))
const prepare = (draft, targets = [target]) => prepareCampaignResponseMeters(targets, {comment: '', readings: [], meterEvents: [], ...draft}, {campaign})
const calculate = (prepared, extra = {}) => calculateCampaignIndexTotals({campaign, targets: prepared.targets, ...prepared.draft, ...extra})
const values = result => result.totals.map(total => total.value)
const chronologicalSegments = total => [...total.segments].sort((a, b) => a.from.localeCompare(b.from))
const fixture = (event = replacement()) => {
  const prepared = prepare({meterEvents: [event]})
  const {nextCompteurId} = prepared.draft.meterEvents[0]
  prepared.draft.readings = dates.map((date, index) => {
    const value = date === event.at && event.nextIndex !== null ? event.nextIndex : ['100', '210', '300'][index]
    return reading(date, value, date < event.at ? null : nextCompteurId)
  })
  return {prepared, nextCompteurId}
}

const asPersisted = prepared => ({
  targets: prepared.targets.map(item => ({
    ...item,
    meters: item.meters.map(({pending, pendingEvent, ...meter}) => ({...meter, associationId: `association-${meter.compteurId}`}))
  })),
  draft: structuredClone(prepared.draft)
})

test('sans inventaire : une remise à zéro conserve deux segments exacts sans créer de compteur', t => {
  const draft = {readings: defaultReadings(), meterEvents: [reset()], comment: 'Précision du préleveur'}
  const before = structuredClone({target, draft})
  const prepared = prepare(draft)
  const result = calculate(prepared)
  t.true(result.canSubmit)
  t.deepEqual(values(result), ['250', '90'])
  t.deepEqual(result.totals[0].segments.map(segment => segment.value), ['50', '200'])
  t.true(result.totals.flatMap(total => total.segments).every(segment => segment.compteurId === null))
  t.deepEqual(prepared.targets[0].meters, [])
  t.true(prepared.targets[0].meterlessInitial)
  t.is(prepared.targets[0].meterlessEndDate, null)
  t.deepEqual({target, draft}, before)
  t.is(prepared.draft.comment, 'Précision du préleveur')
})

test('sans inventaire : le remplacement ajoute uniquement le nouveau compteur et ne perd pas le volume ancien', t => {
  const {prepared, nextCompteurId} = fixture()
  const result = calculate(prepared)
  t.true(result.canSubmit)
  t.deepEqual(values(result), ['250', '90'])
  t.deepEqual(chronologicalSegments(result.totals[0]).map(segment => [segment.compteurId, segment.value]), [[null, '50'], [nextCompteurId, '200']])
  t.is(prepared.targets[0].meters.length, 1)
  t.true(prepared.targets[0].meters[0].pending)
  t.is(prepared.targets[0].meters[0].compteur.serialNumber, 'COMPTEUR-NEUF')
  // Public UI metadata ignores a pending replacement so local cancellation can
  // restore the unregistered phase; the calculation still uses the event date.
  t.is(prepared.targets[0].meterlessEndDate, null)
  t.false(prepared.targets[0].meters.some(meter => meter.compteurId === null))
  t.is(prepared.draft.meterEvents[0].previousCompteurId, null)
  t.false(Object.hasOwn(prepared.draft.meterEvents[0], 'nextMeter'))
  t.deepEqual(target.meters, [])
})

test('le compteur virtuel est stable lors des relectures et l’annulation ne laisse aucun compteur', t => {
  const event = replacement()
  const initial = prepare({meterEvents: [event]})
  const replay = prepare({meterEvents: [structuredClone(event)]})
  t.is(initial.targets[0].meters[0].compteurId, replay.targets[0].meters[0].compteurId)
  const twice = prepare(initial.draft, initial.targets)
  t.is(twice.targets[0].meters.length, 1)
  t.deepEqual(prepare({meterEvents: []}).targets[0].meters, [])
})

test('les compteurs déjà persistés conservent la phase non référencée lors du rejeu et d’un commentaire', t => {
  const {prepared} = fixture()
  const persisted = asPersisted(prepared)
  const replay = prepare({...persisted.draft, comment: 'Commentaire corrigé'}, persisted.targets)
  const result = calculate(replay)
  t.true(result.canSubmit)
  t.deepEqual(values(result), ['250', '90'])
  t.is(replay.targets[0].meters.length, 1)
  t.false(replay.targets[0].meters.some(meter => meter.pending))
  t.true(replay.targets[0].meterlessInitial)
  t.is(replay.targets[0].meterlessEndDate, '2026-02-01')
  t.is(replay.draft.comment, 'Commentaire corrigé')
  t.is(replay.draft.readings[0].compteurId, null)
})

for (const [at, previousIndex, nextIndex, expected] of [
  [dates[0], '1000', '10', ['200', '90']],
  [dates[1], '250', '10', ['150', '290']],
  [dates[2], '350', '0', ['110', '140']]
]) {
  test(`la remise à zéro non référencée respecte la frontière ${at}`, t => {
    const result = calculate(prepare({readings: defaultReadings(), meterEvents: [reset({at, previousIndex, nextIndex})]}))
    t.true(result.canSubmit)
    t.deepEqual(values(result), expected)
  })

  test(`le remplacement non référencé respecte la frontière ${at} sans double comptage`, t => {
    const {prepared} = fixture(replacement({at, previousIndex, nextIndex}))
    const result = calculate(prepared)
    t.true(result.canSubmit)
    t.deepEqual(values(result), expected)
  })
}

test('zéro et quatre décimales restent exacts même après un très grand index non référencé', t => {
  const {prepared, nextCompteurId} = fixture(replacement({previousIndex: '9999999999999999.2235', nextIndex: '0'}))
  prepared.draft.readings = [reading(dates[0], '9999999999999999.1234'), reading(dates[1], '0.0004', nextCompteurId), reading(dates[2], '0.0010', nextCompteurId)]
  const result = calculate(prepared)
  t.true(result.canSubmit)
  t.deepEqual(values(result), ['0.1005', '0.0006'])
  const zero = calculate(prepare({readings: dates.map(date => reading(date, '0')), meterEvents: [reset({previousIndex: '0', nextIndex: '0'})]}))
  t.true(zero.canSubmit)
  t.deepEqual(values(zero), ['0', '0'])
  t.true(zero.totals.every(total => total.status === 'COMPLETE'))
})

for (const kind of ['RESET', 'REPLACEMENT']) {
  test(`${kind} non référencé : les index indisponibles justifiés ne deviennent jamais zéro`, t => {
    for (const [extra, expected] of [
      [{previousIndex: null, previousMissingReason: 'Cadran ancien illisible'}, [null, '290']],
      [{nextIndex: null, nextMissingReason: 'Cadran nouveau inaccessible'}, ['150', null]],
      [{previousIndex: null, nextIndex: null}, [null, null]]
    ]) {
      const event = (kind === 'RESET' ? reset : replacement)({at: dates[1], previousIndex: '250', nextIndex: '10', ...extra})
      const prepared = kind === 'RESET' ? prepare({readings: defaultReadings(), meterEvents: [event]}) : fixture(event).prepared
      const result = calculate(prepared)
      t.true(result.canSubmit)
      t.deepEqual(values(result), expected)
      t.true(result.totals.filter(total => total.value === null).every(total => total.status === 'MISSING'))
      const reasons = new Set(result.totals.flatMap(total => total.missing).map(item => item.reason))
      if (extra.previousMissingReason) {
        t.true(reasons.has(extra.previousMissingReason))
      }

      if (extra.nextMissingReason) {
        t.true(reasons.has(extra.nextMissingReason))
      }
    }
  })
}

test('plusieurs remises à zéro non référencées sont ordonnées et chaque segment est compté une fois', t => {
  const result = calculate(prepare({
    readings: [reading(dates[0], '100'), reading(dates[1], '35'), reading(dates[2], '80')],
    meterEvents: [reset({at: '2026-03-01', previousIndex: '40', nextIndex: '5'}), reset({previousIndex: '150', nextIndex: '0'})]
  }))
  t.true(result.canSubmit)
  t.deepEqual(values(result), ['120', '45'])
  t.deepEqual(result.totals[0].segments.map(segment => segment.value), ['50', '40', '30'])
})

test('la chaîne remise à zéro non référencée puis remplacement puis remise à zéro connue reste exacte', t => {
  const prepared = prepare({meterEvents: [reset({previousIndex: '150', nextIndex: '0'}), replacement({at: '2026-03-01', previousIndex: '40', nextIndex: '10'})]})
  const {nextCompteurId} = prepared.draft.meterEvents[1]
  prepared.draft.meterEvents.push(reset({at: '2026-05-01', previousCompteurId: nextCompteurId, nextCompteurId, previousIndex: '50', nextIndex: '0'}))
  prepared.draft.readings = [reading(dates[0], '100'), reading(dates[1], '30', nextCompteurId), reading(dates[2], '70', nextCompteurId)]
  const result = calculate(prepared)
  t.true(result.canSubmit)
  t.deepEqual(values(result), ['110', '90'])
  t.deepEqual(chronologicalSegments(result.totals[0]).map(segment => segment.value), ['50', '40', '20'])
  t.deepEqual(values(calculate(prepare(asPersisted(prepared).draft, asPersisted(prepared).targets))), ['110', '90'])
})

test('la chaîne de deux remplacements conserve l’ancien index non référencé et les deux nouveaux compteurs', t => {
  const {prepared, nextCompteurId: firstId} = fixture()
  const next = prepare({...prepared.draft, meterEvents: [...prepared.draft.meterEvents, replacement({
    at: '2026-05-01', previousCompteurId: firstId, nextMeter: {identifier: 'SECOND-COMPTEUR'}, previousIndex: '250', nextIndex: '5'
  })]}, prepared.targets)
  const secondId = next.draft.meterEvents[1].nextCompteurId
  next.draft.readings = [reading(dates[0], '100'), reading(dates[1], '210', firstId), reading(dates[2], '60', secondId)]
  const result = calculate(next)
  t.true(result.canSubmit)
  t.deepEqual(values(result), ['250', '95'])
  t.is(next.targets[0].meters.length, 2)
  t.not(firstId, secondId)
  t.deepEqual(result.totals[1].segments.map(segment => [segment.compteurId, segment.value]), [[firstId, '40'], [secondId, '55']])
  t.deepEqual(values(calculate(prepare(asPersisted(next).draft, asPersisted(next).targets))), ['250', '95'])
})

test('un inventaire actif ne peut pas être contourné par un ancien compteur null', t => {
  for (const meter of [{compteurId: 'known'}, {compteurId: 'known', startDate: '2025-01-01'}, {compteurId: 'known', startDate: dates[0]}]) {
    for (const event of [reset(), replacement()]) {
      const prepared = prepare({readings: defaultReadings(), meterEvents: [event]}, [{...target, meters: [meter]}])
      const result = calculate(prepared)
      t.false(result.canSubmit)
      t.true(result.totals.every(total => total.value === null))
      t.false(prepared.targets[0].meterlessInitial)
    }
  }
})

test('les métadonnées d’affichage ne peuvent pas inventer une phase non référencée', t => {
  const known = {...target, meterlessInitial: true, meterlessEndDate: null, meters: [{compteurId: 'known', startDate: '2025-01-01'}]}
  const draft = {readings: defaultReadings(), meterEvents: [reset()]}
  t.false(calculate({targets: [known], draft}).canSubmit)
  const prepared = prepare(draft, [known])
  t.false(prepared.targets[0].meterlessInitial)
  t.false(calculate(prepared).canSubmit)
})

test('les phases et événements sans identité restent indépendants entre deux points', t => {
  const other = {...target, id: 'other-target', pointPrelevementId: 'other-point', preleveurUserId: 'other-farmer'}
  const prepared = prepare({
    readings: [...defaultReadings(), ...dates.map((date, index) => ({...reading(date, ['200', '310', '400'][index]), targetId: other.id}))],
    meterEvents: [reset({nextIndex: '0'}), reset({targetId: other.id, previousIndex: '250', nextIndex: '0'})]
  }, [target, other])
  const result = calculate(prepared)
  t.true(result.canSubmit)
  t.deepEqual(values(result), ['260', '90', '360', '90'])
  t.true(prepared.targets.every(item => item.meters.length === 0))
})

test('après identification du nouveau compteur, les relevés et événements null sont refusés', t => {
  const {prepared} = fixture()
  const lateReading = calculate({...prepared, draft: {...prepared.draft, readings: [...prepared.draft.readings, reading(dates[1], '1')]}})
  t.false(lateReading.canSubmit)
  for (const event of [reset({at: '2026-03-01'}), replacement({at: '2026-03-01', nextMeter: {serialNumber: 'AUTRE'}})]) {
    const extended = prepare({...prepared.draft, meterEvents: [...prepared.draft.meterEvents, event]}, prepared.targets)
    t.false(calculate(extended).canSubmit)
  }
})

test('la date de remplacement admet encore la borne ancienne null, pas une date postérieure', t => {
  const {prepared} = fixture(replacement({at: dates[1], previousIndex: '250', nextIndex: '10'}))
  prepared.draft.readings.push(reading(dates[1], '250'))
  const result = calculate(prepared)
  t.true(result.canSubmit)
  t.deepEqual(values(result), ['150', '290'])
  const later = calculate({...prepared, draft: {...prepared.draft, readings: [...prepared.draft.readings, reading(dates[2], '350')]}})
  t.false(later.canSubmit)
})

test('une identification future ne publie pas une transition sans événement explicite', t => {
  const known = {...target, meters: [{compteurId: 'known', startDate: '2026-02-01'}]}
  const prepared = prepare({readings: [reading(dates[0], '100'), reading(dates[1], '210', 'known'), reading(dates[2], '300', 'known')]}, [known])
  t.false(calculate(prepared).canSubmit)
})

test('les changements non référencés invalides ou hors dates restent bloquants', t => {
  for (const event of [
    reset({reason: ''}),
    reset({previousIndex: '-1'}),
    reset({nextIndex: '0.12345'}),
    reset({at: '2025-12-31'}),
    reset({at: '2026-07-02'}),
    reset({at: '2026-02-30'}),
    reset({nextCompteurId: 'foreign'}),
    replacement({nextCompteurId: null, nextMeter: undefined})
  ]) {
    t.false(calculate(prepare({readings: defaultReadings(), meterEvents: [event]})).canSubmit)
  }

  t.false(calculate(prepare({readings: defaultReadings(), meterEvents: [reset(), reset()]})).canSubmit)
})

test('l’ancien indicateur de continuité ne bloque pas une phase sans compteur et n’est pas coché artificiellement', t => {
  const unconfirmed = defaultReadings().map(item => ({...item, meterConfirmed: false}))
  const result = calculate(prepare({readings: unconfirmed, meterEvents: [reset()]}))
  t.true(result.canSubmit)
  t.true(result.resolvedReadings.every(reading => reading.meterConfirmed === false))
})

test('les relevés officiels repris sont stables lors du commentaire et restent contrôlés par point et préleveur', t => {
  const {prepared} = fixture()
  const persisted = asPersisted(prepared)
  const updatedAt = '2026-09-10T10:00:00.000Z'
  const existingReadings = persisted.draft.readings.map((item, index) => ({
    id: `source-${index}`, value: item.value, readingDate: item.readingDate,
    metricTypeCode: 'index', valueKind: 'DECLARED', updatedAt,
    chunk: {pointPrelevementId: target.pointPrelevementId, preleveurUserId: target.preleveurUserId, compteurId: item.compteurId, instructionStatus: 'VALIDATED', source: {status: 'COMPLETED'}}
  }))
  const replay = prepare({
    ...persisted.draft, comment: 'Nouveau commentaire',
    readings: persisted.draft.readings.map((item, index) => ({...item, sourceChunkValueId: `source-${index}`, sourceValueUpdatedAt: updatedAt}))
  }, persisted.targets)
  const result = calculate(replay, {existingReadings})
  t.true(result.canSubmit)
  t.deepEqual(values(result), ['250', '90'])
  for (const extra of [{preleveurUserId: 'foreign'}, {pointPrelevementId: 'foreign'}, {compteurId: 'foreign'}]) {
    const foreign = existingReadings.map((item, index) => index === 0 ? {...item, chunk: {...item.chunk, ...extra}} : item)
    t.false(calculate(replay, {existingReadings: foreign}).canSubmit)
  }

  t.false(calculate(replay, {existingReadings: existingReadings.map(item => ({...item, updatedAt: '2026-09-11T10:00:00.000Z'}))}).canSubmit)
})

test('un événement sans compteur ne permet ni point étranger ni remplacement sans accès', t => {
  const error = t.throws(() => prepare({meterEvents: [replacement({targetId: 'outside'})]}))
  t.is(error.statusCode, 403)
  t.false(calculate(prepare({readings: defaultReadings(), meterEvents: [reset({targetId: 'outside'})]})).canSubmit)
})

test('les compteurs connus gardent leur calcul et leur identité lors d’un remplacement', t => {
  const known = {...target, meters: [{compteurId: 'known', compteur: {id: 'known'}}]}
  const prepared = prepare({meterEvents: [replacement({previousCompteurId: 'known'})]}, [known])
  const {nextCompteurId} = prepared.draft.meterEvents[0]
  prepared.draft.readings = [reading(dates[0], '100', 'known'), reading(dates[1], '210', nextCompteurId), reading(dates[2], '300', nextCompteurId)]
  const result = calculate(prepared)
  t.true(result.canSubmit)
  t.deepEqual(values(result), ['250', '90'])
  t.false(result.totals.flatMap(total => total.segments).some(segment => segment.compteurId === null))
  t.false(prepared.targets[0].meterlessInitial)
  t.is(known.meters.length, 1)
})
