import test from 'ava'
import {
  calculateMinMaxFromDates,
  calculateDateRangeFromIntegratedDays,
  calculateDateRangeFromMinMax,
  groupSeriesByParameter
} from '../series-aggregation-options.js'

/**
 * Tests pour les fonctions utilitaires du handler series-aggregation-options
 * Ces tests valident la logique de calcul des plages de dates et le groupement par paramètre
 */

// Tests de la fonction utilitaire calculateMinMaxFromDates
test('calculateMinMaxFromDates - retourne null si tableau vide', t => {
  const result = calculateMinMaxFromDates([])
  t.is(result.minDate, null)
  t.is(result.maxDate, null)
})

test('calculateMinMaxFromDates - retourne null si toutes les dates sont null/undefined', t => {
  const result = calculateMinMaxFromDates([null, undefined, null])
  t.is(result.minDate, null)
  t.is(result.maxDate, null)
})

test('calculateMinMaxFromDates - gère une seule date', t => {
  const result = calculateMinMaxFromDates(['2023-06-15'])
  t.is(result.minDate, '2023-06-15')
  t.is(result.maxDate, '2023-06-15')
})

test('calculateMinMaxFromDates - calcule min/max avec plusieurs dates', t => {
  const result = calculateMinMaxFromDates(['2023-01-10', '2023-01-05', '2023-01-20'])
  t.is(result.minDate, '2023-01-05')
  t.is(result.maxDate, '2023-01-20')
})

test('calculateMinMaxFromDates - gère les dates non triées', t => {
  const result = calculateMinMaxFromDates(['2023-12-31', '2023-01-01', '2023-06-15'])
  t.is(result.minDate, '2023-01-01')
  t.is(result.maxDate, '2023-12-31')
})

test('calculateMinMaxFromDates - gère les dates en double', t => {
  const result = calculateMinMaxFromDates(['2023-01-01', '2023-01-01', '2023-01-10'])
  t.is(result.minDate, '2023-01-01')
  t.is(result.maxDate, '2023-01-10')
})

test('calculateMinMaxFromDates - ignore les valeurs null/undefined', t => {
  const result = calculateMinMaxFromDates(['2023-01-01', null, '2023-01-10', undefined, '2023-01-05'])
  t.is(result.minDate, '2023-01-01')
  t.is(result.maxDate, '2023-01-10')
})

test('calculateMinMaxFromDates - gère plusieurs années', t => {
  const result = calculateMinMaxFromDates(['2022-12-31', '2023-01-01', '2024-01-01'])
  t.is(result.minDate, '2022-12-31')
  t.is(result.maxDate, '2024-01-01')
})

test('calculateMinMaxFromDates - préserve le format YYYY-MM-DD', t => {
  const result = calculateMinMaxFromDates(['2023-01-01', '2023-12-31'])
  t.regex(result.minDate, /^\d{4}-\d{2}-\d{2}$/)
  t.regex(result.maxDate, /^\d{4}-\d{2}-\d{2}$/)
})

// Tests du calcul des dates min/max depuis minDate/maxDate
test('calculateDateRangeFromMinMax - retourne null si aucune série', t => {
  const result = calculateDateRangeFromMinMax([])
  t.is(result.minDate, null)
  t.is(result.maxDate, null)
})

test('calculateDateRangeFromMinMax - retourne null si pas de minDate/maxDate', t => {
  const series = [
    {parameter: 'volume prélevé'},
    {parameter: 'débit prélevé'}
  ]
  const result = calculateDateRangeFromMinMax(series)
  t.is(result.minDate, null)
  t.is(result.maxDate, null)
})

test('calculateDateRangeFromMinMax - calcule avec une seule série', t => {
  const series = [
    {
      parameter: 'volume prélevé',
      minDate: '2023-01-01',
      maxDate: '2023-01-10'
    }
  ]
  const result = calculateDateRangeFromMinMax(series)
  t.is(result.minDate, '2023-01-01')
  t.is(result.maxDate, '2023-01-10')
})

test('calculateDateRangeFromMinMax - calcule avec plusieurs séries', t => {
  const series = [
    {parameter: 'volume prélevé', minDate: '2023-01-10', maxDate: '2023-01-15'},
    {parameter: 'débit prélevé', minDate: '2023-01-01', maxDate: '2023-01-05'},
    {parameter: 'température', minDate: '2023-01-20', maxDate: '2023-01-25'}
  ]
  const result = calculateDateRangeFromMinMax(series)
  t.is(result.minDate, '2023-01-01')
  t.is(result.maxDate, '2023-01-25')
})

