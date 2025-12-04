import test from 'ava'

// Import des fonctions à tester (non exportées, on va tester via le comportement observable)
// On va tester aggregateValuesByPeriodKey indirectement via extractValuesFromDocument + aggregation

// Simuler le comportement de aggregateValuesByDate en testant son effet
// Pour cela, on va créer un mock simple qui reproduit la logique

import {
  applyAggregationOperator,
  extractValuesFromDocument
} from '../series-aggregation.js'

// Helper pour simuler aggregateValuesByPeriodKey (fonction non exportée)
function aggregateValuesByPeriodKey(values, operator) {
  if (!values || values.length === 0) {
    return []
  }

  const valuesByPeriod = new Map()

  // Regrouper par période
  for (const item of values) {
    const {period} = item
    if (!valuesByPeriod.has(period)) {
      valuesByPeriod.set(period, [])
    }

    valuesByPeriod.get(period).push(item)
  }

  // Agréger chaque groupe
  const aggregated = []
  for (const [period, items] of valuesByPeriod.entries()) {
    const result = applyAggregationOperator(items, operator)
    if (result !== null) {
      aggregated.push({
        period,
        value: result.value,
        ...(result.remarks && {remarks: result.remarks})
      })
    }
  }

  return aggregated
}

// Tests pour aggregateValuesByPeriodKey

test('aggregateValuesByPeriodKey - agrège plusieurs valeurs de la même période avec sum', t => {
  const values = [
    {period: '2024-01-15 10:00', value: 10},
    {period: '2024-01-15 10:00', value: 20},
    {period: '2024-01-15 10:00', value: 30}
  ]

  const result = aggregateValuesByPeriodKey(values, 'sum')

  t.is(result.length, 1)
  t.is(result[0].period, '2024-01-15 10:00')
  t.is(result[0].value, 60)
})

test('aggregateValuesByPeriodKey - agrège plusieurs valeurs de la même période avec max', t => {
  const values = [
    {period: '2024-01-15 10:00', value: 10},
    {period: '2024-01-15 10:00', value: 30},
    {period: '2024-01-15 10:00', value: 20}
  ]

  const result = aggregateValuesByPeriodKey(values, 'max')

  t.is(result.length, 1)
  t.is(result[0].period, '2024-01-15 10:00')
  t.is(result[0].value, 30)
})

test('aggregateValuesByPeriodKey - agrège plusieurs valeurs de la même période avec min', t => {
  const values = [
    {period: '2024-01-15 10:00', value: 10},
    {period: '2024-01-15 10:00', value: 30},
    {period: '2024-01-15 10:00', value: 20}
  ]

  const result = aggregateValuesByPeriodKey(values, 'min')

  t.is(result.length, 1)
  t.is(result[0].period, '2024-01-15 10:00')
  t.is(result[0].value, 10)
})

test('aggregateValuesByPeriodKey - agrège plusieurs valeurs de la même période avec mean', t => {
  const values = [
    {period: '2024-01-15 10:00', value: 10},
    {period: '2024-01-15 10:00', value: 20},
    {period: '2024-01-15 10:00', value: 30}
  ]

  const result = aggregateValuesByPeriodKey(values, 'mean')

  t.is(result.length, 1)
  t.is(result[0].period, '2024-01-15 10:00')
  t.is(result[0].value, 20)
})

test('aggregateValuesByPeriodKey - garde les périodes séparées distinctes', t => {
  const values = [
    {period: '2024-01-15 10:00', value: 10},
    {period: '2024-01-15 10:00', value: 20},
    {period: '2024-01-15 11:00', value: 30},
    {period: '2024-01-15 11:00', value: 40}
  ]

  const result = aggregateValuesByPeriodKey(values, 'sum')

  t.is(result.length, 2)
  t.is(result[0].period, '2024-01-15 10:00')
  t.is(result[0].value, 30)
  t.is(result[1].period, '2024-01-15 11:00')
  t.is(result[1].value, 70)
})

test('aggregateValuesByPeriodKey - valeur unique reste inchangée', t => {
  const values = [
    {period: '2024-01-15 10:00', value: 42}
  ]

  const result = aggregateValuesByPeriodKey(values, 'sum')

  t.is(result.length, 1)
  t.is(result[0].period, '2024-01-15 10:00')
  t.is(result[0].value, 42)
})

test('aggregateValuesByPeriodKey - tableau vide retourne tableau vide', t => {
  const result = aggregateValuesByPeriodKey([], 'sum')
  t.deepEqual(result, [])
})

test('aggregateValuesByPeriodKey - null retourne tableau vide', t => {
  const result = aggregateValuesByPeriodKey(null, 'sum')
  t.deepEqual(result, [])
})

