import test from 'ava'
import {normalizeOutputFrequency, isSubDailyFrequency, isSuperDailyFrequency, isCumulativeParameter, expandToDaily} from '../frequency.js'

// NormalizeOutputFrequency tests

test('normalizeOutputFrequency - standard mappings', t => {
  t.is(normalizeOutputFrequency('15 minutes'), '15 minutes')
  t.is(normalizeOutputFrequency('heure'), '1 hour')
  t.is(normalizeOutputFrequency('minute'), '1 minute')
  t.is(normalizeOutputFrequency('seconde'), '1 second')
  t.is(normalizeOutputFrequency('jour'), '1 day')
  t.is(normalizeOutputFrequency('1 jour'), '1 day')
})

test('normalizeOutputFrequency - super-daily mappings', t => {
  t.is(normalizeOutputFrequency('mois'), '1 month')
  t.is(normalizeOutputFrequency('trimestre'), '1 quarter')
  t.is(normalizeOutputFrequency('année'), '1 year')
})

test('normalizeOutputFrequency - unsupported returns undefined', t => {
  t.is(normalizeOutputFrequency('autre'), undefined)
  t.is(normalizeOutputFrequency(undefined), undefined)
})

// IsSubDailyFrequency tests

test('isSubDailyFrequency - true for infra-day', t => {
  for (const f of ['15 minutes', '1 hour', '1 minute', '1 second']) {
    t.true(isSubDailyFrequency(f))
  }
})

test('isSubDailyFrequency - false for day or higher / unknown', t => {
  for (const f of ['1 day', '1 month', '1 quarter', '1 year', 'autre', undefined]) {
    t.false(isSubDailyFrequency(f))
  }
})

// IsSuperDailyFrequency tests

test('isSuperDailyFrequency - true for month, quarter, year', t => {
  for (const f of ['1 month', '1 quarter', '1 year']) {
    t.true(isSuperDailyFrequency(f))
  }
})

test('isSuperDailyFrequency - false for day or lower / unknown', t => {
  for (const f of ['15 minutes', '1 hour', '1 minute', '1 second', '1 day', 'autre', undefined]) {
    t.false(isSuperDailyFrequency(f))
  }
})

// IsCumulativeParameter tests

test('isCumulativeParameter - true for volume parameters', t => {
  t.true(isCumulativeParameter('volume prélevé'))
  t.true(isCumulativeParameter('volume restitué'))
})

test('isCumulativeParameter - false for other parameters', t => {
  const nonCumulativeParams = [
    'température',
    'pH',
    'débit prélevé',
    'niveau d\'eau',
    'conductivité',
    'chlorures',
    'autre',
    undefined
  ]
  for (const param of nonCumulativeParams) {
    t.false(isCumulativeParameter(param))
  }
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
