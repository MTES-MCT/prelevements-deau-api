import test from 'ava'
import {
  applyAggregationOperator,
  aggregateValuesByPeriod,
  validateQueryParams,
  extractPeriod,
  extractSubDailyPeriod,
  extractValuesFromDocument
} from '../series-aggregation.js'

// Tests pour l'opérateur 'sum'
test('applyAggregationOperator - sum avec valeurs valides', t => {
  const result = applyAggregationOperator([10, 20, 30], 'sum')
  t.is(result, 60)
})

test('applyAggregationOperator - sum avec un seul élément', t => {
  const result = applyAggregationOperator([42], 'sum')
  t.is(result, 42)
})

test('applyAggregationOperator - sum avec valeurs décimales', t => {
  const result = applyAggregationOperator([1.5, 2.3, 3.2], 'sum')
  t.is(Math.round(result * 10) / 10, 7)
})

test('applyAggregationOperator - sum avec valeurs négatives', t => {
  const result = applyAggregationOperator([10, -5, 15], 'sum')
  t.is(result, 20)
})

test('applyAggregationOperator - sum avec zéro', t => {
  const result = applyAggregationOperator([0, 0, 0], 'sum')
  t.is(result, 0)
})

// Tests pour l'opérateur 'mean'
test('applyAggregationOperator - mean avec valeurs valides', t => {
  const result = applyAggregationOperator([10, 20, 30], 'mean')
  t.is(result, 20)
})

test('applyAggregationOperator - mean avec un seul élément', t => {
  const result = applyAggregationOperator([42], 'mean')
  t.is(result, 42)
})

test('applyAggregationOperator - mean avec valeurs décimales', t => {
  const result = applyAggregationOperator([1, 2, 3, 4], 'mean')
  t.is(result, 2.5)
})

// Tests pour l'opérateur 'min'
test('applyAggregationOperator - min avec valeurs valides', t => {
  const result = applyAggregationOperator([10, 5, 30, 2], 'min')
  t.is(result, 2)
})

test('applyAggregationOperator - min avec valeurs négatives', t => {
  const result = applyAggregationOperator([10, -5, 15], 'min')
  t.is(result, -5)
})

test('applyAggregationOperator - min avec un seul élément', t => {
  const result = applyAggregationOperator([42], 'min')
  t.is(result, 42)
})

// Tests pour l'opérateur 'max'
test('applyAggregationOperator - max avec valeurs valides', t => {
  const result = applyAggregationOperator([10, 50, 30, 2], 'max')
  t.is(result, 50)
})

test('applyAggregationOperator - max avec valeurs négatives', t => {
  const result = applyAggregationOperator([-10, -5, -15], 'max')
  t.is(result, -5)
})

test('applyAggregationOperator - max avec un seul élément', t => {
  const result = applyAggregationOperator([42], 'max')
  t.is(result, 42)
})

// Tests avec valeurs invalides
test('applyAggregationOperator - sum avec null dans le tableau', t => {
  const result = applyAggregationOperator([10, null, 20, 30], 'sum')
  t.is(result, 60)
})

test('applyAggregationOperator - sum avec undefined dans le tableau', t => {
  const result = applyAggregationOperator([10, undefined, 20], 'sum')
  t.is(result, 30)
})

test('applyAggregationOperator - sum avec NaN dans le tableau', t => {
  const result = applyAggregationOperator([10, Number.NaN, 20], 'sum')
  t.is(result, 30)
})

test('applyAggregationOperator - sum avec Infinity dans le tableau', t => {
  const result = applyAggregationOperator([10, Number.POSITIVE_INFINITY, 20], 'sum')
  t.is(result, 30)
})

test('applyAggregationOperator - sum avec string dans le tableau', t => {
  const result = applyAggregationOperator([10, '20', 30], 'sum')
  t.is(result, 40)
})

test('applyAggregationOperator - mean avec valeurs mixtes valides/invalides', t => {
  const result = applyAggregationOperator([10, null, 20, undefined, 30, Number.NaN], 'mean')
  t.is(result, 20)
})

test('applyAggregationOperator - min avec valeurs mixtes', t => {
  const result = applyAggregationOperator([10, null, 5, undefined, 30], 'min')
  t.is(result, 5)
})

test('applyAggregationOperator - max avec valeurs mixtes', t => {
  const result = applyAggregationOperator([10, null, 5, undefined, 30], 'max')
  t.is(result, 30)
})

