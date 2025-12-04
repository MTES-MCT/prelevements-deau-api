import test from 'ava'
import {ObjectId} from 'mongodb'
import {
  applyAggregationOperator,
  aggregateDailyValuesToPeriod,
  aggregateSpatialValues,
  validateQueryParams,
  extractPeriod,
  extractSubDailyPeriod,
  extractValuesFromDocument,
  filterPointsByIds,
  extractPointIdsFromSeries
} from '../series-aggregation.js'

// Tests pour filterPointsByIds
test('filterPointsByIds - filtre par IDs numériques', t => {
  const availablePoints = [
    {seqId: 100, objectId: new ObjectId(), point: {nom: 'Point A'}},
    {seqId: 200, objectId: new ObjectId(), point: {nom: 'Point B'}},
    {seqId: 300, objectId: new ObjectId(), point: {nom: 'Point C'}}
  ]

  const {found, notFound} = filterPointsByIds(availablePoints, ['100', '300'])

  t.is(found.length, 2)
  t.is(found[0].seqId, 100)
  t.is(found[1].seqId, 300)
  t.deepEqual(notFound, [])
})

test('filterPointsByIds - filtre par ObjectIds', t => {
  const oid1 = new ObjectId()
  const oid2 = new ObjectId()
  const oid3 = new ObjectId()

  const availablePoints = [
    {seqId: 100, objectId: oid1, point: {nom: 'Point A'}},
    {seqId: 200, objectId: oid2, point: {nom: 'Point B'}},
    {seqId: 300, objectId: oid3, point: {nom: 'Point C'}}
  ]

  const {found, notFound} = filterPointsByIds(availablePoints, [oid1.toString(), oid3.toString()])

  t.is(found.length, 2)
  t.is(found[0].objectId, oid1)
  t.is(found[1].objectId, oid3)
  t.deepEqual(notFound, [])
})

test('filterPointsByIds - avec IDs non trouvés', t => {
  const availablePoints = [
    {seqId: 100, objectId: new ObjectId(), point: {nom: 'Point A'}},
    {seqId: 200, objectId: new ObjectId(), point: {nom: 'Point B'}}
  ]

  const {found, notFound} = filterPointsByIds(availablePoints, ['100', '999', '888'])

  t.is(found.length, 1)
  t.is(found[0].seqId, 100)
  t.deepEqual(notFound, ['999', '888'])
})

test('filterPointsByIds - mélange IDs numériques et ObjectIds', t => {
  const oid1 = new ObjectId()
  const oid2 = new ObjectId()

  const availablePoints = [
    {seqId: 100, objectId: oid1, point: {nom: 'Point A'}},
    {seqId: 200, objectId: oid2, point: {nom: 'Point B'}}
  ]

  const {found, notFound} = filterPointsByIds(availablePoints, ['100', oid2.toString()])

  t.is(found.length, 2)
  t.is(found[0].seqId, 100)
  t.is(found[1].objectId, oid2)
  t.deepEqual(notFound, [])
})

test('filterPointsByIds - tous les IDs non trouvés', t => {
  const availablePoints = [
    {seqId: 100, objectId: new ObjectId(), point: {nom: 'Point A'}}
  ]

  const {found, notFound} = filterPointsByIds(availablePoints, ['999', '888'])

  t.is(found.length, 0)
  t.deepEqual(notFound, ['999', '888'])
})

test('filterPointsByIds - liste vide d\'IDs demandés', t => {
  const availablePoints = [
    {seqId: 100, objectId: new ObjectId(), point: {nom: 'Point A'}}
  ]

  const {found, notFound} = filterPointsByIds(availablePoints, [])

  t.is(found.length, 0)
  t.deepEqual(notFound, [])
})

// Tests pour extractPointIdsFromSeries
test('extractPointIdsFromSeries - extrait depuis computed.point', t => {
  const oid1 = new ObjectId()
  const oid2 = new ObjectId()

  const seriesList = [
    {parameter: 'volume prélevé', computed: {point: oid1}},
    {parameter: 'débit prélevé', computed: {point: oid2}}
  ]

  const result = extractPointIdsFromSeries(seriesList)

  t.is(result.length, 2)
  t.true(result.includes(oid1.toString()))
  t.true(result.includes(oid2.toString()))
})