test('calculateDateRangeFromMinMax - gère les séries avec dates manquantes', t => {
  const series = [
    {parameter: 'volume prélevé', minDate: '2023-01-01'},
    {parameter: 'débit prélevé', maxDate: '2023-01-20'},
    {parameter: 'température', minDate: '2023-01-05', maxDate: '2023-01-15'}
  ]
  const result = calculateDateRangeFromMinMax(series)
  t.is(result.minDate, '2023-01-01')
  t.is(result.maxDate, '2023-01-20')
})

test('calculateDateRangeFromMinMax - gère les séries mixtes (avec et sans dates)', t => {
  const series = [
    {parameter: 'volume prélevé', minDate: '2023-01-01', maxDate: '2023-01-10'},
    {parameter: 'débit prélevé'},
    {parameter: 'température', minDate: '2023-01-05', maxDate: '2023-01-20'}
  ]
  const result = calculateDateRangeFromMinMax(series)
  t.is(result.minDate, '2023-01-01')
  t.is(result.maxDate, '2023-01-20')
})

test('calculateDateRangeFromMinMax - gère plusieurs années', t => {
  const series = [
    {parameter: 'volume prélevé', minDate: '2022-12-31', maxDate: '2024-01-01'}
  ]
  const result = calculateDateRangeFromMinMax(series)
  t.is(result.minDate, '2022-12-31')
  t.is(result.maxDate, '2024-01-01')
})

test('calculateDateRangeFromMinMax - gère les dates identiques', t => {
  const series = [
    {parameter: 'volume prélevé', minDate: '2023-01-15', maxDate: '2023-01-15'}
  ]
  const result = calculateDateRangeFromMinMax(series)
  t.is(result.minDate, '2023-01-15')
  t.is(result.maxDate, '2023-01-15')
})

test('calculateDateRangeFromMinMax - préserve le format YYYY-MM-DD', t => {
  const series = [
    {parameter: 'volume prélevé', minDate: '2023-01-01', maxDate: '2023-12-31'}
  ]
  const result = calculateDateRangeFromMinMax(series)
  t.regex(result.minDate, /^\d{4}-\d{2}-\d{2}$/)
  t.regex(result.maxDate, /^\d{4}-\d{2}-\d{2}$/)
})

// Tests du calcul des dates min/max depuis integratedDays
test('calculateDateRangeFromIntegratedDays - retourne null si aucune série', t => {
  const result = calculateDateRangeFromIntegratedDays([])
  t.is(result.minDate, null)
  t.is(result.maxDate, null)
})

test('calculateDateRangeFromIntegratedDays - retourne null si pas de integratedDays', t => {
  const series = [
    {parameter: 'volume prélevé', computed: {}},
    {parameter: 'débit prélevé', computed: {}}
  ]
  const result = calculateDateRangeFromIntegratedDays(series)
  t.is(result.minDate, null)
  t.is(result.maxDate, null)
})

test('calculateDateRangeFromIntegratedDays - calcule min/max avec une seule série', t => {
  const series = [
    {
      parameter: 'volume prélevé',
      computed: {integratedDays: ['2023-01-05', '2023-01-10', '2023-01-01']}
    }
  ]
  const result = calculateDateRangeFromIntegratedDays(series)
  t.is(result.minDate, '2023-01-01')
  t.is(result.maxDate, '2023-01-10')
})

test('calculateDateRangeFromIntegratedDays - calcule min/max avec plusieurs séries', t => {
  const series = [
    {
      parameter: 'volume prélevé',
      computed: {integratedDays: ['2023-01-10', '2023-01-15']}
    },
    {
      parameter: 'volume prélevé',
      computed: {integratedDays: ['2023-01-01', '2023-01-05']}
    },
    {
      parameter: 'volume prélevé',
      computed: {integratedDays: ['2023-01-20', '2023-01-25']}
    }
  ]
  const result = calculateDateRangeFromIntegratedDays(series)
  t.is(result.minDate, '2023-01-01')
  t.is(result.maxDate, '2023-01-25')
})