// Tests avec tableaux vides ou invalides
test('applyAggregationOperator - tableau vide retourne null', t => {
  const result = applyAggregationOperator([], 'sum')
  t.is(result, null)
})

test('applyAggregationOperator - tableau avec uniquement des valeurs invalides retourne null', t => {
  const result = applyAggregationOperator([null, undefined, Number.NaN, Number.POSITIVE_INFINITY], 'sum')
  t.is(result, null)
})

test('applyAggregationOperator - null au lieu de tableau retourne null', t => {
  const result = applyAggregationOperator(null, 'sum')
  t.is(result, null)
})

test('applyAggregationOperator - undefined au lieu de tableau retourne null', t => {
  const result = applyAggregationOperator(undefined, 'sum')
  t.is(result, null)
})

test('applyAggregationOperator - non-array retourne null', t => {
  const result = applyAggregationOperator('not an array', 'sum')
  t.is(result, null)
})

// Tests avec opérateur invalide
test('applyAggregationOperator - opérateur inconnu lance une erreur', t => {
  const error = t.throws(() => {
    applyAggregationOperator([10, 20, 30], 'invalid')
  })
  t.is(error.message, 'Opérateur inconnu: invalid')
})

test('applyAggregationOperator - opérateur undefined lance une erreur', t => {
  const error = t.throws(() => {
    applyAggregationOperator([10, 20, 30], undefined)
  })
  t.regex(error.message, /Opérateur inconnu/)
})

// Tests edge cases
test('applyAggregationOperator - sum avec très grands nombres', t => {
  const result = applyAggregationOperator([1e15, 2e15, 3e15], 'sum')
  t.is(result, 6e15)
})

test('applyAggregationOperator - sum avec très petits nombres', t => {
  const result = applyAggregationOperator([1e-10, 2e-10, 3e-10], 'sum')
  t.true(Math.abs(result - 6e-10) < 1e-20)
})

test('applyAggregationOperator - mean préserve la précision', t => {
  const result = applyAggregationOperator([1, 2, 3], 'mean')
  t.is(result, 2)
})

test('applyAggregationOperator - sum avec zéros et valeurs positives', t => {
  const result = applyAggregationOperator([0, 0, 10, 0, 20], 'sum')
  t.is(result, 30)
})

test('applyAggregationOperator - min avec zéro et valeurs positives', t => {
  const result = applyAggregationOperator([10, 0, 20], 'min')
  t.is(result, 0)
})

test('applyAggregationOperator - max avec zéro et valeurs négatives', t => {
  const result = applyAggregationOperator([-10, 0, -20], 'max')
  t.is(result, 0)
})

// Tests avec tableaux de grande taille
test('applyAggregationOperator - sum avec 1000 valeurs', t => {
  const values = Array.from({length: 1000}, (_, i) => i + 1)
  const result = applyAggregationOperator(values, 'sum')
  t.is(result, 500_500) // Formule: n(n+1)/2
})

test('applyAggregationOperator - mean avec 1000 valeurs', t => {
  const values = Array.from({length: 1000}, (_, i) => i + 1)
  const result = applyAggregationOperator(values, 'mean')
  t.is(result, 500.5)
})

test('applyAggregationOperator - min/max avec 1000 valeurs', t => {
  const values = Array.from({length: 1000}, (_, i) => i + 1)
  t.is(applyAggregationOperator(values, 'min'), 1)
  t.is(applyAggregationOperator(values, 'max'), 1000)
})

// Tests pour aggregateValuesByPeriod

// Tests avec frequency '1 day'
test('aggregateValuesByPeriod - 1 day retourne les valeurs inchangées', t => {
  const dailyValues = [
    {date: '2024-01-01', value: 10},
    {date: '2024-01-02', value: 20},
    {date: '2024-01-03', value: 30}
  ]
  const result = aggregateValuesByPeriod(dailyValues, '1 day', 'sum')
  t.deepEqual(result, dailyValues)
})

// Tests avec frequency '1 month'
test('aggregateValuesByPeriod - 1 month avec sum', t => {
  const dailyValues = [
    {date: '2024-01-01', value: 10},
    {date: '2024-01-15', value: 20},
    {date: '2024-02-01', value: 30},
    {date: '2024-02-10', value: 40}
  ]
  const result = aggregateValuesByPeriod(dailyValues, '1 month', 'sum')
  t.deepEqual(result, [
    {date: '2024-01', value: 30},
    {date: '2024-02', value: 70}
  ])
})