test('extractPointIdsFromSeries - déduplique les IDs', t => {
  const oid1 = new ObjectId()

  const seriesList = [
    {parameter: 'volume prélevé', computed: {point: oid1}},
    {parameter: 'débit prélevé', computed: {point: oid1}},
    {parameter: 'température', computed: {point: oid1}}
  ]

  const result = extractPointIdsFromSeries(seriesList)

  t.is(result.length, 1)
  t.is(result[0], oid1.toString())
})

test('extractPointIdsFromSeries - ignore les séries sans point', t => {
  const oid1 = new ObjectId()

  const seriesList = [
    {parameter: 'volume prélevé', computed: {point: oid1}},
    {parameter: 'débit prélevé'}, // Pas de point
    {parameter: 'température', computed: {}} // Computed mais pas de point
  ]

  const result = extractPointIdsFromSeries(seriesList)

  t.is(result.length, 1)
  t.is(result[0], oid1.toString())
})

test('extractPointIdsFromSeries - liste vide', t => {
  const result = extractPointIdsFromSeries([])
  t.deepEqual(result, [])
})

// Tests pour l'opérateur 'sum'
test('applyAggregationOperator - sum avec valeurs valides', t => {
  const result = applyAggregationOperator([10, 20, 30], 'sum')
  t.is(result.value, 60)
})

test('applyAggregationOperator - sum avec un seul élément', t => {
  const result = applyAggregationOperator([42], 'sum')
  t.is(result.value, 42)
})

test('applyAggregationOperator - sum avec valeurs décimales', t => {
  const result = applyAggregationOperator([1.5, 2.3, 3.2], 'sum')
  t.is(Math.round(result.value * 10) / 10, 7)
})

test('applyAggregationOperator - sum avec valeurs négatives', t => {
  const result = applyAggregationOperator([10, -5, 15], 'sum')
  t.is(result.value, 20)
})

test('applyAggregationOperator - sum avec zéro', t => {
  const result = applyAggregationOperator([0, 0, 0], 'sum')
  t.is(result.value, 0)
})

// Tests pour l'opérateur 'mean'
test('applyAggregationOperator - mean avec valeurs valides', t => {
  const result = applyAggregationOperator([10, 20, 30], 'mean')
  t.is(result.value, 20)
})

test('applyAggregationOperator - mean avec un seul élément', t => {
  const result = applyAggregationOperator([42], 'mean')
  t.is(result.value, 42)
})

test('applyAggregationOperator - mean avec valeurs décimales', t => {
  const result = applyAggregationOperator([1, 2, 3, 4], 'mean')
  t.is(result.value, 2.5)
})

// Tests pour l'opérateur 'min'
test('applyAggregationOperator - min avec valeurs valides', t => {
  const result = applyAggregationOperator([10, 5, 30, 2], 'min')
  t.is(result.value, 2)
})

test('applyAggregationOperator - min avec valeurs négatives', t => {
  const result = applyAggregationOperator([10, -5, 15], 'min')
  t.is(result.value, -5)
})

test('applyAggregationOperator - min avec un seul élément', t => {
  const result = applyAggregationOperator([42], 'min')
  t.is(result.value, 42)
})

// Tests pour l'opérateur 'max'
test('applyAggregationOperator - max avec valeurs valides', t => {
  const result = applyAggregationOperator([10, 50, 30, 2], 'max')
  t.is(result.value, 50)
})

test('applyAggregationOperator - max avec valeurs négatives', t => {
  const result = applyAggregationOperator([-10, -5, -15], 'max')
  t.is(result.value, -5)
})

test('applyAggregationOperator - max avec un seul élément', t => {
  const result = applyAggregationOperator([42], 'max')
  t.is(result.value, 42)
})

// Tests avec valeurs invalides
test('applyAggregationOperator - sum avec null dans le tableau', t => {
  const result = applyAggregationOperator([10, null, 20, 30], 'sum')
  t.is(result.value, 60)
})

test('applyAggregationOperator - sum avec undefined dans le tableau', t => {
  const result = applyAggregationOperator([10, undefined, 20], 'sum')
  t.is(result.value, 30)
})

test('applyAggregationOperator - sum avec NaN dans le tableau', t => {
  const result = applyAggregationOperator([10, Number.NaN, 20], 'sum')
  t.is(result.value, 30)
})

