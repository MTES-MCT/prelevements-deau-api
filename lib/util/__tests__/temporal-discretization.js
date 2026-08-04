import test from 'ava'

import {
  computeInstantPeriodEnd,
  computePeriodEnd,
  isAlignedOnDiscreteStep,
  isDurationAlignedOnDiscreteStep,
  normalizeTemporalStart,
  parseDurationToMinutes,
  resolveTemporalPeriod,
  TEMPORAL_PERIOD_ERRORS
} from '../temporal-discretization.js'

test('parseDurationToMinutes convertit les durées supportées', t => {
  t.is(parseDurationToMinutes('15 minutes'), 15)
  t.is(parseDurationToMinutes('15_minutes'), 15)
  t.is(parseDurationToMinutes('2 hours'), 120)
  t.is(parseDurationToMinutes('1 day'), 1440)
  t.is(parseDurationToMinutes('2 weeks'), 20_160)
  t.is(parseDurationToMinutes(' 3 DAYS '), 4320)
})

test('parseDurationToMinutes rejette les durées invalides ou calendaires', t => {
  t.is(parseDurationToMinutes(null), null)
  t.is(parseDurationToMinutes('0 minutes'), null)
  t.is(parseDurationToMinutes('1 month'), null)
  t.is(parseDurationToMinutes('1 quarter'), null)
  t.is(parseDurationToMinutes('1 year'), null)
  t.is(parseDurationToMinutes('abc'), null)
})

test('normalizeTemporalStart normalise les secondes et millisecondes', t => {
  const result = normalizeTemporalStart('2026-06-30T12:34:56.789Z')

  t.is(result.toISOString(), '2026-06-30T12:34:00.000Z')
})

test('computePeriodEnd applique les durées fixes en UTC', t => {
  const start = new Date('2026-06-30T12:00:00.000Z')

  t.is(computePeriodEnd(start, '1 hour').toISOString(), '2026-06-30T13:00:00.000Z')
  t.is(computePeriodEnd(start, '1 day').toISOString(), '2026-07-01T12:00:00.000Z')
  t.is(computePeriodEnd(start, '1 week').toISOString(), '2026-07-07T12:00:00.000Z')
})

test('computePeriodEnd applique les durées calendaires en UTC', t => {
  t.is(
    computePeriodEnd(new Date('2024-01-31T00:00:00.000Z'), '1 month').toISOString(),
    '2024-02-29T00:00:00.000Z'
  )
  t.is(
    computePeriodEnd(new Date('2026-10-01T00:00:00.000Z'), '1 quarter').toISOString(),
    '2027-01-01T00:00:00.000Z'
  )
  t.is(
    computePeriodEnd(new Date('2024-02-29T00:00:00.000Z'), '1 year').toISOString(),
    '2025-02-28T00:00:00.000Z'
  )
})

test('computePeriodEnd ne substitue pas silencieusement une durée invalide', t => {
  const start = new Date('2026-06-30T12:00:00.000Z')

  t.is(computePeriodEnd(start, 'bad'), null)
  t.is(computePeriodEnd(start), null)
})

test('computeInstantPeriodEnd applique le pas minimal du domaine', t => {
  const start = new Date('2026-07-02T00:00:00.000Z')

  t.is(computeInstantPeriodEnd(start).toISOString(), '2026-07-02T00:15:00.000Z')
})

test('alignement sur pas discret', t => {
  t.true(isAlignedOnDiscreteStep(new Date('2026-06-30T12:30:00.000Z')))
  t.false(isAlignedOnDiscreteStep(new Date('2026-06-30T12:31:00.000Z')))
  t.true(isDurationAlignedOnDiscreteStep('30 minutes'))
  t.true(isDurationAlignedOnDiscreteStep('1 week'))
  t.true(isDurationAlignedOnDiscreteStep('1 month'))
  t.true(isDurationAlignedOnDiscreteStep('1 quarter'))
  t.true(isDurationAlignedOnDiscreteStep('1 year'))
  t.false(isDurationAlignedOnDiscreteStep('20 minutes'))
  t.false(isDurationAlignedOnDiscreteStep('bad'))
})

