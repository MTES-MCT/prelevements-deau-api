import test from 'ava'
import {calculateTotalVolumePreleve} from '../attachments.js'

test('calculateTotalVolumePreleve - null series', t => {
  const result = calculateTotalVolumePreleve(null)
  t.is(result, 0)
})

test('calculateTotalVolumePreleve - undefined series', t => {
  const result = calculateTotalVolumePreleve(undefined)
  t.is(result, 0)
})

test('calculateTotalVolumePreleve - empty array', t => {
  const result = calculateTotalVolumePreleve([])
  t.is(result, 0)
})

test('calculateTotalVolumePreleve - single series with single value', t => {
  const series = [
    {
      parameter: 'volume prélevé',
      data: [
        {date: '2025-01-01', value: 42}
      ]
    }
  ]
  const result = calculateTotalVolumePreleve(series)
  t.is(result, 42)
})

test('calculateTotalVolumePreleve - single series with multiple values', t => {
  const series = [
    {
      parameter: 'volume prélevé',
      data: [
        {date: '2025-01-01', value: 42},
        {date: '2025-01-02', value: 30},
        {date: '2025-01-03', value: 10}
      ]
    }
  ]
  const result = calculateTotalVolumePreleve(series)
  t.is(result, 82)
})

test('calculateTotalVolumePreleve - multiple series', t => {
  const series = [
    {
      parameter: 'volume prélevé',
      data: [
        {date: '2025-01-01', value: 42},
        {date: '2025-01-02', value: 30}
      ]
    },
    {
      parameter: 'volume prélevé',
      data: [
        {date: '2025-01-01', value: 10}
      ]
    }
  ]
  const result = calculateTotalVolumePreleve(series)
  t.is(result, 82)
})

test('calculateTotalVolumePreleve - mixed parameters', t => {
  const series = [
    {
      parameter: 'volume prélevé',
      data: [
        {date: '2025-01-01', value: 50}
      ]
    },
    {
      parameter: 'température',
      data: [
        {date: '2025-01-01', value: 25}
      ]
    },
    {
      parameter: 'débit',
      data: [
        {date: '2025-01-01', value: 100}
      ]
    }
  ]
  const result = calculateTotalVolumePreleve(series)
  t.is(result, 50)
})

test('calculateTotalVolumePreleve - null and undefined values', t => {
  const series = [
    {
      parameter: 'volume prélevé',
      data: [
        {date: '2025-01-01', value: 10},
        {date: '2025-01-02', value: null},
        {date: '2025-01-03', value: undefined},
        {date: '2025-01-04', value: 20}
      ]
    }
  ]
  const result = calculateTotalVolumePreleve(series)
  t.is(result, 30)
})

test('calculateTotalVolumePreleve - series without data', t => {
  const series = [
    {
      parameter: 'volume prélevé'
    }
  ]
  const result = calculateTotalVolumePreleve(series)
  t.is(result, 0)
})

test('calculateTotalVolumePreleve - series with empty data', t => {
  const series = [
    {
      parameter: 'volume prélevé',
      data: []
    }
  ]
  const result = calculateTotalVolumePreleve(series)
  t.is(result, 0)
})

test('calculateTotalVolumePreleve - no volume prélevé series', t => {
  const series = [
    {
      parameter: 'température',
      data: [
        {date: '2025-01-01', value: 25}
      ]
    }
  ]
  const result = calculateTotalVolumePreleve(series)
  t.is(result, 0)
})

test('calculateTotalVolumePreleve - handles decimal values', t => {
  const series = [
    {
      parameter: 'volume prélevé',
      data: [
        {date: '2025-01-01', value: 10.5},
        {date: '2025-01-02', value: 20.3}
      ]
    }
  ]
  const result = calculateTotalVolumePreleve(series)
  t.is(result, 30.8)
})

test('calculateTotalVolumePreleve - handles zero values', t => {
  const series = [
    {
      parameter: 'volume prélevé',
      data: [
        {date: '2025-01-01', value: 0},
        {date: '2025-01-02', value: 10},
        {date: '2025-01-03', value: 0}
      ]
    }
  ]
  const result = calculateTotalVolumePreleve(series)
  t.is(result, 10)
})

test('calculateTotalVolumePreleve - ignores non-numeric values', t => {
  const series = [
    {
      parameter: 'volume prélevé',
      data: [
        {date: '2025-01-01', value: 10},
        {date: '2025-01-02', value: '20'},
        {date: '2025-01-03', value: 15}
      ]
    }
  ]
  const result = calculateTotalVolumePreleve(series)
  t.is(result, 25)
})
