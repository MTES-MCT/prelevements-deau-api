import test from 'ava'
import {calculateTotalVolumePreleve, normalizeErrors, summarizeErrors, parseBuffer} from '../attachments.js'

/* Tests pour parseBuffer */

test('parseBuffer - camion-citerne type', async t => {
  const buffer = Buffer.from('test')
  const result = await parseBuffer('camion-citerne', buffer)
  t.true(Array.isArray(result.errors))
  t.true(Array.isArray(result.series))
})

test('parseBuffer - aep-zre type', async t => {
  const buffer = Buffer.from('test')
  const result = await parseBuffer('aep-zre', buffer)
  t.true(Array.isArray(result.errors))
  t.true(Array.isArray(result.series))
})

test('parseBuffer - icpe-hors-zre type', async t => {
  const buffer = Buffer.from('test')
  const result = await parseBuffer('icpe-hors-zre', buffer)
  t.true(Array.isArray(result.errors))
  t.true(Array.isArray(result.series))
})

test('parseBuffer - unknown type', async t => {
  const buffer = Buffer.from('test')
  const result = await parseBuffer('unknown-type', buffer)
  t.deepEqual(result.errors, [])
  t.deepEqual(result.series, [])
})

/* Tests pour normalizeErrors */

test('normalizeErrors - null errors', t => {
  const result = normalizeErrors(null)
  t.deepEqual(result, [])
})

test('normalizeErrors - undefined errors', t => {
  const result = normalizeErrors(undefined)
  t.deepEqual(result, [])
})

test('normalizeErrors - empty array', t => {
  const result = normalizeErrors([])
  t.deepEqual(result, [])
})

test('normalizeErrors - adds default severity error', t => {
  const errors = [
    {message: 'Error 1'},
    {message: 'Error 2'}
  ]
  const result = normalizeErrors(errors)
  t.is(result.length, 2)
  t.is(result[0].severity, 'error')
  t.is(result[1].severity, 'error')
})

test('normalizeErrors - preserves existing severity', t => {
  const errors = [
    {message: 'Warning 1', severity: 'warning'},
    {message: 'Error 1', severity: 'error'}
  ]
  const result = normalizeErrors(errors)
  t.is(result.length, 2)
  t.is(result[0].severity, 'warning')
  t.is(result[1].severity, 'error')
})

test('normalizeErrors - preserves other properties', t => {
  const errors = [
    {message: 'Error 1', line: 5, column: 10}
  ]
  const result = normalizeErrors(errors)
  t.is(result.length, 1)
  t.is(result[0].message, 'Error 1')
  t.is(result[0].line, 5)
  t.is(result[0].column, 10)
  t.is(result[0].severity, 'error')
})

/* Tests pour summarizeErrors */

test('summarizeErrors - empty array', t => {
  const result = summarizeErrors([])
  t.deepEqual(result.errors, [])
  t.deepEqual(result.errorSummary, {total: 0})
})

test('summarizeErrors - single error', t => {
  const errors = [
    {message: 'Error 1', severity: 'error'}
  ]
  const result = summarizeErrors(errors)
  t.is(result.errors.length, 1)
  t.deepEqual(result.errorSummary, {
    total: 1,
    error: 1,
    warning: 0
  })
})

test('summarizeErrors - multiple errors and warnings', t => {
  const errors = [
    {message: 'Error 1', severity: 'error'},
    {message: 'Warning 1', severity: 'warning'},
    {message: 'Error 2', severity: 'error'},
    {message: 'Warning 2', severity: 'warning'}
  ]
  const result = summarizeErrors(errors)
  t.is(result.errors.length, 4)
  t.deepEqual(result.errorSummary, {
    total: 4,
    error: 2,
    warning: 2
  })
})

test('summarizeErrors - limits to 50 errors', t => {
  const errors = Array.from({length: 60}, (_, i) => ({
    message: `Error ${i + 1}`,
    severity: 'error'
  }))
  const result = summarizeErrors(errors)
  t.is(result.errors.length, 51) // 50 + message de troncature
  t.is(result.errors[50].message, 'Le fichier contient plus de 50 erreurs. Les erreurs suivantes n\'ont pas été affichées.')
  t.deepEqual(result.errorSummary, {
    total: 60,
    error: 60,
    warning: 0
  })
})

test('summarizeErrors - exactly 50 errors (no truncation)', t => {
  const errors = Array.from({length: 50}, (_, i) => ({
    message: `Error ${i + 1}`,
    severity: 'error'
  }))
  const result = summarizeErrors(errors)
  t.is(result.errors.length, 50)
  t.deepEqual(result.errorSummary, {
    total: 50,
    error: 50,
    warning: 0
  })
})

test('summarizeErrors - 49 errors (no truncation)', t => {
  const errors = Array.from({length: 49}, (_, i) => ({
    message: `Error ${i + 1}`,
    severity: 'error'
  }))
  const result = summarizeErrors(errors)
  t.is(result.errors.length, 49)
  t.deepEqual(result.errorSummary, {
    total: 49,
    error: 49,
    warning: 0
  })
})

/* Tests pour calculateTotalVolumePreleve */

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