test('aggregateValuesByPeriod - 1 month avec mean', t => {
  const dailyValues = [
    {date: '2024-01-01', value: 10},
    {date: '2024-01-15', value: 20},
    {date: '2024-02-01', value: 30}
  ]
  const result = aggregateValuesByPeriod(dailyValues, '1 month', 'mean')
  t.is(result.length, 2)
  t.is(result[0].date, '2024-01')
  t.is(result[0].value, 15)
  t.is(result[1].date, '2024-02')
  t.is(result[1].value, 30)
})

test('aggregateValuesByPeriod - 1 month avec min/max', t => {
  const dailyValues = [
    {date: '2024-01-01', value: 10},
    {date: '2024-01-15', value: 50},
    {date: '2024-01-20', value: 30}
  ]
  const minResult = aggregateValuesByPeriod(dailyValues, '1 month', 'min')
  const maxResult = aggregateValuesByPeriod(dailyValues, '1 month', 'max')

  t.is(minResult[0].value, 10)
  t.is(maxResult[0].value, 50)
})

// Tests avec frequency '1 year'
test('aggregateValuesByPeriod - 1 year avec sum', t => {
  const dailyValues = [
    {date: '2023-01-01', value: 100},
    {date: '2023-06-15', value: 200},
    {date: '2024-01-01', value: 300},
    {date: '2024-12-31', value: 400}
  ]
  const result = aggregateValuesByPeriod(dailyValues, '1 year', 'sum')
  t.deepEqual(result, [
    {date: '2023', value: 300},
    {date: '2024', value: 700}
  ])
})

test('aggregateValuesByPeriod - 1 year avec mean', t => {
  const dailyValues = [
    {date: '2023-01-01', value: 10},
    {date: '2023-06-15', value: 20},
    {date: '2023-12-31', value: 30}
  ]
  const result = aggregateValuesByPeriod(dailyValues, '1 year', 'mean')
  t.is(result.length, 1)
  t.is(result[0].date, '2023')
  t.is(result[0].value, 20)
})

// Tests avec valeurs manquantes/nulles
test('aggregateValuesByPeriod - gère les valeurs nulles via applyAggregationOperator', t => {
  const dailyValues = [
    {date: '2024-01-01', value: 10},
    {date: '2024-01-02', value: null},
    {date: '2024-01-03', value: 20}
  ]
  // ApplyAggregationOperator filtre les nulls, donc on devrait avoir 30
  const result = aggregateValuesByPeriod(dailyValues, '1 month', 'sum')
  t.is(result[0].value, 30)
})

// Tests avec tableau vide
test('aggregateValuesByPeriod - tableau vide retourne tableau vide', t => {
  const result = aggregateValuesByPeriod([], '1 month', 'sum')
  t.deepEqual(result, [])
})

// Tests avec tri
test('aggregateValuesByPeriod - retourne les périodes triées', t => {
  const dailyValues = [
    {date: '2024-03-01', value: 30},
    {date: '2024-01-01', value: 10},
    {date: '2024-02-01', value: 20}
  ]
  const result = aggregateValuesByPeriod(dailyValues, '1 month', 'sum')
  t.is(result[0].date, '2024-01')
  t.is(result[1].date, '2024-02')
  t.is(result[2].date, '2024-03')
})

// Tests pour la validation (pointIds OR preleveurId, ou les deux)
test('validateQueryParams - rejette si ni pointIds ni preleveurId fourni', t => {
  const error = t.throws(() => {
    validateQueryParams({
      parameter: 'volume prélevé',
      aggregationFrequency: '1 day'
    })
  })
  t.true(error.message.includes('pointIds') || error.message.includes('preleveurId'))
})

test('validateQueryParams - accepte pointIds seul', t => {
  const result = validateQueryParams({
    pointIds: '1,2,3',
    parameter: 'volume prélevé',
    aggregationFrequency: '1 day'
  })
  t.is(result.pointIds, '1,2,3')
  t.is(result.preleveurId, undefined)
})

test('validateQueryParams - accepte preleveurId seul', t => {
  const result = validateQueryParams({
    preleveurId: 5,
    parameter: 'volume prélevé',
    aggregationFrequency: '1 day'
  })
  t.is(result.preleveurId, 5)
  t.is(result.pointIds, undefined)
})

test('validateQueryParams - accepte preleveurId ET pointIds ensemble', t => {
  const result = validateQueryParams({
    preleveurId: 5,
    pointIds: '1,2,3',
    parameter: 'volume prélevé',
    aggregationFrequency: '1 day'
  })
  t.is(result.preleveurId, 5)
  t.is(result.pointIds, '1,2,3')
})