test('aggregateValuesByPeriodKey - préserve les remarques', t => {
  const values = [
    {period: '2024-01-15 10:00', value: 10, remark: 'Estimation'},
    {period: '2024-01-15 10:00', value: 20, remark: 'Compteur défectueux'},
    {period: '2024-01-15 10:00', value: 30}
  ]

  const result = aggregateValuesByPeriodKey(values, 'sum')

  t.is(result.length, 1)
  t.is(result[0].value, 60)
  t.truthy(result[0].remarks)
  t.is(result[0].remarks.length, 2)
  t.true(result[0].remarks.includes('Estimation'))
  t.true(result[0].remarks.includes('Compteur défectueux'))
})

test('aggregateValuesByPeriodKey - déduplique les remarques identiques', t => {
  const values = [
    {period: '2024-01-15 10:00', value: 10, remark: 'Estimation'},
    {period: '2024-01-15 10:00', value: 20, remark: 'Estimation'},
    {period: '2024-01-15 10:00', value: 30}
  ]

  const result = aggregateValuesByPeriodKey(values, 'sum')

  t.is(result.length, 1)
  t.truthy(result[0].remarks)
  t.is(result[0].remarks.length, 1)
  t.is(result[0].remarks[0], 'Estimation')
})

// Tests d'intégration : extractValuesFromDocument + aggregateValuesByPeriodKey

test('intégration - valeurs infra-journalières agrégées temporellement avec sum', t => {
  // Simuler l'extraction puis l'agrégation temporelle
  const valueDoc = {
    date: '2024-01-15',
    values: [
      {time: '10:05', value: 10},
      {time: '10:15', value: 20},
      {time: '10:25', value: 30}
    ]
  }

  const context = {
    isSubDaily: true,
    useAggregates: false,
    aggregationFrequency: '1 hour',
    temporalOperator: 'sum'
  }

  // Extraction
  const extracted = extractValuesFromDocument(valueDoc, context)
  t.is(extracted.length, 3) // 3 valeurs extraites
  t.true(extracted.every(v => v.period === '2024-01-15 10:00'))

  // Agrégation temporelle
  const aggregated = aggregateValuesByPeriodKey(extracted, 'sum')
  t.is(aggregated.length, 1)
  t.is(aggregated[0].period, '2024-01-15 10:00')
  t.is(aggregated[0].value, 60)
})

test('intégration - valeurs infra-journalières agrégées temporellement avec max', t => {
  const valueDoc = {
    date: '2024-01-15',
    values: [
      {time: '10:05', value: 10},
      {time: '10:15', value: 30},
      {time: '10:25', value: 20}
    ]
  }

  const context = {
    isSubDaily: true,
    useAggregates: false,
    aggregationFrequency: '1 hour',
    temporalOperator: 'max'
  }

  const extracted = extractValuesFromDocument(valueDoc, context)
  const aggregated = aggregateValuesByPeriodKey(extracted, 'max')

  t.is(aggregated.length, 1)
  t.is(aggregated[0].value, 30)
})

test('intégration - valeurs infra-journalières agrégées temporellement avec min', t => {
  const valueDoc = {
    date: '2024-01-15',
    values: [
      {time: '10:05', value: 10},
      {time: '10:15', value: 30},
      {time: '10:25', value: 20}
    ]
  }

  const context = {
    isSubDaily: true,
    useAggregates: false,
    aggregationFrequency: '1 hour',
    temporalOperator: 'min'
  }

  const extracted = extractValuesFromDocument(valueDoc, context)
  const aggregated = aggregateValuesByPeriodKey(extracted, 'min')

  t.is(aggregated.length, 1)
  t.is(aggregated[0].value, 10)
})

test('intégration - valeurs infra-journalières agrégées temporellement avec mean', t => {
  const valueDoc = {
    date: '2024-01-15',
    values: [
      {time: '10:05', value: 10},
      {time: '10:15', value: 20},
      {time: '10:25', value: 30}
    ]
  }

  const context = {
    isSubDaily: true,
    useAggregates: false,
    aggregationFrequency: '1 hour',
    temporalOperator: 'mean'
  }

  const extracted = extractValuesFromDocument(valueDoc, context)
  const aggregated = aggregateValuesByPeriodKey(extracted, 'mean')

  t.is(aggregated.length, 1)
  t.is(aggregated[0].value, 20)
})