test('applyAggregationOperator - sum avec Infinity dans le tableau', t => {
  const result = applyAggregationOperator([10, Number.POSITIVE_INFINITY, 20], 'sum')
  t.is(result.value, 30)
})

test('applyAggregationOperator - sum avec string dans le tableau', t => {
  const result = applyAggregationOperator([10, '20', 30], 'sum')
  t.is(result.value, 40)
})

test('applyAggregationOperator - mean avec valeurs mixtes valides/invalides', t => {
  const result = applyAggregationOperator([10, null, 20, undefined, 30, Number.NaN], 'mean')
  t.is(result.value, 20)
})

test('applyAggregationOperator - min avec valeurs mixtes', t => {
  const result = applyAggregationOperator([10, null, 5, undefined, 30], 'min')
  t.is(result.value, 5)
})

test('applyAggregationOperator - max avec valeurs mixtes', t => {
  const result = applyAggregationOperator([10, null, 5, undefined, 30], 'max')
  t.is(result.value, 30)
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
  t.is(result.value, 6e15)
})

test('applyAggregationOperator - sum avec très petits nombres', t => {
  const result = applyAggregationOperator([1e-10, 2e-10, 3e-10], 'sum')
  t.true(Math.abs(result.value - 6e-10) < 1e-20)
})

test('applyAggregationOperator - mean préserve la précision', t => {
  const result = applyAggregationOperator([1, 2, 3], 'mean')
  t.is(result.value, 2)
})

test('applyAggregationOperator - sum avec zéros et valeurs positives', t => {
  const result = applyAggregationOperator([0, 0, 10, 0, 20], 'sum')
  t.is(result.value, 30)
})

test('applyAggregationOperator - min avec zéro et valeurs positives', t => {
  const result = applyAggregationOperator([10, 0, 20], 'min')
  t.is(result.value, 0)
})

test('applyAggregationOperator - max avec zéro et valeurs négatives', t => {
  const result = applyAggregationOperator([-10, 0, -20], 'max')
  t.is(result.value, 0)
})

// Tests avec tableaux de grande taille
test('applyAggregationOperator - sum avec 1000 valeurs', t => {
  const values = Array.from({length: 1000}, (_, i) => i + 1)
  const result = applyAggregationOperator(values, 'sum')
  t.is(result.value, 500_500) // Formule: n(n+1)/2
})

test('applyAggregationOperator - mean avec 1000 valeurs', t => {
  const values = Array.from({length: 1000}, (_, i) => i + 1)
  const result = applyAggregationOperator(values, 'mean')
  t.is(result.value, 500.5)
})

test('applyAggregationOperator - min/max avec 1000 valeurs', t => {
  const values = Array.from({length: 1000}, (_, i) => i + 1)
  t.is(applyAggregationOperator(values, 'min').value, 1)
  t.is(applyAggregationOperator(values, 'max').value, 1000)
})

// Tests pour aggregateValuesByPeriod

// Tests avec frequency '1 day'
test('aggregateValuesByPeriod - 1 day retourne les valeurs inchangées', t => {
  const dailyValues = [
    {date: '2024-01-01', value: 10},
    {date: '2024-01-02', value: 20},
    {date: '2024-01-03', value: 30}
  ]
  const result = aggregateDailyValuesToPeriod(dailyValues, '1 day', 'sum')
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
  const result = aggregateDailyValuesToPeriod(dailyValues, '1 month', 'sum')
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
  const result = aggregateDailyValuesToPeriod(dailyValues, '1 month', 'mean')
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
  const minResult = aggregateDailyValuesToPeriod(dailyValues, '1 month', 'min')
  const maxResult = aggregateDailyValuesToPeriod(dailyValues, '1 month', 'max')

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
  const result = aggregateDailyValuesToPeriod(dailyValues, '1 year', 'sum')
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
  const result = aggregateDailyValuesToPeriod(dailyValues, '1 year', 'mean')
  t.is(result.length, 1)
  t.is(result[0].date, '2023')
  t.is(result[0].value, 20)
})