test('validateQueryParams - preleveurId doit être un nombre ou ObjectId', t => {
  const error = t.throws(() => {
    validateQueryParams({
      preleveurId: 'abc',
      parameter: 'volume prélevé',
      operator: 'sum'
    })
  })
  // Le message peut mentionner "number" ou "pattern" selon l'alternative Joi qui échoue
  t.true(error.message.includes('number') || error.message.includes('pattern') || error.message.includes('alternatives'))
})

// Tests pour extractPeriod
test('extractPeriod - extrait le mois au format YYYY-MM', t => {
  t.is(extractPeriod('2024-01-15', '1 month'), '2024-01')
  t.is(extractPeriod('2024-12-31', '1 month'), '2024-12')
})

test('extractPeriod - extrait l\'année au format YYYY', t => {
  t.is(extractPeriod('2024-01-15', '1 year'), '2024')
  t.is(extractPeriod('2024-12-31', '1 year'), '2024')
})

test('extractPeriod - retourne la date complète pour 1 day', t => {
  t.is(extractPeriod('2024-01-15', '1 day'), '2024-01-15')
})

test('extractPeriod - gère les dates de début d\'année', t => {
  t.is(extractPeriod('2024-01-01', '1 month'), '2024-01')
  t.is(extractPeriod('2024-01-01', '1 year'), '2024')
})

test('extractPeriod - gère les dates de fin d\'année', t => {
  t.is(extractPeriod('2024-12-31', '1 month'), '2024-12')
  t.is(extractPeriod('2024-12-31', '1 year'), '2024')
})

// Tests pour extractSubDailyPeriod
test('extractSubDailyPeriod - arrondit à la tranche de 15 minutes inférieure', t => {
  t.is(extractSubDailyPeriod('2024-01-15', '12:00', '15 minutes'), '2024-01-15 12:00')
  t.is(extractSubDailyPeriod('2024-01-15', '12:07', '15 minutes'), '2024-01-15 12:00')
  t.is(extractSubDailyPeriod('2024-01-15', '12:14', '15 minutes'), '2024-01-15 12:00')
  t.is(extractSubDailyPeriod('2024-01-15', '12:15', '15 minutes'), '2024-01-15 12:15')
  t.is(extractSubDailyPeriod('2024-01-15', '12:29', '15 minutes'), '2024-01-15 12:15')
  t.is(extractSubDailyPeriod('2024-01-15', '12:30', '15 minutes'), '2024-01-15 12:30')
  t.is(extractSubDailyPeriod('2024-01-15', '12:45', '15 minutes'), '2024-01-15 12:45')
})

test('extractSubDailyPeriod - arrondit à l\'heure', t => {
  t.is(extractSubDailyPeriod('2024-01-15', '12:00', '1 hour'), '2024-01-15 12:00')
  t.is(extractSubDailyPeriod('2024-01-15', '12:30', '1 hour'), '2024-01-15 12:00')
  t.is(extractSubDailyPeriod('2024-01-15', '12:59', '1 hour'), '2024-01-15 12:00')
  t.is(extractSubDailyPeriod('2024-01-15', '13:00', '1 hour'), '2024-01-15 13:00')
})

test('extractSubDailyPeriod - arrondit à la tranche de 6 heures', t => {
  t.is(extractSubDailyPeriod('2024-01-15', '00:00', '6 hours'), '2024-01-15 00:00')
  t.is(extractSubDailyPeriod('2024-01-15', '05:59', '6 hours'), '2024-01-15 00:00')
  t.is(extractSubDailyPeriod('2024-01-15', '06:00', '6 hours'), '2024-01-15 06:00')
  t.is(extractSubDailyPeriod('2024-01-15', '11:59', '6 hours'), '2024-01-15 06:00')
  t.is(extractSubDailyPeriod('2024-01-15', '12:00', '6 hours'), '2024-01-15 12:00')
  t.is(extractSubDailyPeriod('2024-01-15', '17:59', '6 hours'), '2024-01-15 12:00')
  t.is(extractSubDailyPeriod('2024-01-15', '18:00', '6 hours'), '2024-01-15 18:00')
  t.is(extractSubDailyPeriod('2024-01-15', '23:59', '6 hours'), '2024-01-15 18:00')
})

