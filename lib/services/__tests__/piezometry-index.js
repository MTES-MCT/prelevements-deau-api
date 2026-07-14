import test from 'ava'

import {
  buildPiezometryIps,
  calculateMonthlyIps,
  getIpsClass
} from '../piezometry-index.js'

function groundwaterRow(date, levelNgf, depth = null) {
  return {
    measurementDate: new Date(`${date}T00:00:00.000Z`),
    measuredAt: new Date(`${date}T12:00:00.000Z`),
    levelNgf,
    depth
  }
}

test('l’IPS place la médiane historique près de zéro', t => {
  const references = Array.from({length: 21}, (_value, index) => index)

  t.true(Math.abs(calculateMonthlyIps(references, 10)) < 0.01)
  t.true(calculateMonthlyIps(references, 19) > 1)
  t.true(calculateMonthlyIps(references, 1) < -1)
})

test('les classes IPS utilisent les sept seuils du BSH', t => {
  t.is(getIpsClass(-2).key, 'VERY_LOW')
  t.is(getIpsClass(-1.28).key, 'LOW')
  t.is(getIpsClass(-0.84).key, 'MODERATELY_LOW')
  t.is(getIpsClass(0).key, 'NORMAL')
  t.is(getIpsClass(0.25).key, 'MODERATELY_HIGH')
  t.is(getIpsClass(0.84).key, 'HIGH')
  t.is(getIpsClass(1.28).key, 'VERY_HIGH')
})

test('l’IPS compare un mois uniquement au même mois des années précédentes', t => {
  const rows = []
  for (let year = 2006; year <= 2026; year += 1) {
    rows.push(
      groundwaterRow(`${year}-01-15`, 100 + (year - 2006)),
      groundwaterRow(`${year}-07-15`, 1000 + (year - 2006))
    )
  }

  const result = buildPiezometryIps(rows, {
    start: new Date('2026-01-01T00:00:00.000Z'),
    end: new Date('2027-01-01T00:00:00.000Z'),
    now: new Date('2027-01-01T00:00:00.000Z')
  })

  t.is(result.status, 'AVAILABLE')
  t.is(result.values.length, 2)
  t.true(result.values.every(value => value.referenceYears === 21))
  t.true(result.values.every(value => value.value > 1))
})

test('l’IPS exige quinze années de référence pour chaque mois', t => {
  const rows = Array.from({length: 14}, (_value, index) =>
    groundwaterRow(`${2013 + index}-01-15`, 100 + index)
  )
  const result = buildPiezometryIps(rows, {
    start: new Date('2026-01-01T00:00:00.000Z'),
    end: new Date('2027-01-01T00:00:00.000Z'),
    now: new Date('2027-01-01T00:00:00.000Z')
  })

  t.is(result.status, 'INSUFFICIENT_HISTORY')
  t.is(result.values.length, 0)
})

test('le sens de la profondeur est inversé pour représenter un niveau d’eau plus haut', t => {
  const rows = []
  for (let year = 2006; year <= 2026; year += 1) {
    rows.push(groundwaterRow(`${year}-01-15`, null, 30 - (year - 2006)))
  }

  const result = buildPiezometryIps(rows, {
    start: new Date('2026-01-01T00:00:00.000Z'),
    end: new Date('2027-01-01T00:00:00.000Z'),
    now: new Date('2027-01-01T00:00:00.000Z')
  })

  t.is(result.metric, 'DEPTH')
  t.true(result.values[0].value > 1)
})

test('le mois courant nécessite au moins cinq jours de mesure', t => {
  const rows = []
  for (let year = 2006; year < 2026; year += 1) {
    rows.push(groundwaterRow(`${year}-07-15`, 100 + (year - 2006)))
  }

  rows.push(
    groundwaterRow('2026-07-01', 120),
    groundwaterRow('2026-07-02', 121)
  )

  const result = buildPiezometryIps(rows, {
    start: new Date('2026-01-01T00:00:00.000Z'),
    end: new Date('2026-08-01T00:00:00.000Z'),
    now: new Date('2026-07-14T00:00:00.000Z')
  })

  t.is(result.values.length, 0)
})
