import test from 'ava'
import {calculateCampaignIndexTotals, campaignDate, campaignPeriodBounds, loadCampaignExistingReadings} from '../campaign-index.js'

const dates = ['2025-10-31', '2026-06-01', '2026-10-31']
const periods = [
  {id: 'winter', kind: 'INDEX', position: 0, startDate: '2025-11-01', endDate: '2026-06-01', startReadingDate: dates[0], endReadingDate: dates[1]},
  {id: 'summer', kind: 'INDEX', position: 1, startDate: '2026-06-01', endDate: '2026-11-01', startReadingDate: dates[1], endReadingDate: dates[2]}
]
const target = {id: 'target', pointPrelevementId: 'point', preleveurUserId: 'user', meters: [{compteurId: 'meter'}]}
const readings = [100, 210, 300].map((value, index) => ({targetId: target.id, compteurId: 'meter', readingDate: dates[index], value: String(value)}))
const calculate = overrides => calculateCampaignIndexTotals({periods, targets: [target], readings, ...overrides})

function existingReading(overrides = {}) {
  return {
    id: 'old-reading', metricTypeCode: 'index', valueKind: 'DECLARED', value: '100', updatedAt: new Date('2026-01-01'),
    periodStart: new Date('2025-10-31'),
    chunk: {pointPrelevementId: 'point', preleveurUserId: 'user', compteurId: 'meter', instructionStatus: 'VALIDATED', source: {status: 'COMPLETED'}},
    ...overrides
  }
}

test('bornes civiles strictes et fin métier exclusive', t => {
  t.is(campaignDate('2024-02-29'), '2024-02-29')
  t.throws(() => campaignDate('2025-02-29'))
  t.throws(() => campaignDate('2026-01-01T12:00:00Z'))
  t.deepEqual(campaignPeriodBounds(periods[0]), {periodStart: new Date('2025-11-01'), periodEnd: new Date('2026-06-01')})
  t.throws(() => campaignPeriodBounds({startDate: '2026-01-01', endDate: '2026-01-01'}))
})

test('saisons exactes indépendantes des dates de relevé, sans prorata', t => {
  const result = calculate()
  t.true(result.canSubmit)
  t.deepEqual(result.totals.map(total => total.value), ['110', '90'])
  t.is(result.totals[0].periodStart.toISOString(), '2025-11-01T00:00:00.000Z')
  t.is(result.totals[0].segments[0].from, '2025-10-31')
})

test('plusieurs compteurs sont calculés séparément puis sommés exactement', t => {
  const second = readings.map(reading => ({...reading, compteurId: 'meter2', value: String(Number(reading.value) / 10)}))
  const result = calculate({targets: [{...target, meters: [...target.meters, {compteurId: 'meter2'}]}], readings: [...readings, ...second]})
  t.deepEqual(result.totals.map(total => total.value), ['121', '99'])
  t.is(result.totals[0].segments.length, 2)
})

test('sans inventaire, le calcul par point ne demande ni ne fabrique une confirmation de continuité', t => {
  const targets = [{...target, meters: []}]
  const meterlessReadings = readings.map(reading => ({...reading, compteurId: null}))
  const unconfirmed = calculate({targets, readings: meterlessReadings})
  t.true(unconfirmed.canSubmit)
  t.deepEqual(unconfirmed.totals.map(total => total.value), ['110', '90'])
  t.true(unconfirmed.resolvedReadings.every(reading => reading.compteurId === null && !Object.hasOwn(reading, 'meterConfirmed')))
  t.true(calculate({targets, readings: meterlessReadings.map(reading => ({...reading, meterConfirmed: false}))}).canSubmit)
  const confirmed = calculate({targets, readings: meterlessReadings.map(reading => ({...reading, meterConfirmed: true}))})
  t.true(confirmed.canSubmit)
  t.deepEqual(confirmed.totals.map(total => total.value), ['110', '90'])
  t.true(confirmed.resolvedReadings.every(reading => reading.compteurId === null && reading.meterConfirmed === true))
  t.deepEqual(targets[0].meters, [])
  t.false(calculate({readings: confirmed.resolvedReadings}).canSubmit)
  t.false(calculate({targets, readings}).canSubmit)
})

test('sans inventaire, une absence justifiée ne demande pas de confirmation et ne vaut jamais zéro', t => {
  const result = calculate({targets: [{...target, meters: []}], readings: readings.map(reading => ({...reading, compteurId: null, value: null, missingReason: 'Relevé impossible'}))})
  t.true(result.canSubmit)
  t.true(result.totals.every(total => total.status === 'MISSING' && total.value === null))
  t.false(calculate({targets: [{...target, meters: []}], readings: []}).canSubmit)
})