test('intégration - plusieurs périodes horaires distinctes', t => {
  const valueDoc = {
    date: '2024-01-15',
    values: [
      {time: '10:05', value: 10},
      {time: '10:15', value: 20},
      {time: '11:05', value: 30},
      {time: '11:25', value: 40}
    ]
  }

  const context = {
    isSubDaily: true,
    useAggregates: false,
    aggregationFrequency: '1 hour',
    temporalOperator: 'sum'
  }

  const extracted = extractValuesFromDocument(valueDoc, context)
  const aggregated = aggregateValuesByPeriodKey(extracted, 'sum')

  t.is(aggregated.length, 2)
  t.is(aggregated[0].period, '2024-01-15 10:00')
  t.is(aggregated[0].value, 30)
  t.is(aggregated[1].period, '2024-01-15 11:00')
  t.is(aggregated[1].value, 70)
})

test('intégration - agrégation 15 minutes avec temporalOperator', t => {
  const valueDoc = {
    date: '2024-01-15',
    values: [
      {time: '10:00', value: 10},
      {time: '10:07', value: 15},
      {time: '10:14', value: 20},
      {time: '10:15', value: 25},
      {time: '10:22', value: 30}
    ]
  }

  const context = {
    isSubDaily: true,
    useAggregates: false,
    aggregationFrequency: '15 minutes',
    temporalOperator: 'sum'
  }

  const extracted = extractValuesFromDocument(valueDoc, context)
  const aggregated = aggregateValuesByPeriodKey(extracted, 'sum')

  t.is(aggregated.length, 2)
  t.is(aggregated[0].period, '2024-01-15 10:00')
  t.is(aggregated[0].value, 45) // 10 + 15 + 20
  t.is(aggregated[1].period, '2024-01-15 10:15')
  t.is(aggregated[1].value, 55) // 25 + 30
})

test('intégration - valeurs journalières ne nécessitent pas d\'agrégation temporelle', t => {
  const valueDoc = {
    date: '2024-01-15',
    values: {value: 100}
  }

  const context = {
    isSubDaily: false,
    useAggregates: false,
    aggregationFrequency: '1 day',
    temporalOperator: 'sum'
  }

  const extracted = extractValuesFromDocument(valueDoc, context)
  const aggregated = aggregateValuesByPeriodKey(extracted, 'sum')

  t.is(aggregated.length, 1)
  t.is(aggregated[0].period, '2024-01-15')
  t.is(aggregated[0].value, 100)
})

test('intégration - dailyAggregates déjà agrégés temporellement', t => {
  const valueDoc = {
    date: '2024-01-15',
    dailyAggregates: {
      sum: 100,
      mean: 25,
      min: 10,
      max: 40
    }
  }

  const context = {
    isSubDaily: true,
    useAggregates: true,
    aggregationFrequency: '1 day',
    temporalOperator: 'max'
  }

  const extracted = extractValuesFromDocument(valueDoc, context)
  const aggregated = aggregateValuesByPeriodKey(extracted, 'max')

  // DailyAggregates retourne déjà une seule valeur agrégée
  t.is(aggregated.length, 1)
  t.is(aggregated[0].value, 40) // Le max des dailyAggregates
})

test('intégration - remarques préservées dans l\'agrégation temporelle', t => {
  const valueDoc = {
    date: '2024-01-15',
    values: [
      {time: '10:05', value: 10, remark: 'Estimation'},
      {time: '10:15', value: 20, remark: 'Compteur défectueux'},
      {time: '10:25', value: 30}
    ]
  }

  const context = {
    isSubDaily: true,
    useAggregates: false,
    aggregationFrequency: '1 hour',
    temporalOperator: 'sum'
  }

  const extracted = extractValuesFromDocument(valueDoc, context)
  const aggregated = aggregateValuesByPeriodKey(extracted, 'sum')

  t.is(aggregated.length, 1)
  t.is(aggregated[0].value, 60)
  t.truthy(aggregated[0].remarks)
  t.is(aggregated[0].remarks.length, 2)
})

test('intégration - opérateurs différents donnent résultats différents', t => {
  const valueDoc = {
    date: '2024-01-15',
    values: [
      {time: '10:05', value: 10},
      {time: '10:15', value: 50},
      {time: '10:25', value: 20}
    ]
  }

  const context = {
    isSubDaily: true,
    useAggregates: false,
    aggregationFrequency: '1 hour',
    temporalOperator: 'sum' // On va changer ça
  }

  const extracted = extractValuesFromDocument(valueDoc, context)

  const aggregatedSum = aggregateValuesByPeriodKey(extracted, 'sum')
  const aggregatedMean = aggregateValuesByPeriodKey(extracted, 'mean')
  const aggregatedMin = aggregateValuesByPeriodKey(extracted, 'min')
  const aggregatedMax = aggregateValuesByPeriodKey(extracted, 'max')

  t.is(aggregatedSum[0].value, 80)
  t.is(Math.round(aggregatedMean[0].value * 100) / 100, 26.67)
  t.is(aggregatedMin[0].value, 10)
  t.is(aggregatedMax[0].value, 50)
})
