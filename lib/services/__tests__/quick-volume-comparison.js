import test from 'ava'
import {compareQuickVolumes} from '../quick-declaration-impact.js'

const row = (direct, start, end, volume, series = {}) => ({
  pointPrelevementId: 'point', pointName: 'Prise', exploitationId: 'comptage', compteurId: null,
  periodStart: new Date(start + 'Z'), periodEnd: new Date(end + 'Z'), direct, volume, ...series
})
const at = day => '2026-03-0' + day + 'T00:00:00'
const short = changes => changes.map(x => [x.periodEndDate, x.before, x.after, x.beforeKind, x.afterKind])

test('les bornes de chaque provenance restent visibles quand les instants stockés sont identiques', t => {
  const calculated = row(false, at(1), at(6), 40)
  const direct = row(true, at(1), at(6), 40)
  t.deepEqual(short(compareQuickVolumes([calculated], [direct])), [
    ['2026-03-05', null, 40, null, 'DECLARED'], ['2026-03-06', 40, null, 'COMPUTED', null]
  ])
  t.deepEqual(short(compareQuickVolumes([direct], [calculated])), [
    ['2026-03-05', 40, null, 'DECLARED', null], ['2026-03-06', null, 40, null, 'COMPUTED']
  ])
})

test('une conversion sur les mêmes dates affichées conserve le changement d’origine à zéro', t => {
  const calculated = row(false, at(1), at(6), 0)
  const direct = row(true, at(1), at(7), 0)
  t.deepEqual(short(compareQuickVolumes([calculated], [direct])), [['2026-03-06', 0, 0, 'COMPUTED', 'DECLARED']])
  t.deepEqual(short(compareQuickVolumes([direct], [calculated])), [['2026-03-06', 0, 0, 'DECLARED', 'COMPUTED']])
})

test('les totaux décimaux de plusieurs lignes s’additionnent et la répartition d’un total mixte est conservée', t => {
  const direct = amount => row(true, at(1), at(7), amount)
  const computed = amount => row(false, at(1), at(6), amount)
  t.deepEqual(compareQuickVolumes([direct('0.1'), direct('0.2')], [direct('0.3')]), [])
  const [change] = compareQuickVolumes([direct('0.1'), computed('0.2')], [direct('0.2'), computed('0.1')])
  t.deepEqual([change.before, change.after, change.beforeKind, change.afterKind], [0.3, 0.3, 'MIXED', 'MIXED'])
  t.deepEqual(change.beforeBreakdown, {declared: 0.1, computed: 0.2})
  t.deepEqual(change.afterBreakdown, {declared: 0.2, computed: 0.1})
})

test('une égalité de dates et de volume ne rapproche jamais deux points, comptages ou compteurs', t => {
  const calculated = row(false, at(1), at(6), 42)
  for (const series of [{exploitationId: 'autre'}, {pointPrelevementId: 'autre'}, {compteurId: 'physique'}]) {
    const direct = row(true, at(1), at(7), 42, series)
    const changes = compareQuickVolumes([calculated], [direct])
    t.is(changes.length, 2)
    t.true(changes.some(x => x.before === 42 && x.after === null))
    t.true(changes.some(x => x.before === null && x.after === 42))
  }
})
