import test from 'ava'
import {calculateCampaignIndexTotals} from '../campaign-index.js'

const dates = ['2026-01-01', '2026-04-01', '2026-07-01']
const periods = dates.slice(0, -1).map((start, position) => ({
  id: `period-${position}`, kind: 'INDEX', position,
  startDate: start, endDate: dates[position + 1], startReadingDate: start, endReadingDate: dates[position + 1]
}))
const campaign = {indexDates: dates, periods}
const target = {id: 'target', pointPrelevementId: 'point', preleveurUserId: 'user', meters: [{compteurId: 'old', startDate: '2020-01-01'}]}
const readings = dates.map((readingDate, index) => ({targetId: target.id, compteurId: 'old', readingDate, value: String(index * 50)}))
const calculate = overrides => calculateCampaignIndexTotals({campaign, targets: [target], readings, ...overrides})

function replacementFixture() {
  const event = {targetId: target.id, type: 'REPLACEMENT', at: '2026-03-01', previousCompteurId: 'old', nextCompteurId: 'new', previousIndex: '30', nextIndex: '0', reason: 'Compteur remplacé'}
  return {
    targets: [{...target, meters: [...target.meters, {compteurId: 'new', startDate: event.at}]}],
    readings: [readings[0], ...readings.slice(1).map(reading => ({...reading, compteurId: 'new'})), ...readings.slice(1)],
    meterEvents: [event]
  }
}

test('les index saisis avant de déclarer un remplacement restent conservés mais ne sont plus résolus', t => {
  const input = replacementFixture()
  const original = structuredClone(input)
  const result = calculate(input)
  t.true(result.canSubmit)
  t.deepEqual(result.totals.map(total => total.value), ['80', '50'])
  t.deepEqual(result.ignoredReadings, readings.slice(1).map(reading => ({...reading, code: 'READING_OUTSIDE_METER_PERIOD'})))
  t.deepEqual(result.resolvedReadings.map(reading => [reading.compteurId, reading.readingDate]), [['old', dates[0]], ['new', dates[1]], ['new', dates[2]]])
  t.deepEqual(input, original)
  const restored = calculate({readings: input.readings.filter(reading => reading.compteurId === 'old')})
  t.true(restored.canSubmit)
  t.deepEqual(restored.totals.map(total => total.value), ['50', '50'])
  t.deepEqual(restored.ignoredReadings, [])
})

test('une ancienne référence ou correction hors phase ne bloque pas et n’est jamais résolue', t => {
  for (const reference of [
    {sourceChunkValueId: 'stale-source', sourceValueUpdatedAt: '2020-01-01'},
    {correctionOfChunkValueId: 'old-source', sourceValueUpdatedAt: '2020-01-01', correctionReason: 'Correction saisie avant le remplacement'}
  ]) {
    const input = replacementFixture()
    const inactive = {...input.readings.at(-1), ...reference}
    input.readings[input.readings.length - 1] = inactive
    const result = calculate(input)
    t.true(result.canSubmit)
    t.deepEqual(result.ignoredReadings.at(-1), {...inactive, code: 'READING_OUTSIDE_METER_PERIOD'})
    t.false(result.resolvedReadings.some(reading => reading.sourceChunkValueId || reading.correctionOfChunkValueId))
    const reactivated = calculate({readings: [readings[0], readings[1], inactive]})
    t.false(reactivated.canSubmit)
    t.true(reactivated.issues.some(issue => issue.code === 'STALE_SOURCE_READING'))
  }
})

test('une lecture hors phase ne contourne ni les dates de campagne ni le périmètre', t => {
  const input = replacementFixture()
  for (const extra of [
    {...readings[2], readingDate: '2026-06-30'},
    {...readings[2], targetId: 'other-target'},
    {...readings[2], compteurId: 'other-meter'},
    {...readings[2], readingDate: 'date-invalide'}
  ]) {
    t.false(calculate({...input, readings: [...input.readings, extra]}).canSubmit)
  }
})

test('une borne de remplacement reste utilisable des deux côtés, avec zéro et quatre décimales', t => {
  const input = replacementFixture()
  input.meterEvents[0] = {...input.meterEvents[0], at: dates[1], previousIndex: '0.0001', nextIndex: '0'}
  input.targets[0].meters[1].startDate = dates[1]
  input.readings = [readings[0], {...readings[1], value: '0.0001'}, {...readings[1], compteurId: 'new', value: '0'}, {...readings[2], compteurId: 'new', value: '0.0002'}]
  const result = calculate(input)
  t.true(result.canSubmit)
  t.deepEqual(result.totals.map(total => total.value), ['0.0001', '0.0002'])
  t.is(result.resolvedReadings.length, 4)
  t.deepEqual(result.ignoredReadings, [])
})

test('deux affectations disjointes ne rendent pas ambiguë une période couverte par une seule', t => {
  const meters = [
    {associationId: 'first', compteurId: 'old', startDate: '2020-01-01', endDate: dates[1]},
    {associationId: 'second', compteurId: 'old', startDate: '2026-04-02'}
  ]
  const result = calculate({targets: [{...target, meters}]})
  t.is(result.totals[0].status, 'COMPLETE')
  t.is(result.totals[0].value, '50')
  t.false(result.issues.some(issue => issue.code === 'AMBIGUOUS_METER_BINDING'))
  t.true(result.totals[1].conflicts.some(issue => issue.code === 'METER_TRANSITION_REQUIRED'))
  t.is(result.totals[1].value, null)
})

test('les affectations successives du même compteur à borne partagée comptent chaque période une seule fois', t => {
  const meters = [
    {associationId: 'second', compteurId: 'old', startDate: dates[1]},
    {associationId: 'first', compteurId: 'old', startDate: '2020-01-01', endDate: dates[1]}
  ]
  const result = calculate({targets: [{...target, meters}]})
  t.true(result.canSubmit)
  t.deepEqual(result.totals.map(total => total.value), ['50', '50'])
  t.true(result.totals.every(total => total.segments.length === 1))
  const merged = calculate({campaign: {...campaign, periods: [{...periods[0], endDate: dates[2], endReadingDate: dates[2]}]}, targets: [{...target, meters}], readings: [readings[0], readings[2]]})
  t.true(merged.canSubmit)
  t.is(merged.totals[0].value, '100')
})

test('les affectations réellement superposées restent ambiguës seulement sur les périodes concernées', t => {
  const meters = [
    {associationId: 'first', compteurId: 'old', startDate: '2020-01-01', endDate: dates[1]},
    {associationId: 'second', compteurId: 'old', startDate: '2026-03-01'}
  ]
  const result = calculate({targets: [{...target, meters}]})
  t.false(result.canSubmit)
  t.true(result.totals[0].conflicts.some(issue => issue.code === 'AMBIGUOUS_METER_BINDING'))
  t.is(result.totals[0].value, null)
  t.is(result.totals[1].status, 'COMPLETE')
  t.is(result.totals[1].value, '50')
})

test('les dates des affectations restent strictes et ne deviennent pas des lectures ignorées silencieusement', t => {
  const result = calculate({targets: [{...target, meters: [{compteurId: 'old', startDate: '2026-02-30'}]}]})
  t.false(result.canSubmit)
  t.true(result.issues.some(issue => issue.code === 'INVALID_PERIOD_OR_METER_DATE'))
})
