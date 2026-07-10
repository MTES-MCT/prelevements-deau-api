import test from 'ava'

import {
  aggregateGroundwaterValuesByUTCWeek,
  periodBounds,
  selectGroundwaterRows
} from '../dashboard-water-resources.js'

function row(kind, date) {
  return {
    kind,
    measuredAt: new Date(`${date}T12:00:00.000Z`),
    measurementDate: new Date(`${date}T00:00:00.000Z`)
  }
}

test('les périodes du tableau de bord sont glissantes', t => {
  const now = new Date('2026-07-10T14:30:00.000Z')

  t.is(periodBounds('week', now).start.toISOString(), '2026-07-03T14:30:00.000Z')
  t.is(periodBounds('month', now).start.toISOString(), '2026-06-10T14:30:00.000Z')
  t.is(periodBounds('year', now).start.toISOString(), '2025-07-10T14:30:00.000Z')
  t.is(periodBounds('twenty-years', now).start.toISOString(), '2006-07-10T14:30:00.000Z')
})

test('les agrégats de débit couvrent les dernières périodes complètes', t => {
  const now = new Date('2026-07-10T14:30:00.000Z')
  const month = periodBounds('month', now, 'FLOW_STATION')
  const year = periodBounds('year', now, 'FLOW_STATION')

  t.is(month.start.toISOString(), '2026-06-10T00:00:00.000Z')
  t.is(month.end.toISOString(), '2026-07-10T00:00:00.000Z')
  t.is(year.start.toISOString(), '2025-07-01T00:00:00.000Z')
  t.is(year.end.toISOString(), '2026-07-01T00:00:00.000Z')
})

test('la vue 30 jours complète les chroniques avec le temps réel récent', t => {
  const chronicle = row('CHRONICLE', '2026-07-01')
  const overlappingRealtime = row('REALTIME', '2026-07-01')
  const recentRealtime = row('REALTIME', '2026-07-02')

  const selected = selectGroundwaterRows([
    recentRealtime,
    overlappingRealtime,
    chronicle
  ], 'month')

  t.deepEqual(selected, [chronicle, recentRealtime])
})

test('la vue 30 jours utilise le temps réel si aucune chronique n’est disponible', t => {
  const realtime = row('REALTIME', '2026-07-02')

  t.deepEqual(selectGroundwaterRows([realtime], 'month'), [realtime])
})

test('la vue semaine privilégie le temps réel et retombe sur la chronique', t => {
  const chronicle = row('CHRONICLE', '2026-07-01')
  const realtime = row('REALTIME', '2026-07-02')

  t.deepEqual(selectGroundwaterRows([chronicle, realtime], 'week'), [realtime])
  t.deepEqual(selectGroundwaterRows([chronicle], 'week'), [chronicle])
})

test('l’historique piézométrique calcule une moyenne hebdomadaire par valeur disponible', t => {
  const values = aggregateGroundwaterValuesByUTCWeek([
    {
      at: new Date('2026-07-07T08:00:00.000Z'),
      levelNgf: 120,
      depth: null
    },
    {
      at: new Date('2026-07-12T18:00:00.000Z'),
      levelNgf: 124,
      depth: 7
    },
    {
      at: new Date('2026-07-13T08:00:00.000Z'),
      levelNgf: 118,
      depth: 9
    }
  ])

  t.is(values.length, 2)
  t.deepEqual(values[0], {
    at: new Date('2026-07-06T00:00:00.000Z'),
    levelNgf: 122,
    depth: 7,
    origin: 'CHRONICLE',
    aggregation: 'WEEKLY_MEAN'
  })
  t.is(values[1].at.toISOString(), '2026-07-13T00:00:00.000Z')
})

test('les semaines sont alignées entre piézomètres, quelle que soit l’heure de mesure', t => {
  const firstStation = aggregateGroundwaterValuesByUTCWeek([
    {at: new Date('2026-07-08T06:00:00.000Z'), levelNgf: 100, depth: 5}
  ])
  const secondStation = aggregateGroundwaterValuesByUTCWeek([
    {at: new Date('2026-07-10T19:30:00.000Z'), levelNgf: 80, depth: 12}
  ])

  t.is(firstStation[0].at.getTime(), secondStation[0].at.getTime())
  t.is(firstStation[0].at.toISOString(), '2026-07-06T00:00:00.000Z')
})