test('les relevés sans inventaire restent séparés par point et une baisse reste bloquée', t => {
  const meterless = readings.map(reading => ({...reading, compteurId: null, meterConfirmed: true}))
  const targets = [{...target, meters: []}, {...target, id: 'other-target', pointPrelevementId: 'other-point', meters: []}]
  const result = calculate({targets, readings: [...meterless, ...meterless.map(reading => ({...reading, targetId: 'other-target', value: String(Number(reading.value) * 2)}))]})
  t.true(result.canSubmit)
  t.deepEqual(result.totals.map(total => total.value), ['110', '90', '220', '180'])
  t.false(calculate({targets: targets.slice(0, 1), readings: [{...meterless[0], value: '250'}, ...meterless.slice(1)]}).canSubmit)
})

test('historique sans compteur : reprise explicite de la source, sans confirmation d’une identité fictive', t => {
  const targets = [{...target, meters: []}]
  const meterless = readings.map(reading => ({...reading, compteurId: null}))
  const old = existingReading()
  old.chunk.compteurId = null
  const unreferenced = calculate({targets, readings: meterless, existingReadings: [old]})
  t.false(unreferenced.canSubmit)
  t.true(unreferenced.issues.some(issue => issue.code === 'EXISTING_READING_REFERENCE_REQUIRED'))
  const referenced = [{...meterless[0], sourceChunkValueId: old.id, sourceValueUpdatedAt: old.updatedAt}, ...meterless.slice(1)]
  t.true(calculate({targets, readings: referenced, existingReadings: [old]}).canSubmit)
  t.true(calculate({targets, readings: [{...referenced[0], meterConfirmed: false}, ...referenced.slice(1)], existingReadings: [old]}).canSubmit)
  t.false(calculate({targets, readings: [{...referenced[0], value: '101'}, ...referenced.slice(1)], existingReadings: [old]}).canSubmit)
  t.false(calculate({targets, readings: [{...referenced[0], sourceValueUpdatedAt: '2025-01-01'}, ...referenced.slice(1)], existingReadings: [old]}).canSubmit)
  old.chunk.compteurId = 'known-meter'
  t.false(calculate({targets, readings: referenced, existingReadings: [old]}).canSubmit)
  t.false(calculate({targets, readings: meterless, existingReadings: [old]}).canSubmit)
})

test('décimales exactes sans arrondi binaire', t => {
  const result = calculate({readings: readings.map((reading, index) => ({...reading, value: ['0.1', '0.3', '0.6'][index]}))})
  t.deepEqual(result.totals.map(total => total.value), ['0.2', '0.3'])
})

test('absence justifiée autorise la transmission sans inventer zéro', t => {
  const result = calculate({readings: readings.map((reading, index) => index === 0 ? {...reading, value: null, missingReason: 'Compteur illisible'} : reading)})
  t.true(result.canSubmit)
  t.is(result.totals[0].status, 'MISSING')
  t.is(result.totals[0].value, null)
  t.is(result.totals[1].value, '90')
})

test('borne partagée absente reste inconnue pour les deux saisons', t => {
  const result = calculate({readings: readings.map((reading, index) => index === 1 ? {...reading, value: null, missingReason: 'Accès impossible'} : reading)})
  t.true(result.canSubmit)
  t.deepEqual(result.totals.map(total => total.value), [null, null])
})

test('absence non justifiée, index négatif ou trop précis et doublons sont refusés', t => {
  for (const value of [null, '-1', '1.12345', 'NaN', 'Infinity']) {
    t.false(calculate({readings: [{...readings[0], value}, ...readings.slice(1)]}).canSubmit)
  }

  t.false(calculate({readings: [...readings, readings[0]]}).canSubmit)
})

test('baisse d’index ne devient jamais un reset automatique', t => {
  const result = calculate({readings: [{...readings[0], value: '250'}, ...readings.slice(1)]})
  t.false(result.canSubmit)
  t.true(result.totals[0].conflicts.some(conflict => conflict.code === 'NEGATIVE_DELTA_REQUIRES_EVENT'))
})

test('reset guidé calcule les deux segments et exige un motif', t => {
  const event = {targetId: target.id, type: 'RESET', at: '2026-01-01', previousCompteurId: 'meter', previousIndex: '150', nextIndex: '0', reason: 'Remise à zéro'}
  const result = calculate({meterEvents: [event]})
  t.true(result.canSubmit)
  t.is(result.totals[0].value, '260')
  t.is(result.totals[0].segments.length, 2)
  t.false(calculate({meterEvents: [{...event, reason: ''}]}).canSubmit)
})

test('reset à la borne commune distingue index avant et après', t => {
  const result = calculate({meterEvents: [{targetId: target.id, type: 'RESET', at: dates[1], previousCompteurId: 'meter', previousIndex: '250', nextIndex: '10', reason: 'Intervention'}]})
  t.true(result.canSubmit)
  t.deepEqual(result.totals.map(total => total.value), ['150', '290'])
})

test('transition avec index manquant justifié transmet une inconnue, jamais zéro ou autre relevé', t => {
  const result = calculate({meterEvents: [{targetId: target.id, type: 'RESET', at: dates[1], previousCompteurId: 'meter', previousIndex: null, nextIndex: '10', reason: 'Ancien index illisible'}]})
  t.true(result.canSubmit)
  t.is(result.totals[0].status, 'MISSING')
  t.is(result.totals[0].value, null)
  t.is(result.totals[0].missing[0].reason, 'Ancien index illisible')
  t.is(result.totals[1].value, '290')
})