test('resolveTemporalPeriod privilégie les bornes explicites', t => {
  const result = resolveTemporalPeriod({
    date: '2026-02-28T00:00:00.000Z',
    periodStart: '2026-02-01T00:00:00.000Z',
    periodEnd: '2026-03-01T00:00:00.000Z'
  }, '1 day')

  t.is(result.error, null)
  t.true(result.hasExplicitPeriodEnd)
  t.is(result.periodStart.toISOString(), '2026-02-01T00:00:00.000Z')
  t.is(result.periodEnd.toISOString(), '2026-03-01T00:00:00.000Z')
})

test('resolveTemporalPeriod conserve le contrat historique date + granularité', t => {
  const result = resolveTemporalPeriod({date: '2026-02-01T00:00:00.000Z'}, '1 day')

  t.is(result.error, null)
  t.false(result.hasExplicitPeriodEnd)
  t.is(result.periodStart.toISOString(), '2026-02-01T00:00:00.000Z')
  t.is(result.periodEnd.toISOString(), '2026-02-02T00:00:00.000Z')
})

test('resolveTemporalPeriod accepte l’alias historique 15_minutes', t => {
  const result = resolveTemporalPeriod({date: '2026-02-01T12:30:00.000Z'}, '15_minutes')

  t.is(result.error, null)
  t.false(result.hasExplicitPeriodEnd)
  t.is(result.periodStart.toISOString(), '2026-02-01T12:30:00.000Z')
  t.is(result.periodEnd.toISOString(), '2026-02-01T12:45:00.000Z')
  t.true(isDurationAlignedOnDiscreteStep('15_minutes'))
})

test('resolveTemporalPeriod résout une granularité mensuelle implicite', t => {
  const result = resolveTemporalPeriod({date: '2024-02-01T00:00:00.000Z'}, '1 month')

  t.is(result.error, null)
  t.false(result.hasExplicitPeriodEnd)
  t.is(result.periodStart.toISOString(), '2024-02-01T00:00:00.000Z')
  t.is(result.periodEnd.toISOString(), '2024-03-01T00:00:00.000Z')
})

test('resolveTemporalPeriod rejette explicitement une granularité implicite invalide', t => {
  const result = resolveTemporalPeriod({date: '2026-02-01T00:00:00.000Z'}, 'sometimes')

  t.is(result.error, TEMPORAL_PERIOD_ERRORS.INVALID_DURATION)
  t.false(result.hasExplicitPeriodEnd)
  t.is(result.periodStart.toISOString(), '2026-02-01T00:00:00.000Z')
  t.is(result.periodEnd, null)
})

test('resolveTemporalPeriod ignore la granularité quand les bornes sont explicites', t => {
  const result = resolveTemporalPeriod({
    periodStart: '2026-02-01T00:00:00.000Z',
    periodEnd: '2026-03-01T00:00:00.000Z'
  }, 'sometimes')

  t.is(result.error, null)
  t.true(result.hasExplicitPeriodEnd)
  t.is(result.periodEnd.toISOString(), '2026-03-01T00:00:00.000Z')
})

test('resolveTemporalPeriod rejette une période nulle ou inversée', t => {
  const equalPeriod = resolveTemporalPeriod({
    periodStart: '2026-02-01T00:00:00.000Z',
    periodEnd: '2026-02-01T00:00:00.000Z'
  }, '1 day')
  const invertedPeriod = resolveTemporalPeriod({
    periodStart: '2026-02-02T00:00:00.000Z',
    periodEnd: '2026-02-01T00:00:00.000Z'
  }, '1 day')

  t.is(equalPeriod.error, TEMPORAL_PERIOD_ERRORS.NON_POSITIVE_PERIOD)
  t.is(invertedPeriod.error, TEMPORAL_PERIOD_ERRORS.NON_POSITIVE_PERIOD)
})
