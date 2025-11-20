import test from 'ava'
import {expandToDaily, normalizeSeries} from '../normalize.js'

// NormalizeSeries tests

test('normalizeSeries - converts units to reference', t => {
  const series = [{
    parameter: 'débit prélevé',
    unit: 'L/s',
    frequency: '1 hour',
    data: [
      {date: '2025-01-01', value: 10}, // 10 L/s = 36 m3/h
      {date: '2025-01-02', value: 20} // 20 L/s = 72 m3/h
    ]
  }]

  const normalized = normalizeSeries(series)

  t.is(normalized.length, 1)
  t.is(normalized[0].unit, 'm³/h')
  t.is(normalized[0].data[0].value, 36)
  t.is(normalized[0].data[0].originalValue, 10)
  t.is(normalized[0].data[0].originalUnit, 'L/s')
  t.is(normalized[0].data[1].value, 72)
})

test('normalizeSeries - does not convert if already reference unit', t => {
  const series = [{
    parameter: 'débit prélevé',
    unit: 'm³/h',
    frequency: '1 hour',
    data: [
      {date: '2025-01-01', value: 36}
    ]
  }]

  const normalized = normalizeSeries(series)

  t.is(normalized.length, 1)
  t.is(normalized[0].unit, 'm³/h')
  t.is(normalized[0].data[0].value, 36)
  t.is(normalized[0].data[0].originalValue, undefined)
})

// ExpandToDaily tests

test('expandToDaily - expands monthly value correctly', t => {
  const row = {date: '2025-01-01', value: 3100, remark: 'Test'}
  const expanded = expandToDaily(row, '1 month')

  t.is(expanded.length, 31) // Janvier a 31 jours
  t.is(expanded[0].date, '2025-01-01')
  t.is(expanded[30].date, '2025-01-31')

  // Vérifier que la valeur est divisée correctement
  const dailyValue = 3100 / 31
  t.is(expanded[0].value, dailyValue)
  t.is(expanded[15].value, dailyValue)

  // Vérifier les métadonnées
  t.is(expanded[0].originalValue, 3100)
  t.is(expanded[0].originalDate, '2025-01-01')
  t.is(expanded[0].originalFrequency, '1 month')
  t.is(expanded[0].daysCovered, 31)
  t.is(expanded[0].remark, 'Test')

  // Vérifier que la somme des valeurs quotidiennes redonne la valeur originale (avec tolérance)
  const sum = expanded.reduce((acc, d) => acc + d.value, 0)
  t.true(Math.abs(sum - 3100) < 0.01)
})

test('expandToDaily - handles february in leap year', t => {
  const row = {date: '2024-02-01', value: 2900}
  const expanded = expandToDaily(row, '1 month')

  t.is(expanded.length, 29) // Février 2024 est bissextile
  t.is(expanded[0].date, '2024-02-01')
  t.is(expanded[28].date, '2024-02-29')
})

test('expandToDaily - handles february in non-leap year', t => {
  const row = {date: '2025-02-01', value: 2800}
  const expanded = expandToDaily(row, '1 month')

  t.is(expanded.length, 28) // Février 2025 n'est pas bissextile
  t.is(expanded[0].date, '2025-02-01')
  t.is(expanded[27].date, '2025-02-28')
})

test('expandToDaily - expands quarterly value correctly', t => {
  const row = {date: '2025-01-01', value: 9000} // Q1 2025
  const expanded = expandToDaily(row, '1 quarter')

  t.is(expanded.length, 90) // Janvier (31) + Février (28) + Mars (31) = 90
  t.is(expanded[0].date, '2025-01-01')
  t.is(expanded[89].date, '2025-03-31')

  // Vérifier les métadonnées
  t.is(expanded[0].originalValue, 9000)
  t.is(expanded[0].originalFrequency, '1 quarter')
  t.is(expanded[0].daysCovered, 90)

  // Vérifier la somme
  const sum = expanded.reduce((acc, d) => acc + d.value, 0)
  t.true(Math.abs(sum - 9000) < 0.01)
})

test('expandToDaily - expands yearly value in leap year', t => {
  const row = {date: '2024-01-01', value: 36_600}
  const expanded = expandToDaily(row, '1 year')

  t.is(expanded.length, 366) // 2024 est bissextile
  t.is(expanded[0].date, '2024-01-01')
  t.is(expanded[365].date, '2024-12-31')

  // Vérifier les métadonnées
  t.is(expanded[0].originalValue, 36_600)
  t.is(expanded[0].originalFrequency, '1 year')
  t.is(expanded[0].daysCovered, 366)
})

test('expandToDaily - expands yearly value in non-leap year', t => {
  const row = {date: '2025-01-01', value: 36_500}
  const expanded = expandToDaily(row, '1 year')

  t.is(expanded.length, 365) // 2025 n'est pas bissextile
  t.is(expanded[0].date, '2025-01-01')
  t.is(expanded[364].date, '2025-12-31')
})

test('expandToDaily - handles row without remark', t => {
  const row = {date: '2025-01-01', value: 3100}
  const expanded = expandToDaily(row, '1 month')

  t.is(expanded.length, 31)
  t.is(expanded[0].remark, undefined)
})