test('extractSubDailyPeriod - gère les heures avec secondes', t => {
  t.is(extractSubDailyPeriod('2024-01-15', '12:30:45', '1 hour'), '2024-01-15 12:00')
  t.is(extractSubDailyPeriod('2024-01-15', '12:07:30', '15 minutes'), '2024-01-15 12:00')
})

test('extractSubDailyPeriod - gère minuit', t => {
  t.is(extractSubDailyPeriod('2024-01-15', '00:00', '1 hour'), '2024-01-15 00:00')
  t.is(extractSubDailyPeriod('2024-01-15', '00:00', '15 minutes'), '2024-01-15 00:00')
  t.is(extractSubDailyPeriod('2024-01-15', '00:00', '6 hours'), '2024-01-15 00:00')
})

test('extractSubDailyPeriod - pad avec zéros pour heures < 10', t => {
  t.is(extractSubDailyPeriod('2024-01-15', '09:30', '1 hour'), '2024-01-15 09:00')
  t.is(extractSubDailyPeriod('2024-01-15', '01:07', '15 minutes'), '2024-01-15 01:00')
})

// Tests pour extractValuesFromDocument
test('extractValuesFromDocument - série journalière avec valeur simple', t => {
  const valueDoc = {
    date: '2024-01-15',
    values: {value: 100}
  }
  const context = {
    isSubDaily: false,
    useAggregates: false,
    operator: 'sum',
    valueType: 'cumulative',
    aggregationFrequency: '1 day'
  }
  const result = extractValuesFromDocument(valueDoc, context)
  t.deepEqual(result, [{period: '2024-01-15', value: 100}])
})

test('extractValuesFromDocument - série journalière avec valeur null ignore la valeur', t => {
  const valueDoc = {
    date: '2024-01-15',
    values: {value: null}
  }
  const context = {
    isSubDaily: false,
    useAggregates: false,
    operator: 'sum',
    valueType: 'cumulative',
    aggregationFrequency: '1 day'
  }
  const result = extractValuesFromDocument(valueDoc, context)
  t.deepEqual(result, [])
})

test('extractValuesFromDocument - série infra-journalière avec valeurs brutes', t => {
  const valueDoc = {
    date: '2024-01-15',
    values: [
      {time: '12:00', value: 10},
      {time: '12:15', value: 20},
      {time: '12:30', value: 30}
    ]
  }
  const context = {
    isSubDaily: true,
    useAggregates: false,
    operator: 'sum',
    valueType: 'instantaneous',
    aggregationFrequency: '1 day'
  }
  const result = extractValuesFromDocument(valueDoc, context)
  t.deepEqual(result, [
    {period: '2024-01-15', value: 10},
    {period: '2024-01-15', value: 20},
    {period: '2024-01-15', value: 30}
  ])
})

test('extractValuesFromDocument - série infra-journalière avec agrégation 15 minutes', t => {
  const valueDoc = {
    date: '2024-01-15',
    values: [
      {time: '12:00', value: 10},
      {time: '12:07', value: 15},
      {time: '12:15', value: 20},
      {time: '12:22', value: 25}
    ]
  }
  const context = {
    isSubDaily: true,
    useAggregates: false,
    operator: 'sum',
    valueType: 'instantaneous',
    aggregationFrequency: '15 minutes'
  }
  const result = extractValuesFromDocument(valueDoc, context)
  t.deepEqual(result, [
    {period: '2024-01-15 12:00', value: 10},
    {period: '2024-01-15 12:00', value: 15},
    {period: '2024-01-15 12:15', value: 20},
    {period: '2024-01-15 12:15', value: 25}
  ])
})

test('extractValuesFromDocument - série infra-journalière avec dailyAggregates sum cumulative', t => {
  const valueDoc = {
    date: '2024-01-15',
    dailyAggregates: {
      sum: 100,
      mean: 25,
      min: 10,
      max: 40,
      count: 4
    }
  }
  const context = {
    isSubDaily: true,
    useAggregates: true,
    operator: 'sum',
    valueType: 'cumulative',
    aggregationFrequency: '1 day'
  }
  const result = extractValuesFromDocument(valueDoc, context)
  t.deepEqual(result, [{period: '2024-01-15', value: 100}])
})

test('extractValuesFromDocument - série infra-journalière avec dailyAggregates sum instantaneous retourne vide', t => {
  const valueDoc = {
    date: '2024-01-15',
    dailyAggregates: {
      sum: 100,
      mean: 25,
      min: 10,
      max: 40,
      count: 4
    }
  }
  const context = {
    isSubDaily: true,
    useAggregates: true,
    operator: 'sum',
    valueType: 'instantaneous',
    aggregationFrequency: '1 day'
  }
  const result = extractValuesFromDocument(valueDoc, context)
  t.deepEqual(result, [])
})