// Tests avec frequency '1 quarter'
test('aggregateValuesByPeriod - 1 quarter avec sum', t => {
  const dailyValues = [
    {date: '2024-01-01', value: 10},
    {date: '2024-02-15', value: 20},
    {date: '2024-03-31', value: 30},
    {date: '2024-04-01', value: 40},
    {date: '2024-06-30', value: 50},
    {date: '2024-07-01', value: 60},
    {date: '2024-10-01', value: 70}
  ]
  const result = aggregateDailyValuesToPeriod(dailyValues, '1 quarter', 'sum')
  t.deepEqual(result, [
    {date: '2024-Q1', value: 60},
    {date: '2024-Q2', value: 90},
    {date: '2024-Q3', value: 60},
    {date: '2024-Q4', value: 70}
  ])
})

test('aggregateValuesByPeriod - 1 quarter avec mean', t => {
  const dailyValues = [
    {date: '2024-01-15', value: 10},
    {date: '2024-02-15', value: 20},
    {date: '2024-04-15', value: 30}
  ]
  const result = aggregateDailyValuesToPeriod(dailyValues, '1 quarter', 'mean')
  t.is(result.length, 2)
  t.is(result[0].date, '2024-Q1')
  t.is(result[0].value, 15)
  t.is(result[1].date, '2024-Q2')
  t.is(result[1].value, 30)
})

test('aggregateValuesByPeriod - 1 quarter avec min/max', t => {
  const dailyValues = [
    {date: '2024-01-01', value: 10},
    {date: '2024-02-15', value: 50},
    {date: '2024-03-20', value: 30}
  ]
  const minResult = aggregateDailyValuesToPeriod(dailyValues, '1 quarter', 'min')
  const maxResult = aggregateDailyValuesToPeriod(dailyValues, '1 quarter', 'max')

  t.is(minResult[0].value, 10)
  t.is(maxResult[0].value, 50)
})

test('aggregateValuesByPeriod - 1 quarter sur plusieurs années', t => {
  const dailyValues = [
    {date: '2023-12-31', value: 100},
    {date: '2024-01-01', value: 200},
    {date: '2024-04-01', value: 300}
  ]
  const result = aggregateDailyValuesToPeriod(dailyValues, '1 quarter', 'sum')
  t.deepEqual(result, [
    {date: '2023-Q4', value: 100},
    {date: '2024-Q1', value: 200},
    {date: '2024-Q2', value: 300}
  ])
})

// Tests avec valeurs manquantes/nulles
test('aggregateValuesByPeriod - gère les valeurs nulles via applyAggregationOperator', t => {
  const dailyValues = [
    {date: '2024-01-01', value: 10},
    {date: '2024-01-02', value: null},
    {date: '2024-01-03', value: 20}
  ]
  // ApplyAggregationOperator filtre les nulls, donc on devrait avoir 30
  const result = aggregateDailyValuesToPeriod(dailyValues, '1 month', 'sum')
  t.is(result[0].value, 30)
})

// Tests avec tableau vide
test('aggregateValuesByPeriod - tableau vide retourne tableau vide', t => {
  const result = aggregateDailyValuesToPeriod([], '1 month', 'sum')
  t.deepEqual(result, [])
})