test('expandToDaily - throws error for non-super-daily frequency', t => {
  const row = {date: '2025-01-01', value: 100}
  t.throws(() => expandToDaily(row, '1 day'), {message: /ne peut être utilisé qu'avec des fréquences > 1 jour/})
  t.throws(() => expandToDaily(row, '1 hour'), {message: /ne peut être utilisé qu'avec des fréquences > 1 jour/})
})

// Tests d'agrégation des débits

test('normalizeSeries - aggregates multiple flow series for same point', t => {
  const series = [
    {
      pointPrelevement: 123,
      parameter: 'débit prélevé',
      unit: 'm³/h',
      frequency: '1 hour',
      data: [
        {date: '2025-01-01', time: '10:00', value: 10},
        {date: '2025-01-01', time: '11:00', value: 15}
      ]
    },
    {
      pointPrelevement: 123,
      parameter: 'débit prélevé',
      unit: 'm³/h',
      frequency: '1 hour',
      data: [
        {date: '2025-01-01', time: '10:00', value: 5},
        {date: '2025-01-01', time: '11:00', value: 8}
      ]
    }
  ]

  const normalized = normalizeSeries(series)

  t.is(normalized.length, 1)
  t.is(normalized[0].parameter, 'débit prélevé')
  t.is(normalized[0].aggregated, true)
  t.is(normalized[0].sourceCount, 2)
  t.is(normalized[0].data.length, 2)
  t.is(normalized[0].data[0].value, 15) // 10 + 5
  t.is(normalized[0].data[1].value, 23) // 15 + 8
})

test('normalizeSeries - does not aggregate different parameters', t => {
  const series = [
    {
      pointPrelevement: 123,
      parameter: 'débit prélevé',
      unit: 'm³/h',
      frequency: '1 hour',
      data: [{date: '2025-01-01', time: '10:00', value: 10}]
    },
    {
      pointPrelevement: 123,
      parameter: 'débit restitué',
      unit: 'm³/h',
      frequency: '1 hour',
      data: [{date: '2025-01-01', time: '10:00', value: 5}]
    }
  ]

  const normalized = normalizeSeries(series)

  t.is(normalized.length, 2)
  t.is(normalized[0].parameter, 'débit prélevé')
  t.is(normalized[1].parameter, 'débit restitué')
})

test('normalizeSeries - does not aggregate different points', t => {
  const series = [
    {
      pointPrelevement: 123,
      parameter: 'débit prélevé',
      unit: 'm³/h',
      frequency: '1 hour',
      data: [{date: '2025-01-01', time: '10:00', value: 10}]
    },
    {
      pointPrelevement: 456,
      parameter: 'débit prélevé',
      unit: 'm³/h',
      frequency: '1 hour',
      data: [{date: '2025-01-01', time: '10:00', value: 5}]
    }
  ]

  const normalized = normalizeSeries(series)

  t.is(normalized.length, 2)
  t.is(normalized[0].pointPrelevement, 123)
  t.is(normalized[1].pointPrelevement, 456)
})

test('normalizeSeries - does not aggregate non-flow parameters', t => {
  const series = [
    {
      pointPrelevement: 123,
      parameter: 'volume prélevé',
      unit: 'm³',
      frequency: '1 day',
      data: [{date: '2025-01-01', value: 100}]
    },
    {
      pointPrelevement: 123,
      parameter: 'volume prélevé',
      unit: 'm³',
      frequency: '1 day',
      data: [{date: '2025-01-01', value: 50}]
    }
  ]

  const normalized = normalizeSeries(series)

  t.is(normalized.length, 2)
  t.is(normalized[0].aggregated, undefined)
  t.is(normalized[1].aggregated, undefined)
})

test('normalizeSeries - aggregates débit réservé', t => {
  const series = [
    {
      pointPrelevement: 123,
      parameter: 'débit réservé',
      unit: 'm³/h',
      frequency: '1 hour',
      data: [{date: '2025-01-01', time: '10:00', value: 2}]
    },
    {
      pointPrelevement: 123,
      parameter: 'débit réservé',
      unit: 'm³/h',
      frequency: '1 hour',
      data: [{date: '2025-01-01', time: '10:00', value: 3}]
    }
  ]

  const normalized = normalizeSeries(series)

  t.is(normalized.length, 1)
  t.is(normalized[0].parameter, 'débit réservé')
  t.is(normalized[0].data[0].value, 5) // 2 + 3
})

test('normalizeSeries - aggregates only matching timestamps', t => {
  const series = [
    {
      pointPrelevement: 123,
      parameter: 'débit prélevé',
      unit: 'm³/h',
      frequency: '1 hour',
      data: [
        {date: '2025-01-01', time: '10:00', value: 10},
        {date: '2025-01-01', time: '11:00', value: 15}
      ]
    },
    {
      pointPrelevement: 123,
      parameter: 'débit prélevé',
      unit: 'm³/h',
      frequency: '1 hour',
      data: [
        {date: '2025-01-01', time: '10:00', value: 5}
        // Pas de valeur à 11:00
      ]
    }
  ]

  const normalized = normalizeSeries(series)

  t.is(normalized.length, 1)
  t.is(normalized[0].data.length, 2)
  t.is(normalized[0].data[0].value, 15) // 10 + 5
  t.is(normalized[0].data[1].value, 15) // 15 seul
})

test('normalizeSeries - preserves source information in aggregated data', t => {
  const series = [
    {
      pointPrelevement: 123,
      parameter: 'débit prélevé',
      unit: 'm³/h',
      frequency: '1 hour',
      data: [{date: '2025-01-01', time: '10:00', value: 10, originalValue: 8, originalUnit: 'L/s'}]
    },
    {
      pointPrelevement: 123,
      parameter: 'débit prélevé',
      unit: 'm³/h',
      frequency: '1 hour',
      data: [{date: '2025-01-01', time: '10:00', value: 5}]
    }
  ]

  const normalized = normalizeSeries(series)

  t.is(normalized.length, 1)
  t.is(normalized[0].data[0].value, 15)
  t.is(normalized[0].data[0].sources.length, 2)
  t.is(normalized[0].data[0].sources[0].originalValue, 8)
  t.is(normalized[0].data[0].sources[0].originalUnit, 'L/s')
  t.is(normalized[0].data[0].sources[1].originalValue, 5)
})