test('extractValuesFromDocument - série infra-journalière avec dailyAggregates mean', t => {
  const valueDoc = {
    date: '2024-01-15',
    dailyAggregates: {
      sum: 100,
      mean: 25,
      min: 10,
      max: 40,
      count: 4
    }
  }
  const context = {
    isSubDaily: true,
    useAggregates: true,
    operator: 'mean',
    valueType: 'instantaneous',
    aggregationFrequency: '1 day'
  }
  const result = extractValuesFromDocument(valueDoc, context)
  t.deepEqual(result, [{period: '2024-01-15', value: 25}])
})

test('extractValuesFromDocument - série infra-journalière avec dailyAggregates min', t => {
  const valueDoc = {
    date: '2024-01-15',
    dailyAggregates: {
      sum: 100,
      mean: 25,
      min: 10,
      max: 40,
      count: 4
    }
  }
  const context = {
    isSubDaily: true,
    useAggregates: true,
    operator: 'min',
    valueType: 'instantaneous',
    aggregationFrequency: '1 day'
  }
  const result = extractValuesFromDocument(valueDoc, context)
  t.deepEqual(result, [{period: '2024-01-15', value: 10}])
})

test('extractValuesFromDocument - série infra-journalière avec dailyAggregates max', t => {
  const valueDoc = {
    date: '2024-01-15',
    dailyAggregates: {
      sum: 100,
      mean: 25,
      min: 10,
      max: 40,
      count: 4
    }
  }
  const context = {
    isSubDaily: true,
    useAggregates: true,
    operator: 'max',
    valueType: 'instantaneous',
    aggregationFrequency: '1 day'
  }
  const result = extractValuesFromDocument(valueDoc, context)
  t.deepEqual(result, [{period: '2024-01-15', value: 40}])
})

test('extractValuesFromDocument - série infra-journalière filtre les valeurs null', t => {
  const valueDoc = {
    date: '2024-01-15',
    values: [
      {time: '12:00', value: 10},
      {time: '12:15', value: null},
      {time: '12:30', value: 30}
    ]
  }
  const context = {
    isSubDaily: true,
    useAggregates: false,
    operator: 'sum',
    valueType: 'instantaneous',
    aggregationFrequency: '1 day'
  }
  const result = extractValuesFromDocument(valueDoc, context)
  t.deepEqual(result, [
    {period: '2024-01-15', value: 10},
    {period: '2024-01-15', value: 30}
  ])
})

test('extractValuesFromDocument - série infra-journalière avec values vide retourne tableau vide', t => {
  const valueDoc = {
    date: '2024-01-15',
    values: []
  }
  const context = {
    isSubDaily: true,
    useAggregates: false,
    operator: 'sum',
    valueType: 'instantaneous',
    aggregationFrequency: '1 day'
  }
  const result = extractValuesFromDocument(valueDoc, context)
  t.deepEqual(result, [])
})

test('extractValuesFromDocument - série infra-journalière sans dailyAggregates retourne vide', t => {
  const valueDoc = {
    date: '2024-01-15'
    // Pas de dailyAggregates ni values
  }
  const context = {
    isSubDaily: true,
    useAggregates: true,
    operator: 'mean',
    valueType: 'instantaneous',
    aggregationFrequency: '1 day'
  }
  const result = extractValuesFromDocument(valueDoc, context)
  t.deepEqual(result, [])
})

// ===== Tests pour la validation avec ObjectIds =====

test('validateQueryParams - accepte pointIds avec IDs numériques', t => {
  const result = validateQueryParams({
    pointIds: '1,2,3',
    parameter: 'volume prélevé',
    operator: 'sum'
  })
  t.is(result.pointIds, '1,2,3')
})

test('validateQueryParams - accepte pointIds avec ObjectIds valides', t => {
  const result = validateQueryParams({
    pointIds: '507f1f77bcf86cd799439011,507f191e810c19729de860ea',
    parameter: 'volume prélevé',
    operator: 'sum'
  })
  t.is(result.pointIds, '507f1f77bcf86cd799439011,507f191e810c19729de860ea')
})

