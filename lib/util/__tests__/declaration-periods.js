import test from 'ava'

import {
  getDeclarationPeriodKey,
  getDeclarationPeriodKeysBetween,
  getDeclarationPeriodStart,
  getNextDeclarationPeriodStart,
  parseDeclarationPeriodKey,
  parseDeclarationPeriodType
} from '../declaration-periods.js'

test('parseDeclarationPeriodType defaults to month', t => {
  t.is(parseDeclarationPeriodType('month'), 'month')
  t.is(parseDeclarationPeriodType('week'), 'week')
  t.is(parseDeclarationPeriodType('day'), 'month')
  t.is(parseDeclarationPeriodType(undefined), 'month')
})

test('parseDeclarationPeriodKey validates month keys', t => {
  t.is(parseDeclarationPeriodKey('2026-07', 'month'), '2026-07')
  t.is(parseDeclarationPeriodKey('2026-00', 'month'), null)
  t.is(parseDeclarationPeriodKey('2026-13', 'month'), null)
  t.is(parseDeclarationPeriodKey('2026-7', 'month'), null)
})

test('parseDeclarationPeriodKey validates ISO week keys', t => {
  t.is(parseDeclarationPeriodKey('2026-W27', 'week'), '2026-W27')
  t.is(parseDeclarationPeriodKey('2020-W53', 'week'), '2020-W53')
  t.is(parseDeclarationPeriodKey('2021-W53', 'week'), null)
  t.is(parseDeclarationPeriodKey('2026-W00', 'week'), null)
  t.is(parseDeclarationPeriodKey('2026-27', 'week'), null)
})

test('getDeclarationPeriodKey formats month and week keys', t => {
  t.is(getDeclarationPeriodKey('month', new Date(Date.UTC(2026, 6, 5))), '2026-07')
  t.is(getDeclarationPeriodKey('week', new Date(Date.UTC(2026, 6, 5))), '2026-W27')
})

test('getDeclarationPeriodStart returns UTC period starts', t => {
  t.is(getDeclarationPeriodStart('month', '2026-07').toISOString(), '2026-07-01T00:00:00.000Z')
  t.is(getDeclarationPeriodStart('week', '2026-W27').toISOString(), '2026-06-29T00:00:00.000Z')
})

test('getNextDeclarationPeriodStart returns exclusive period ends', t => {
  t.is(getNextDeclarationPeriodStart('month', '2026-07').toISOString(), '2026-08-01T00:00:00.000Z')
  t.is(getNextDeclarationPeriodStart('week', '2026-W27').toISOString(), '2026-07-06T00:00:00.000Z')
})

test('getDeclarationPeriodKeysBetween includes all overlapped months', t => {
  t.deepEqual(
    getDeclarationPeriodKeysBetween(
      'month',
      new Date(Date.UTC(2026, 0, 15)),
      new Date(Date.UTC(2026, 2, 2))
    ),
    ['2026-01', '2026-02', '2026-03']
  )
})

test('getDeclarationPeriodKeysBetween includes all overlapped ISO weeks', t => {
  t.deepEqual(
    getDeclarationPeriodKeysBetween(
      'week',
      new Date(Date.UTC(2026, 4, 31)),
      new Date(Date.UTC(2026, 5, 8))
    ),
    ['2026-W22', '2026-W23', '2026-W24']
  )
})
