import test from 'ava'
import {collectorDate, collectorDay} from '../collector-calendar.js'

test('collector calendar uses the Paris day across UTC midnight and daylight saving time', t => {
  for (const [instant, expected] of [
    ['2026-11-04T22:59:59Z', '2026-11-04'],
    ['2026-11-04T23:00:00Z', '2026-11-05'],
    ['2026-07-04T22:00:00Z', '2026-07-05'],
    ['2026-03-29T00:30:00Z', '2026-03-29'],
    ['2026-10-25T01:30:00Z', '2026-10-25']
  ]) {
    t.is(collectorDate(new Date(instant)), expected)
    t.is(collectorDay(new Date(instant)).toISOString(), `${expected}T00:00:00.000Z`)
  }
})