test('remplacement guidé utilise les deux compteurs sans soustraire leurs index', t => {
  const result = calculate({
    targets: [{...target, meters: [{compteurId: 'meter', endDate: '2026-01-01'}, {compteurId: 'new-meter', startDate: '2026-01-01'}]}],
    readings: readings.map((reading, index) => index ? {...reading, compteurId: 'new-meter'} : reading),
    meterEvents: [{targetId: target.id, type: 'REPLACEMENT', at: '2026-01-01', previousCompteurId: 'meter', nextCompteurId: 'new-meter', previousIndex: '150', nextIndex: '10', reason: 'Compteur remplacé'}]
  })
  t.true(result.canSubmit)
  t.deepEqual(result.totals.map(total => total.value), ['250', '90'])
})

test('changement de compteur non documenté bloque la publication', t => {
  const result = calculate({targets: [{...target, meters: [{compteurId: 'meter', endDate: '2026-01-01'}]}]})
  t.false(result.canSubmit)
  t.true(result.totals[0].conflicts.some(conflict => conflict.code === 'METER_TRANSITION_REQUIRED'))
})

test('double association du même compteur exige de résoudre l’historique ambigu', t => {
  const result = calculate({targets: [{...target, meters: [{compteurId: 'meter'}, {compteurId: 'meter'}]}]})
  t.false(result.canSubmit)
  t.true(result.issues.some(problem => problem.code === 'AMBIGUOUS_METER_BINDING'))
})

test('référence historique inchangée est réutilisée avec sa version', t => {
  const old = existingReading()
  const referenced = {...readings[0], sourceChunkValueId: old.id, sourceValueUpdatedAt: old.updatedAt}
  t.true(calculate({readings: [referenced, ...readings.slice(1)], existingReadings: [old]}).canSubmit)
  const reused = calculate({readings, existingReadings: [old]})
  t.true(reused.canSubmit)
  t.is(reused.resolvedReadings[0].sourceChunkValueId, old.id)
  t.false(calculate({readings: [{...referenced, sourceValueUpdatedAt: '2025-01-01'}, ...readings.slice(1)], existingReadings: [old]}).canSubmit)
})

test('référence sans compteur nécessite confirmation explicite et ne permet pas de changer la valeur', t => {
  const old = existingReading()
  old.chunk.compteurId = null
  const referenced = {...readings[0], sourceChunkValueId: old.id, sourceValueUpdatedAt: old.updatedAt}
  t.false(calculate({readings: [referenced, ...readings.slice(1)], existingReadings: [old]}).canSubmit)
  t.true(calculate({readings: [{...referenced, meterConfirmed: true}, ...readings.slice(1)], existingReadings: [old]}).canSubmit)
  t.false(calculate({readings: [{...referenced, meterConfirmed: true, value: '101'}, ...readings.slice(1)], existingReadings: [old]}).canSubmit)
})

test('correction explicite conserve la référence précédente et exige un motif', t => {
  const old = existingReading()
  const corrected = {...readings[0], correctionOfChunkValueId: old.id, sourceValueUpdatedAt: old.updatedAt, correctionReason: 'Erreur de transcription', value: '101'}
  const result = calculate({readings: [corrected, ...readings.slice(1)], existingReadings: [old]})
  t.true(result.canSubmit)
  t.is(result.totals[0].value, '109')
  t.false(calculate({readings: [{...corrected, correctionReason: ''}, ...readings.slice(1)], existingReadings: [old]}).canSubmit)
})

test('référence étrangère au point ou au préleveur rejetée', t => {
  const old = existingReading()
  old.chunk.preleveurUserId = 'other-user'
  const referenced = {...readings[0], sourceChunkValueId: old.id, sourceValueUpdatedAt: old.updatedAt}
  t.false(calculate({readings: [referenced, ...readings.slice(1)], existingReadings: [old]}).canSubmit)
})

test('saisie hors cible ou hors dates de campagne rejetée', t => {
  t.false(calculate({readings: [...readings, {...readings[0], targetId: 'other'}]}).canSubmit)
  t.false(calculate({readings: [...readings, {...readings[0], readingDate: '2025-10-30'}]}).canSubmit)
})

test('lecture historique limitée au scope autorisé, aux index déclarés et aux dates exactes', async t => {
  let query
  const values = await loadCampaignExistingReadings({campaign: {periods}, targets: [target], client: {chunkValue: {async findMany(options) {
    query = options
    return [existingReading()]
  }}}})
  t.is(query.where.valueKind, 'DECLARED')
  t.deepEqual(query.where.chunk.OR, [{pointPrelevementId: target.pointPrelevementId, preleveurUserId: target.preleveurUserId}])
  t.is(query.where.chunk.source.status, 'COMPLETED')
  t.is(query.where.OR[0].readingDate.in.length, 3)
  t.is(values[0].sourceChunkValueId, 'old-reading')
})