test('calculateDateRangeFromIntegratedDays - gère les dates non triées', t => {
  const series = [
    {
      parameter: 'volume prélevé',
      computed: {integratedDays: ['2023-12-31', '2023-01-01', '2023-06-15']}
    }
  ]
  const result = calculateDateRangeFromIntegratedDays(series)
  t.is(result.minDate, '2023-01-01')
  t.is(result.maxDate, '2023-12-31')
})

test('calculateDateRangeFromIntegratedDays - gère les dates en double', t => {
  const series = [
    {
      parameter: 'volume prélevé',
      computed: {integratedDays: ['2023-01-01', '2023-01-01', '2023-01-10', '2023-01-10']}
    }
  ]
  const result = calculateDateRangeFromIntegratedDays(series)
  t.is(result.minDate, '2023-01-01')
  t.is(result.maxDate, '2023-01-10')
})

test('calculateDateRangeFromIntegratedDays - gère les séries avec integratedDays vides', t => {
  const series = [
    {
      parameter: 'volume prélevé',
      computed: {integratedDays: []}
    },
    {
      parameter: 'débit prélevé',
      computed: {integratedDays: ['2023-01-01']}
    }
  ]
  const result = calculateDateRangeFromIntegratedDays(series)
  t.is(result.minDate, '2023-01-01')
  t.is(result.maxDate, '2023-01-01')
})

test('calculateDateRangeFromIntegratedDays - ignore les séries sans computed', t => {
  const series = [
    {parameter: 'volume prélevé'},
    {
      parameter: 'débit prélevé',
      computed: {integratedDays: ['2023-01-01', '2023-01-10']}
    }
  ]
  const result = calculateDateRangeFromIntegratedDays(series)
  t.is(result.minDate, '2023-01-01')
  t.is(result.maxDate, '2023-01-10')
})

// Tests avec dates sur plusieurs années
test('calculateDateRangeFromIntegratedDays - gère plusieurs années', t => {
  const series = [
    {
      parameter: 'volume prélevé',
      computed: {integratedDays: ['2022-12-31', '2023-01-01', '2024-01-01']}
    }
  ]
  const result = calculateDateRangeFromIntegratedDays(series)
  t.is(result.minDate, '2022-12-31')
  t.is(result.maxDate, '2024-01-01')
})

// Tests avec une seule date
test('calculateDateRangeFromIntegratedDays - gère une seule date', t => {
  const series = [
    {
      parameter: 'volume prélevé',
      computed: {integratedDays: ['2023-01-15']}
    }
  ]
  const result = calculateDateRangeFromIntegratedDays(series)
  t.is(result.minDate, '2023-01-15')
  t.is(result.maxDate, '2023-01-15')
})

// Tests avec des séries mixtes (certaines avec integratedDays, d'autres sans)
test('calculateDateRangeFromIntegratedDays - gère séries mixtes', t => {
  const series = [
    {
      parameter: 'volume prélevé',
      computed: {integratedDays: ['2023-01-01', '2023-01-10']}
    },
    {
      parameter: 'débit prélevé',
      computed: {}
    },
    {
      parameter: 'température',
      computed: {integratedDays: ['2023-01-05', '2023-01-20']}
    },
    {
      parameter: 'pH'
    }
  ]
  const result = calculateDateRangeFromIntegratedDays(series)
  t.is(result.minDate, '2023-01-01')
  t.is(result.maxDate, '2023-01-20')
})

// Tests de format de dates
test('calculateDateRangeFromIntegratedDays - préserve le format YYYY-MM-DD', t => {
  const series = [
    {
      parameter: 'volume prélevé',
      computed: {integratedDays: ['2023-01-01', '2023-12-31']}
    }
  ]
  const result = calculateDateRangeFromIntegratedDays(series)
  t.regex(result.minDate, /^\d{4}-\d{2}-\d{2}$/)
  t.regex(result.maxDate, /^\d{4}-\d{2}-\d{2}$/)
})

// Tests de tri correct des dates
test('calculateDateRangeFromIntegratedDays - tri correct des dates avec mois variés', t => {
  const series = [
    {
      parameter: 'volume prélevé',
      computed: {integratedDays: ['2023-11-15', '2023-02-10', '2023-09-05', '2023-01-20']}
    }
  ]
  const result = calculateDateRangeFromIntegratedDays(series)
  t.is(result.minDate, '2023-01-20')
  t.is(result.maxDate, '2023-11-15')
})

