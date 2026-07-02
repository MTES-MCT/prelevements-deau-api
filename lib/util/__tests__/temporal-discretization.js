import test from 'ava'

import {
  computeInstantPeriodEnd,
  computePeriodEnd,
  isAlignedOnDiscreteStep,
  isDurationAlignedOnDiscreteStep,
  normalizeTemporalStart,
  parseDurationToMinutes
} from '../temporal-discretization.js'

test('parseDurationToMinutes convertit les durées supportées', t => {
  t.is(parseDurationToMinutes('15 minutes'), 15)
  t.is(parseDurationToMinutes('2 hours'), 120)
  t.is(parseDurationToMinutes('1 day'), 1440)
  t.is(parseDurationToMinutes(' 3 DAYS '), 4320)
})

test('parseDurationToMinutes rejette les durées invalides', t => {
  t.is(parseDurationToMinutes(null), null)
  t.is(parseDurationToMinutes('0 minutes'), null)
  t.is(parseDurationToMinutes('1 week'), null)
  t.is(parseDurationToMinutes('abc'), null)
})

test('normalizeTemporalStart normalise les secondes et millisecondes', t => {
  const result = normalizeTemporalStart('2026-06-30T12:34:56.789Z')

  t.is(result.toISOString(), '2026-06-30T12:34:00.000Z')
})

test('computePeriodEnd applique la durée ou le pas par défaut', t => {
  const start = new Date('2026-06-30T12:00:00.000Z')

  t.is(computePeriodEnd(start, '1 hour').toISOString(), '2026-06-30T13:00:00.000Z')
  t.is(computePeriodEnd(start, 'bad').toISOString(), '2026-06-30T12:15:00.000Z')
})

test('computeInstantPeriodEnd applique le pas minimal du domaine', t => {
  const start = new Date('2026-07-02T00:00:00.000Z')

  t.is(computeInstantPeriodEnd(start).toISOString(), '2026-07-02T00:15:00.000Z')
})

test('alignement sur pas discret', t => {
  t.true(isAlignedOnDiscreteStep(new Date('2026-06-30T12:30:00.000Z')))
  t.false(isAlignedOnDiscreteStep(new Date('2026-06-30T12:31:00.000Z')))
  t.true(isDurationAlignedOnDiscreteStep('30 minutes'))
  t.false(isDurationAlignedOnDiscreteStep('20 minutes'))
})
