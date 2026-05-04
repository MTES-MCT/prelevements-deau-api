import test from 'ava'
import {computeVolumeRowsFromIndexReadings} from '../reconstruct-volumes-from-index-for-service-account.js'

test('computeVolumeRowsFromIndexReadings — écart simple entre deux relevés', t => {
  const rows = computeVolumeRowsFromIndexReadings([
    {date: new Date('2024-01-01T00:00:00.000Z'), value: 100},
    {date: new Date('2024-01-02T00:00:00.000Z'), value: 130}
  ])
  t.is(rows.length, 1)
  t.is(rows[0].value, 30)
  t.deepEqual(rows[0].periodStart, new Date('2024-01-01T00:00:00.000Z'))
  t.deepEqual(rows[0].periodEnd, new Date('2024-01-02T00:00:00.000Z'))
})

test('computeVolumeRowsFromIndexReadings — remise à zéro si delta négatif', t => {
  const rows = computeVolumeRowsFromIndexReadings([
    {date: new Date('2024-01-01T00:00:00.000Z'), value: 500},
    {date: new Date('2024-01-02T00:00:00.000Z'), value: 50}
  ])
  t.is(rows.length, 1)
  t.is(rows[0].value, 50)
})

test('computeVolumeRowsFromIndexReadings — dédoublonnage par date (max)', t => {
  const rows = computeVolumeRowsFromIndexReadings([
    {date: new Date('2024-01-01T00:00:00.000Z'), value: 10},
    {date: new Date('2024-01-01T00:00:00.000Z'), value: 12},
    {date: new Date('2024-01-03T00:00:00.000Z'), value: 20}
  ])
  t.is(rows.length, 1)
  t.is(rows[0].value, 8)
})