test('validateQueryParams - accepte pointIds avec mix IDs numériques et ObjectIds', t => {
  const result = validateQueryParams({
    pointIds: '1,507f1f77bcf86cd799439011,3,507f191e810c19729de860ea',
    parameter: 'volume prélevé',
    operator: 'sum'
  })
  t.is(result.pointIds, '1,507f1f77bcf86cd799439011,3,507f191e810c19729de860ea')
})

test('validateQueryParams - rejette pointIds avec ObjectId invalide (trop court)', t => {
  const error = t.throws(() => {
    validateQueryParams({
      pointIds: '507f1f77bcf86cd79943901',
      parameter: 'volume prélevé',
      operator: 'sum'
    })
  })
  t.regex(error.message, /identifiants/)
})

test('validateQueryParams - rejette pointIds avec ObjectId invalide (caractères invalides)', t => {
  const error = t.throws(() => {
    validateQueryParams({
      pointIds: '507f1f77bcf86cd79943901z',
      parameter: 'volume prélevé',
      operator: 'sum'
    })
  })
  t.regex(error.message, /identifiants/)
})

test('validateQueryParams - rejette pointIds avec format mixte invalide', t => {
  const error = t.throws(() => {
    validateQueryParams({
      pointIds: '1,abc,3',
      parameter: 'volume prélevé',
      operator: 'sum'
    })
  })
  t.regex(error.message, /identifiants/)
})

test('validateQueryParams - accepte preleveurId numérique', t => {
  const result = validateQueryParams({
    preleveurId: 42,
    parameter: 'volume prélevé',
    operator: 'sum'
  })
  t.is(result.preleveurId, 42)
})

test('validateQueryParams - accepte preleveurId comme string numérique', t => {
  const result = validateQueryParams({
    preleveurId: '42',
    parameter: 'volume prélevé',
    operator: 'sum'
  })
  // Joi convertit automatiquement le string numérique en number
  t.true(result.preleveurId === 42 || result.preleveurId === '42')
})

test('validateQueryParams - accepte preleveurId comme ObjectId', t => {
  const result = validateQueryParams({
    preleveurId: '507f1f77bcf86cd799439011',
    parameter: 'volume prélevé',
    operator: 'sum'
  })
  t.is(result.preleveurId, '507f1f77bcf86cd799439011')
})

test('validateQueryParams - rejette preleveurId ObjectId invalide (trop court)', t => {
  const error = t.throws(() => {
    validateQueryParams({
      preleveurId: '507f1f77bcf86cd79943901',
      parameter: 'volume prélevé',
      operator: 'sum'
    })
  })
  t.regex(error.message, /pattern/)
})

test('validateQueryParams - rejette preleveurId ObjectId invalide (caractères invalides)', t => {
  const error = t.throws(() => {
    validateQueryParams({
      preleveurId: '507f1f77bcf86cd79943901z',
      parameter: 'volume prélevé',
      operator: 'sum'
    })
  })
  t.regex(error.message, /pattern/)
})

test('validateQueryParams - rejette preleveurId négatif', t => {
  const error = t.throws(() => {
    validateQueryParams({
      preleveurId: -5,
      parameter: 'volume prélevé',
      operator: 'sum'
    })
  })
  t.truthy(error)
})

test('validateQueryParams - rejette preleveurId zéro', t => {
  const error = t.throws(() => {
    validateQueryParams({
      preleveurId: 0,
      parameter: 'volume prélevé',
      operator: 'sum'
    })
  })
  t.truthy(error)
})

test('validateQueryParams - accepte pointIds et preleveurId ensemble (mode 3)', t => {
  const result = validateQueryParams({
    pointIds: '1,2,3',
    preleveurId: 42,
    parameter: 'volume prélevé',
    operator: 'sum'
  })
  t.is(result.pointIds, '1,2,3')
  t.is(result.preleveurId, 42)
})

test('validateQueryParams - accepte pointIds ObjectIds et preleveurId ObjectId ensemble', t => {
  const result = validateQueryParams({
    pointIds: '507f1f77bcf86cd799439011,507f191e810c19729de860ea',
    preleveurId: '507f1f77bcf86cd799439022',
    parameter: 'volume prélevé',
    operator: 'sum'
  })
  t.is(result.pointIds, '507f1f77bcf86cd799439011,507f191e810c19729de860ea')
  t.is(result.preleveurId, '507f1f77bcf86cd799439022')
})

test('validateQueryParams - accepte mix pointIds numériques/ObjectIds avec preleveurId numérique', t => {
  const result = validateQueryParams({
    pointIds: '1,507f1f77bcf86cd799439011,3',
    preleveurId: 42,
    parameter: 'volume prélevé',
    operator: 'sum'
  })
  t.is(result.pointIds, '1,507f1f77bcf86cd799439011,3')
  t.is(result.preleveurId, 42)
})

