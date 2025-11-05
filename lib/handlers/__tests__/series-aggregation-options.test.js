import test from 'ava'

/**
 * Tests pour les fonctions utilitaires du handler series-aggregation-options
 * Ces tests valident la logique de calcul des plages de dates et le groupement par paramètre
 */

/**
 * Fonction utilitaire pour calculer les dates min/max depuis les integratedDays
 * (Copie de la fonction du handler pour les tests)
 */
function calculateDateRangeFromIntegratedDays(series) {
  const allDates = []

  for (const s of series) {
    if (s.computed?.integratedDays && Array.isArray(s.computed.integratedDays)) {
      allDates.push(...s.computed.integratedDays)
    }
  }

  if (allDates.length === 0) {
    return {minDate: null, maxDate: null}
  }

  // Tri des dates (format YYYY-MM-DD)
  allDates.sort()

  return {
    minDate: allDates[0],
    maxDate: allDates.at(-1)
  }
}

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