// Tests edge case avec integratedDays non array
test('calculateDateRangeFromIntegratedDays - ignore integratedDays qui n\'est pas un array', t => {
  const series = [
    {
      parameter: 'volume prélevé',
      computed: {integratedDays: 'not-an-array'}
    },
    {
      parameter: 'débit prélevé',
      computed: {integratedDays: ['2023-01-01']}
    }
  ]
  const result = calculateDateRangeFromIntegratedDays(series)
  t.is(result.minDate, '2023-01-01')
  t.is(result.maxDate, '2023-01-01')
})

// Tests de groupSeriesByParameter
test('groupSeriesByParameter - retourne tableau vide si aucune série', t => {
  const result = groupSeriesByParameter([])
  t.deepEqual(result, [])
})

test('groupSeriesByParameter - regroupe séries par paramètre avec integratedDays', t => {
  const series = [
    {
      _id: 'series1',
      parameter: 'volume prélevé',
      computed: {integratedDays: ['2023-01-01', '2023-01-10']}
    },
    {
      _id: 'series2',
      parameter: 'volume prélevé',
      computed: {integratedDays: ['2023-01-05', '2023-01-15']}
    }
  ]
  const result = groupSeriesByParameter(series, true)

  t.is(result.length, 1)
  t.is(result[0].name, 'volume prélevé')
  t.is(result[0].minDate, '2023-01-01')
  t.is(result[0].maxDate, '2023-01-15')
  t.is(result[0].seriesCount, 2)
  t.is(result[0].hasTemporalOverlap, false)
  t.deepEqual(result[0].spatialOperators, ['sum'])
  t.deepEqual(result[0].temporalOperators, ['sum'])
})

test('groupSeriesByParameter - regroupe séries par paramètre avec minDate/maxDate', t => {
  const series = [
    {
      parameter: 'volume prélevé',
      minDate: '2023-01-01',
      maxDate: '2023-01-10'
    },
    {
      parameter: 'volume prélevé',
      minDate: '2023-01-05',
      maxDate: '2023-01-15'
    }
  ]
  const result = groupSeriesByParameter(series, false)

  t.is(result.length, 1)
  t.is(result[0].name, 'volume prélevé')
  t.is(result[0].minDate, '2023-01-01')
  t.is(result[0].maxDate, '2023-01-15')
  t.is(result[0].seriesCount, 2)
  t.is(result[0].hasTemporalOverlap, false)
})

test('groupSeriesByParameter - regroupe plusieurs paramètres différents', t => {
  const series = [
    {
      _id: 'series1',
      parameter: 'volume prélevé',
      computed: {integratedDays: ['2023-01-01']}
    },
    {
      _id: 'series2',
      parameter: 'débit prélevé',
      computed: {integratedDays: ['2023-01-05']}
    },
    {
      _id: 'series3',
      parameter: 'température',
      computed: {integratedDays: ['2023-01-10']}
    }
  ]
  const result = groupSeriesByParameter(series, true)

  t.is(result.length, 3)
  // Vérifie le tri alphabétique
  t.is(result[0].name, 'débit prélevé')
  t.is(result[1].name, 'température')
  t.is(result[2].name, 'volume prélevé')
})

test('groupSeriesByParameter - ignore les paramètres non configurés', t => {
  const series = [
    {
      _id: 'series1',
      parameter: 'volume prélevé',
      computed: {integratedDays: ['2023-01-01']}
    },
    {
      _id: 'series2',
      parameter: 'paramètre inconnu',
      computed: {integratedDays: ['2023-01-05']}
    }
  ]
  const result = groupSeriesByParameter(series, true)

  t.is(result.length, 1)
  t.is(result[0].name, 'volume prélevé')
})

test('groupSeriesByParameter - détecte overlap temporel', t => {
  const series = [
    {
      _id: 'series1',
      parameter: 'volume prélevé',
      computed: {integratedDays: ['2023-01-01', '2023-01-02']}
    },
    {
      _id: 'series2',
      parameter: 'volume prélevé',
      computed: {integratedDays: ['2023-01-02', '2023-01-03']}
    }
  ]
  const result = groupSeriesByParameter(series, true)

  t.is(result.length, 1)
  t.is(result[0].hasTemporalOverlap, true)
})