test('validateQueryParams - rejette si ni pointIds ni preleveurId', t => {
  const error = t.throws(() => {
    validateQueryParams({
      parameter: 'volume prélevé',
      operator: 'sum'
    })
  })
  t.regex(error.message, /au moins pointIds ou preleveurId/)
})

test('validateQueryParams - single pointId numérique valide', t => {
  const result = validateQueryParams({
    pointIds: '42',
    parameter: 'volume prélevé',
    operator: 'sum'
  })
  t.is(result.pointIds, '42')
})

test('validateQueryParams - single pointId ObjectId valide', t => {
  const result = validateQueryParams({
    pointIds: '507f1f77bcf86cd799439011',
    parameter: 'volume prélevé',
    operator: 'sum'
  })
  t.is(result.pointIds, '507f1f77bcf86cd799439011')
})

test('validateQueryParams - rejette pointIds vide', t => {
  const error = t.throws(() => {
    validateQueryParams({
      pointIds: '',
      parameter: 'volume prélevé',
      operator: 'sum'
    })
  })
  t.truthy(error)
})

test('validateQueryParams - rejette pointIds avec virgules multiples consécutives', t => {
  const error = t.throws(() => {
    validateQueryParams({
      pointIds: '1,,3',
      parameter: 'volume prélevé',
      operator: 'sum'
    })
  })
  t.regex(error.message, /identifiants/)
})

test('validateQueryParams - rejette pointIds commençant par virgule', t => {
  const error = t.throws(() => {
    validateQueryParams({
      pointIds: ',1,2',
      parameter: 'volume prélevé',
      operator: 'sum'
    })
  })
  t.regex(error.message, /identifiants/)
})

test('validateQueryParams - rejette pointIds finissant par virgule', t => {
  const error = t.throws(() => {
    validateQueryParams({
      pointIds: '1,2,',
      parameter: 'volume prélevé',
      operator: 'sum'
    })
  })
  t.regex(error.message, /identifiants/)
})

test('validateQueryParams - accepte ObjectIds en majuscules', t => {
  const result = validateQueryParams({
    pointIds: '507F1F77BCF86CD799439011',
    parameter: 'volume prélevé',
    operator: 'sum'
  })
  t.is(result.pointIds, '507F1F77BCF86CD799439011')
})

test('validateQueryParams - accepte ObjectIds en minuscules', t => {
  const result = validateQueryParams({
    pointIds: '507f1f77bcf86cd799439011',
    parameter: 'volume prélevé',
    operator: 'sum'
  })
  t.is(result.pointIds, '507f1f77bcf86cd799439011')
})

test('validateQueryParams - accepte ObjectIds mixtes maj/min', t => {
  const result = validateQueryParams({
    pointIds: '507f1F77BcF86cD799439011',
    parameter: 'volume prélevé',
    operator: 'sum'
  })
  t.is(result.pointIds, '507f1F77BcF86cD799439011')
})

test('validateQueryParams - rejette ObjectId avec 23 caractères', t => {
  const error = t.throws(() => {
    validateQueryParams({
      pointIds: '507f1f77bcf86cd79943901',
      parameter: 'volume prélevé',
      operator: 'sum'
    })
  })
  t.truthy(error)
})

test('validateQueryParams - rejette ObjectId avec 25 caractères', t => {
  const error = t.throws(() => {
    validateQueryParams({
      pointIds: '507f1f77bcf86cd7994390111',
      parameter: 'volume prélevé',
      operator: 'sum'
    })
  })
  t.truthy(error)
})

test('validateQueryParams - accepte très longue liste de pointIds numériques', t => {
  const longList = Array.from({length: 100}, (_, i) => i + 1).join(',')
  const result = validateQueryParams({
    pointIds: longList,
    parameter: 'volume prélevé',
    operator: 'sum'
  })
  t.is(result.pointIds, longList)
})

test('validateQueryParams - accepte très longue liste de pointIds ObjectIds', t => {
  const longList = Array.from({length: 50}, (_, i) =>
    `507f1f77bcf86cd79943${String(i).padStart(4, '0')}`
  ).join(',')
  const result = validateQueryParams({
    pointIds: longList,
    parameter: 'volume prélevé',
    operator: 'sum'
  })
  t.is(result.pointIds, longList)
})
