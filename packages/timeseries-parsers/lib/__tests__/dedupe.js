import test from 'ava'
import {dedupe} from '../dedupe.js'

// Série journalière avec doublons

test('dedupe - supprime doublons journaliers et ajoute warning', t => {
  const result = {
    data: {
      series: [
        {
          pointPrelevement: 1,
          parameter: 'volume prélevé',
          unit: 'm³',
          frequency: '1 day',
          valueType: 'cumulative',
          minDate: '2025-01-01',
          maxDate: '2025-01-02',
          data: [
            {date: '2025-01-01', value: 10},
            {date: '2025-01-02', value: 20},
            {date: '2025-01-02', value: 30} // Doublon
          ]
        }
      ]
    },
    errors: []
  }

  const out = dedupe(result)
  testDedupeAssertions(t, out, {pointPrelevement: 1, dates: ['2025-01-01', '2025-01-02'], values: [10, 20]})
})

// Série sub-daily avec doublon date+time

test('dedupe - supprime doublons sub-daily et ajoute warning', t => {
  const result = {
    data: {
      series: [
        {
          pointPrelevement: 2,
          parameter: 'volume prélevé',
          unit: 'm³',
          frequency: '15 minutes',
          valueType: 'cumulative',
          minDate: '2025-01-01',
          maxDate: '2025-01-01',
          data: [
            {date: '2025-01-01', time: '00:00', value: 5},
            {date: '2025-01-01', time: '00:15', value: 6},
            {date: '2025-01-01', time: '00:15', value: 7} // Doublon
          ]
        }
      ]
    },
    errors: []
  }

  const out = dedupe(result)
  testDedupeAssertions(t, out, {pointPrelevement: 2, dates: ['2025-01-01', '2025-01-01'], values: [5, 6], times: ['00:00', '00:15']})
})

function testDedupeAssertions(t, out, {pointPrelevement, dates, values, times}) {
  const warning = out.errors.find(e => e.severity === 'warning')
  t.truthy(warning)
  t.true(warning.message.includes('doublons'))

  const s = out.data.series.find(s => s.pointPrelevement === pointPrelevement)
  t.is(s.data.length, dates.length)
  t.deepEqual(s.data.map(d => d.date), dates)
  t.deepEqual(s.data.map(d => d.value), values)
  if (times) {
    t.deepEqual(s.data.map(d => d.time), times)
  }
}