test('groupSeriesByParameter - filtre paramètre avec overlap et sans spatialOperators', t => {
  const series = [
    {
      _id: 'series1',
      parameter: 'température',
      computed: {integratedDays: ['2023-01-01', '2023-01-02']}
    },
    {
      _id: 'series2',
      parameter: 'température',
      computed: {integratedDays: ['2023-01-02', '2023-01-03']}
    },
    {
      _id: 'series3',
      parameter: 'volume prélevé',
      computed: {integratedDays: ['2023-01-01', '2023-01-02']}
    }
  ]
  const result = groupSeriesByParameter(series, true)

  // Température doit être filtré (overlap + spatialOperators vide)
  // volume prélevé doit être inclus (spatialOperators = ['sum'])
  t.is(result.length, 1)
  t.is(result[0].name, 'volume prélevé')
})

test('groupSeriesByParameter - inclut paramètre avec overlap si spatialOperators disponibles', t => {
  const series = [
    {
      _id: 'series1',
      parameter: 'débit prélevé',
      computed: {integratedDays: ['2023-01-01', '2023-01-02']}
    },
    {
      _id: 'series2',
      parameter: 'débit prélevé',
      computed: {integratedDays: ['2023-01-02', '2023-01-03']}
    }
  ]
  const result = groupSeriesByParameter(series, true)

  // Débit prélevé a spatialOperators = ['sum'], donc doit être inclus même avec overlap
  t.is(result.length, 1)
  t.is(result[0].name, 'débit prélevé')
  t.is(result[0].hasTemporalOverlap, true)
})

test('groupSeriesByParameter - pas de détection overlap en mode minDate/maxDate', t => {
  const series = [
    {
      _id: 'series1',
      parameter: 'température',
      minDate: '2023-01-01',
      maxDate: '2023-01-02'
    },
    {
      _id: 'series2',
      parameter: 'température',
      minDate: '2023-01-02',
      maxDate: '2023-01-03'
    }
  ]
  const result = groupSeriesByParameter(series, false)

  // En mode minDate/maxDate, pas de détection overlap donc température inclus
  t.is(result.length, 1)
  t.is(result[0].name, 'température')
  t.is(result[0].hasTemporalOverlap, false)
})

test('groupSeriesByParameter - inclut métadonnées complètes du paramètre', t => {
  const series = [
    {
      _id: 'series1',
      parameter: 'température',
      computed: {integratedDays: ['2023-01-01']}
    }
  ]
  const result = groupSeriesByParameter(series, true)

  t.is(result.length, 1)
  const param = result[0]
  t.is(param.name, 'température')
  t.is(param.unit, '°C')
  t.is(param.valueType, 'instantaneous')
  t.deepEqual(param.spatialOperators, [])
  t.deepEqual(param.temporalOperators, ['mean', 'min', 'max'])
  t.is(param.defaultSpatialOperator, null)
  t.is(param.defaultTemporalOperator, 'mean')
  t.truthy(param.availableFrequencies)
})

test('groupSeriesByParameter - gère paramètre avec warning', t => {
  const series = [
    {
      _id: 'series1',
      parameter: 'pH',
      computed: {integratedDays: ['2023-01-01']}
    }
  ]
  const result = groupSeriesByParameter(series, true)

  t.is(result.length, 1)
  t.truthy(result[0].warning)
  t.regex(result[0].warning, /logarithmique/)
})

test('groupSeriesByParameter - cas mixte : plusieurs paramètres avec et sans overlap', t => {
  const series = [
    // Volume prélevé avec overlap (agrégable spatialement)
    {
      _id: 'series1',
      parameter: 'volume prélevé',
      computed: {integratedDays: ['2023-01-01', '2023-01-02']}
    },
    {
      _id: 'series2',
      parameter: 'volume prélevé',
      computed: {integratedDays: ['2023-01-02', '2023-01-03']}
    },
    // Température avec overlap (NON agrégable spatialement → filtré)
    {
      _id: 'series3',
      parameter: 'température',
      computed: {integratedDays: ['2023-01-01', '2023-01-02']}
    },
    {
      _id: 'series4',
      parameter: 'température',
      computed: {integratedDays: ['2023-01-02', '2023-01-03']}
    },
    // PH sans overlap (inclus)
    {
      _id: 'series5',
      parameter: 'pH',
      computed: {integratedDays: ['2023-01-05']}
    }
  ]
  const result = groupSeriesByParameter(series, true)

  t.is(result.length, 2)
  t.is(result[0].name, 'pH')
  t.is(result[0].hasTemporalOverlap, false)
  t.is(result[1].name, 'volume prélevé')
  t.is(result[1].hasTemporalOverlap, true)
})