// Tests avec tri
test('aggregateValuesByPeriod - retourne les périodes triées', t => {
  const dailyValues = [
    {date: '2024-03-01', value: 30},
    {date: '2024-01-01', value: 10},
    {date: '2024-02-01', value: 20}
  ]
  const result = aggregateDailyValuesToPeriod(dailyValues, '1 month', 'sum')
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

test('validateQueryParams - accepte aggregationFrequency 1 quarter', t => {
  const result = validateQueryParams({
    pointIds: '207,208',
    parameter: 'volume prélevé',
    aggregationFrequency: '1 quarter'
  })
  t.is(result.aggregationFrequency, '1 quarter')
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

test('extractPeriod - extrait le trimestre au format YYYY-QN', t => {
  t.is(extractPeriod('2024-01-15', '1 quarter'), '2024-Q1')
  t.is(extractPeriod('2024-02-28', '1 quarter'), '2024-Q1')
  t.is(extractPeriod('2024-03-31', '1 quarter'), '2024-Q1')
  t.is(extractPeriod('2024-04-01', '1 quarter'), '2024-Q2')
  t.is(extractPeriod('2024-06-30', '1 quarter'), '2024-Q2')
  t.is(extractPeriod('2024-07-15', '1 quarter'), '2024-Q3')
  t.is(extractPeriod('2024-09-30', '1 quarter'), '2024-Q3')
  t.is(extractPeriod('2024-10-01', '1 quarter'), '2024-Q4')
  t.is(extractPeriod('2024-12-31', '1 quarter'), '2024-Q4')
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

test('extractPeriod - rejette un mois invalide pour 1 quarter', t => {
  const error = t.throws(() => {
    extractPeriod('2024-13-01', '1 quarter')
  })
  t.is(error.message, 'Invalid month value: 13 in date: 2024-13-01')
})

test('extractPeriod - rejette un mois zéro pour 1 quarter', t => {
  const error = t.throws(() => {
    extractPeriod('2024-00-01', '1 quarter')
  })
  t.is(error.message, 'Invalid month value: 0 in date: 2024-00-01')
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
    temporalOperator: 'mean',
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
    temporalOperator: 'min',
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
    temporalOperator: 'max',
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
  t.regex(error.message, /au moins pointIds, preleveurId ou attachmentId/)
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

// Tests pour la gestion des remarques dans applyAggregationOperator

test('applyAggregationOperator - sum avec objets {value, remark}', t => {
  const items = [
    {value: 10, remark: 'Estimation'},
    {value: 20, remark: 'Compteur défectueux'},
    {value: 30}
  ]
  const result = applyAggregationOperator(items, 'sum')
  t.is(result.value, 60)
  t.truthy(result.remarks)
  t.is(result.remarks.length, 2)
  t.true(result.remarks.includes('Estimation'))
  t.true(result.remarks.includes('Compteur défectueux'))
})

test('applyAggregationOperator - compile uniqueRemarks depuis dailyAggregates', t => {
  const items = [
    {value: 10, remarks: ['Estimation', 'Valeur partielle']},
    {value: 20, remarks: ['Capteur défectueux']},
    {value: 30}
  ]
  const result = applyAggregationOperator(items, 'sum')
  t.is(result.value, 60)
  t.truthy(result.remarks)
  t.is(result.remarks.length, 3)
  t.true(result.remarks.includes('Estimation'))
  t.true(result.remarks.includes('Valeur partielle'))
  t.true(result.remarks.includes('Capteur défectueux'))
})

test('applyAggregationOperator - limite à 10 remarques uniques', t => {
  const items = Array.from({length: 15}, (_, i) => ({
    value: 10,
    remark: `Remarque ${i}`
  }))
  const result = applyAggregationOperator(items, 'sum')
  t.is(result.value, 150)
  t.truthy(result.remarks)
  t.is(result.remarks.length, 10) // Limité à 10
})

test('applyAggregationOperator - déduplique les remarques identiques', t => {
  const items = [
    {value: 10, remark: 'Estimation'},
    {value: 20, remark: 'Estimation'},
    {value: 30, remark: 'Compteur défectueux'}
  ]
  const result = applyAggregationOperator(items, 'sum')
  t.is(result.value, 60)
  t.truthy(result.remarks)
  t.is(result.remarks.length, 2) // Seulement 2 remarques uniques
  t.true(result.remarks.includes('Estimation'))
  t.true(result.remarks.includes('Compteur défectueux'))
})

test('applyAggregationOperator - pas de remarques si aucune fournie', t => {
  const items = [
    {value: 10},
    {value: 20},
    {value: 30}
  ]
  const result = applyAggregationOperator(items, 'sum')
  t.is(result.value, 60)
  t.falsy(result.remarks) // Pas de champ remarks
})

test('applyAggregationOperator - mean avec remarques', t => {
  const items = [
    {value: 10, remark: 'Estimation'},
    {value: 20},
    {value: 30, remark: 'Validation'}
  ]
  const result = applyAggregationOperator(items, 'mean')
  t.is(result.value, 20)
  t.is(result.remarks.length, 2)
})

test('applyAggregationOperator - min/max préservent les remarques', t => {
  const items = [
    {value: 10, remark: 'Minimum'},
    {value: 50, remark: 'Maximum'},
    {value: 30}
  ]
  const minResult = applyAggregationOperator(items, 'min')
  const maxResult = applyAggregationOperator(items, 'max')

  t.is(minResult.value, 10)
  t.is(maxResult.value, 50)
  t.is(minResult.remarks.length, 2)
  t.is(maxResult.remarks.length, 2)
})

// Tests pour la gestion des remarques dans aggregateValuesByPeriod

test('aggregateValuesByPeriod - propage les remarques mensuelles', t => {
  const dailyValues = [
    {date: '2024-01-01', value: 10, remarks: ['Estimation']},
    {date: '2024-01-15', value: 20, remarks: ['Compteur défectueux']},
    {date: '2024-02-01', value: 30}
  ]
  const result = aggregateDailyValuesToPeriod(dailyValues, '1 month', 'sum')

  t.is(result[0].date, '2024-01')
  t.is(result[0].value, 30)
  t.truthy(result[0].remarks)
  t.is(result[0].remarks.length, 2)

  t.is(result[1].date, '2024-02')
  t.is(result[1].value, 30)
  t.falsy(result[1].remarks) // Pas de remarques
})

test('aggregateValuesByPeriod - limite à 10 remarques uniques par période', t => {
  const dailyValues = Array.from({length: 15}, (_, i) => ({
    date: '2024-01-01',
    value: 10,
    remarks: [`Remarque ${i}`]
  }))

  const result = aggregateDailyValuesToPeriod(dailyValues, '1 month', 'sum')
  t.is(result[0].remarks.length, 10) // Limité à 10
})

test('aggregateValuesByPeriod - agrégation annuelle avec remarques', t => {
  const dailyValues = [
    {date: '2024-01-01', value: 100, remarks: ['Remarque Q1']},
    {date: '2024-06-15', value: 200, remarks: ['Remarque Q2']},
    {date: '2024-12-31', value: 300, remarks: ['Remarque Q4']}
  ]
  const result = aggregateDailyValuesToPeriod(dailyValues, '1 year', 'sum')

  t.is(result[0].date, '2024')
  t.is(result[0].value, 600)
  t.truthy(result[0].remarks)
  t.is(result[0].remarks.length, 3)
})

test('aggregateValuesByPeriod - agrégation trimestrielle avec remarques', t => {
  const dailyValues = [
    {date: '2024-01-01', value: 10, remarks: ['Janvier']},
    {date: '2024-02-15', value: 20, remarks: ['Février']},
    {date: '2024-04-01', value: 30, remarks: ['Avril']}
  ]
  const result = aggregateDailyValuesToPeriod(dailyValues, '1 quarter', 'sum')

  t.is(result[0].date, '2024-Q1')
  t.is(result[0].value, 30)
  t.is(result[0].remarks.length, 2)

  t.is(result[1].date, '2024-Q2')
  t.is(result[1].value, 30)
  t.is(result[1].remarks.length, 1)
})

test('aggregateValuesByPeriod - frequency 1 day préserve les remarques', t => {
  const dailyValues = [
    {date: '2024-01-01', value: 10, remarks: ['Estimation']},
    {date: '2024-01-02', value: 20}
  ]
  const result = aggregateDailyValuesToPeriod(dailyValues, '1 day', 'sum')

  // Les valeurs sont inchangées
  t.deepEqual(result, dailyValues)
})

// Tests pour extractValuesFromDocument avec remarques

test('extractValuesFromDocument - série journalière avec remark', t => {
  const valueDoc = {
    date: '2024-01-15',
    values: {
      value: 100,
      remark: 'Estimation'
    }
  }

  const context = {
    isSubDaily: false,
    useAggregates: false,
    aggregationFrequency: '1 day',
    temporalOperator: 'sum'
  }

  const result = extractValuesFromDocument(valueDoc, context)

  t.is(result.length, 1)
  t.is(result[0].period, '2024-01-15')
  t.is(result[0].value, 100)
  t.is(result[0].remark, 'Estimation')
})

test('extractValuesFromDocument - série journalière sans remark', t => {
  const valueDoc = {
    date: '2024-01-15',
    values: {
      value: 100
    }
  }

  const context = {
    isSubDaily: false,
    useAggregates: false,
    aggregationFrequency: '1 day',
    temporalOperator: 'sum'
  }

  const result = extractValuesFromDocument(valueDoc, context)

  t.is(result.length, 1)
  t.is(result[0].period, '2024-01-15')
  t.is(result[0].value, 100)
  t.falsy(result[0].remark)
})

test('extractValuesFromDocument - série infra-journalière avec remarques', t => {
  const valueDoc = {
    date: '2024-01-15',
    values: [
      {time: '10:00', value: 50, remark: 'Capteur défectueux'},
      {time: '11:00', value: 55},
      {time: '12:00', value: 60, remark: 'Estimation'}
    ]
  }

  const context = {
    isSubDaily: true,
    useAggregates: false,
    aggregationFrequency: '1 day',
    temporalOperator: 'mean'
  }

  const result = extractValuesFromDocument(valueDoc, context)

  t.is(result.length, 3)
  t.is(result[0].remark, 'Capteur défectueux')
  t.falsy(result[1].remark)
  t.is(result[2].remark, 'Estimation')
})

test('extractValuesFromDocument - dailyAggregates avec remarques', t => {
  const valueDoc = {
    date: '2024-01-15',
    dailyAggregates: {
      mean: 52.5,
      min: 50,
      max: 60,
      hasRemark: true,
      uniqueRemarks: ['Capteur défectueux', 'Estimation']
    }
  }

  const context = {
    isSubDaily: true,
    useAggregates: true,
    aggregationFrequency: '1 month',
    temporalOperator: 'mean'
  }

  const result = extractValuesFromDocument(valueDoc, context)

  t.is(result.length, 1)
  t.is(result[0].period, '2024-01-15')
  t.is(result[0].value, 52.5)
  t.truthy(result[0].remarks)
  t.is(result[0].remarks.length, 2)
  t.true(result[0].remarks.includes('Capteur défectueux'))
  t.true(result[0].remarks.includes('Estimation'))
})

test('extractValuesFromDocument - dailyAggregates sans remarques', t => {
  const valueDoc = {
    date: '2024-01-15',
    dailyAggregates: {
      mean: 52.5,
      min: 50,
      max: 60
    }
  }

  const context = {
    isSubDaily: true,
    useAggregates: true,
    aggregationFrequency: '1 month',
    temporalOperator: 'mean'
  }

  const result = extractValuesFromDocument(valueDoc, context)

  t.is(result.length, 1)
  t.falsy(result[0].remarks)
})

// Tests pour aggregateSpatialValues
test('aggregateSpatialValues - avec spatialOperator et une valeur', t => {
  const items = [{value: 42, remarks: ['test']}]
  const result = aggregateSpatialValues(items, '2024-01', 'sum', 'mean')

  t.is(result.date, '2024-01')
  t.is(result.value, 42)
  t.deepEqual(result.remarks, ['test'])
})

test('aggregateSpatialValues - avec spatialOperator et plusieurs valeurs', t => {
  const items = [{value: 10}, {value: 20}, {value: 30}]
  const result = aggregateSpatialValues(items, '2024-01', 'sum', 'mean')

  t.is(result.date, '2024-01')
  t.is(result.value, 60)
})

test('aggregateSpatialValues - sans spatialOperator et une valeur', t => {
  const items = [{value: 42, remarks: ['test']}]
  const result = aggregateSpatialValues(items, '2024-01', null, 'mean')

  t.is(result.date, '2024-01')
  t.is(result.value, 42)
  t.deepEqual(result.remarks, ['test'])
})

test('aggregateSpatialValues - sans spatialOperator et plusieurs valeurs (fallback temporalOperator)', t => {
  const items = [{value: 10}, {value: 20}, {value: 30}]
  const result = aggregateSpatialValues(items, '2024-01', null, 'mean')

  t.is(result.date, '2024-01')
  t.is(result.value, 20) // Mean de 10, 20, 30
})

test('aggregateSpatialValues - retourne null si aucune valeur valide', t => {
  const items = [{value: null}, {value: undefined}]
  const result = aggregateSpatialValues(items, '2024-01', 'sum', 'mean')

  t.is(result, null)
})

test('aggregateSpatialValues - préserve les remarques avec spatialOperator null', t => {
  const items = [
    {value: 10, remarks: ['remarque1']},
    {value: 20, remarks: ['remarque2']}
  ]
  const result = aggregateSpatialValues(items, '2024-01', null, 'mean')

  t.is(result.value, 15)
  t.is(result.remarks.length, 2)
  t.true(result.remarks.includes('remarque1'))
  t.true(result.remarks.includes('remarque2'))
})
