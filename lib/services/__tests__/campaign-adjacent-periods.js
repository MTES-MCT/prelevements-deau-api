import test from 'ava'
import {validateCampaignConfig} from '../../validation/campaigns.js'
import {calculateCampaignIndexTotals} from '../campaign-index.js'
import {planCampaignVolumePublication} from '../campaign-publication.js'

const dates = ['2026-01-01', '2026-06-01', '2027-01-01']
const uuid = number => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const target = {id: 'target', pointPrelevementId: 'point', preleveurUserId: 'user', meters: [{compteurId: 'meter'}]}
const need = {id: uuid(50), kind: 'NEEDS', position: 0, label: 'Année à venir', startDate: '2027-01-01', endDate: '2028-01-01'}

function config(indexDates = dates) {
  return {
    name: 'Collecte annuelle', year: 2026, ownerCollecteurUserId: uuid(10), zoneId: uuid(11), targets: [], indexDates,
    periods: [
      ...indexDates.slice(0, -1).map((startDate, position) => ({
        id: uuid(position + 1), kind: 'INDEX', position, label: `Période ${position + 1}`,
        startDate, endDate: indexDates[position + 1], startReadingDate: startDate, endReadingDate: indexDates[position + 1]
      })),
      {...need}
    ]
  }
}

const readings = dates.map((readingDate, index) => ({targetId: target.id, compteurId: 'meter', readingDate, value: ['0', '100', '300'][index]}))
const calculate = overrides => calculateCampaignIndexTotals({campaign: validateCampaignConfig(config(), {create: true}), targets: [target], readings, ...overrides})

test('le calendrier déduit des dates de relevé est accepté sans changer les besoins', t => {
  const campaign = validateCampaignConfig(config(), {create: true})
  t.is(campaign.periods.filter(period => period.kind === 'INDEX').length, dates.length - 1)
  t.deepEqual(campaign.periods.find(period => period.kind === 'NEEDS'), need)
  for (const period of campaign.periods.filter(period => period.kind === 'INDEX')) {
    t.is(period.startDate, period.startReadingDate)
    t.is(period.endDate, period.endReadingDate)
  }

  const minimum = validateCampaignConfig(config(dates.slice(0, 2)), {create: true})
  t.is(minimum.periods.filter(period => period.kind === 'INDEX').length, 1)
})

test('les périodes déduites exigent au moins deux dates civiles distinctes et ordonnées', t => {
  for (const invalid of [[], [dates[0]], [dates[0], dates[0]], [dates[1], dates[0]], [dates[0], dates[2], dates[1]], ['2026-02-30', dates[1]]]) {
    t.is(t.throws(() => validateCampaignConfig(config(invalid), {create: true})).statusCode, 400)
  }
})

test('les index 0, 100, 300 publient 100 puis 200 avec des bornes adjacentes sans jour supplémentaire', t => {
  const result = calculate()
  t.true(result.canSubmit)
  t.deepEqual(result.totals.map(total => total.value), ['100', '200'])
  t.deepEqual(result.totals.map(total => [total.periodStart.toISOString(), total.periodEnd.toISOString()]), [
    ['2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'],
    ['2026-06-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z']
  ])
  t.is(result.totals[0].periodEnd.getTime(), result.totals[1].periodStart.getTime())
  t.is(result.totals.reduce((sum, total) => sum + (total.periodEnd - total.periodStart), 0), 365 * 86_400_000)
  t.deepEqual(planCampaignVolumePublication({totals: result.totals, conflicts: []}).map(total => total.value), ['100', '200'])
  const withoutInventory = calculate({targets: [{...target, meters: []}], readings: readings.map(reading => ({...reading, compteurId: null, meterConfirmed: true}))})
  t.true(withoutInventory.canSubmit)
  t.deepEqual(withoutInventory.totals.map(total => total.value), ['100', '200'])
})

test('un volume le jour charnière ne chevauche que la période commençant ce jour', t => {
  const {totals} = calculate()
  const afterBoundary = {preleveurUserId: null, periodStart: new Date('2026-06-01'), periodEnd: new Date('2026-06-02')}
  const beforeBoundary = {preleveurUserId: null, periodStart: new Date('2026-05-31'), periodEnd: new Date('2026-06-01')}
  const after = planCampaignVolumePublication({totals, conflicts: [afterBoundary]})
  t.deepEqual(after.map(total => total.status), ['COMPLETE', 'CONFLICT'])
  t.is(after[0].value, '100')
  const before = planCampaignVolumePublication({totals, conflicts: [beforeBoundary]})
  t.deepEqual(before.map(total => total.status), ['CONFLICT', 'COMPLETE'])
  t.is(before[1].value, '200')
})

test('remplacement et remise à zéro à la date charnière gardent leurs deux index distincts', t => {
  const replacement = calculate({
    targets: [{...target, meters: [{compteurId: 'meter', endDate: dates[1]}, {compteurId: 'new-meter', startDate: dates[1]}]}],
    readings: readings.map((reading, index) => index ? {...reading, compteurId: 'new-meter', value: index === 1 ? '5' : '205'} : reading),
    meterEvents: [{targetId: target.id, type: 'REPLACEMENT', at: dates[1], previousCompteurId: 'meter', nextCompteurId: 'new-meter', previousIndex: '100', nextIndex: '5', reason: 'Remplacement'}]
  })
  t.true(replacement.canSubmit)
  t.deepEqual(replacement.totals.map(total => total.value), ['100', '200'])
  const reset = calculate({
    readings: readings.map((reading, index) => ({...reading, value: ['0', '0', '200'][index]})),
    meterEvents: [{targetId: target.id, type: 'RESET', at: dates[1], previousCompteurId: 'meter', previousIndex: '100', nextIndex: '0', reason: 'Remise à zéro'}]
  })
  t.true(reset.canSubmit)
  t.deepEqual(reset.totals.map(total => total.value), ['100', '200'])
})
