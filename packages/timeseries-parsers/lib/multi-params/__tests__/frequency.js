import test from 'ava'
import {normalizeOutputFrequency, isSubDailyFrequency} from '../frequency.js'

// NormalizeOutputFrequency tests

test('normalizeOutputFrequency - standard mappings', t => {
  t.is(normalizeOutputFrequency('15 minutes'), '15 minutes')
  t.is(normalizeOutputFrequency('heure'), '1 hour')
  t.is(normalizeOutputFrequency('minute'), '1 minute')
  t.is(normalizeOutputFrequency('seconde'), '1 second')
  t.is(normalizeOutputFrequency('jour'), '1 day')
  t.is(normalizeOutputFrequency('1 jour'), '1 day')
})

test('normalizeOutputFrequency - unsupported returns undefined', t => {
  t.is(normalizeOutputFrequency('mois'), undefined)
  t.is(normalizeOutputFrequency('trimestre'), undefined)
  t.is(normalizeOutputFrequency('année'), undefined)
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
  for (const f of ['1 day', 'mois', 'année', 'trimestre', 'autre', undefined]) {
    t.false(isSubDailyFrequency(f))
  }
})
