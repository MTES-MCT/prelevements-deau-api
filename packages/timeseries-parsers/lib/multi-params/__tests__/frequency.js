import test from 'ava'
import {normalizeOutputFrequency, isSubDailyFrequency, isSuperDailyFrequency, isCumulativeParameter} from '../frequency.js'

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

