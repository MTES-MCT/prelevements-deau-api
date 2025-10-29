import test from 'ava'
import {applyAggregationOperator, aggregateValuesByPeriod} from '../series-aggregation.js'

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
