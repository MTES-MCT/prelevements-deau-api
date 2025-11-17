import test from 'ava'
import {normalizeUnit} from '../unit.js'

test('normalizeUnit - trouve l\'unité canonique exacte', t => {
  t.is(normalizeUnit('µS/cm'), 'µS/cm')
  t.is(normalizeUnit('degrés Celsius'), 'degrés Celsius')
  t.is(normalizeUnit('L/s'), 'L/s')
  t.is(normalizeUnit('m³/h'), 'm³/h')
  t.is(normalizeUnit('m³'), 'm³')
  t.is(normalizeUnit('m NGR'), 'm NGR')
  t.is(normalizeUnit('mg/L'), 'mg/L')
  t.is(normalizeUnit('autre'), 'autre')
})

test('normalizeUnit - normalise la casse', t => {
  t.is(normalizeUnit('L/S'), 'L/s')
  t.is(normalizeUnit('MG/L'), 'mg/L')
  t.is(normalizeUnit('M NGR'), 'm NGR')
  t.is(normalizeUnit('AUTRE'), 'autre')
})

test('normalizeUnit - gère les variantes de µS/cm', t => {
  t.is(normalizeUnit('µS/cm'), 'µS/cm')
  t.is(normalizeUnit('µs/cm'), 'µS/cm')
  t.is(normalizeUnit('uS/cm'), 'µS/cm')
  t.is(normalizeUnit('us/cm'), 'µS/cm')
  t.is(normalizeUnit('μS/cm'), 'µS/cm') // Micro grec
  t.is(normalizeUnit('microsiemens/cm'), 'µS/cm')
})

test('normalizeUnit - gère les variantes de degrés Celsius', t => {
  t.is(normalizeUnit('degrés Celsius'), 'degrés Celsius')
  t.is(normalizeUnit('degres celsius'), 'degrés Celsius')
  t.is(normalizeUnit('degré Celsius'), 'degrés Celsius')
  t.is(normalizeUnit('°C'), 'degrés Celsius')
  t.is(normalizeUnit('celsius'), 'degrés Celsius')
  t.is(normalizeUnit('C'), 'degrés Celsius')
})

test('normalizeUnit - gère les variantes de L/s', t => {
  t.is(normalizeUnit('l/s'), 'L/s')
  t.is(normalizeUnit('litres/s'), 'L/s')
  t.is(normalizeUnit('litre/s'), 'L/s')
  t.is(normalizeUnit('litres par seconde'), 'L/s')
  t.is(normalizeUnit('litre par seconde'), 'L/s')
})

test('normalizeUnit - gère les variantes de m³/h', t => {
  t.is(normalizeUnit('m3/h'), 'm³/h')
  t.is(normalizeUnit('M3/H'), 'm³/h')
  t.is(normalizeUnit('metres cubes par heure'), 'm³/h')
  t.is(normalizeUnit('metre cube par heure'), 'm³/h')
  t.is(normalizeUnit('m3/heure'), 'm³/h')
  t.is(normalizeUnit('m³/heure'), 'm³/h')
})

test('normalizeUnit - gère les variantes de m³', t => {
  t.is(normalizeUnit('m3'), 'm³')
  t.is(normalizeUnit('M3'), 'm³')
  t.is(normalizeUnit('metres cubes'), 'm³')
  t.is(normalizeUnit('metre cube'), 'm³')
})

test('normalizeUnit - gère les variantes de m NGR', t => {
  t.is(normalizeUnit('m ngr'), 'm NGR')
  t.is(normalizeUnit('M NGR'), 'm NGR')
  t.is(normalizeUnit('metres ngr'), 'm NGR')
  t.is(normalizeUnit('metre ngr'), 'm NGR')
  t.is(normalizeUnit('mngr'), 'm NGR')
})

test('normalizeUnit - gère les variantes de mg/L', t => {
  t.is(normalizeUnit('mg/l'), 'mg/L')
  t.is(normalizeUnit('MG/L'), 'mg/L')
  t.is(normalizeUnit('milligrammes par litre'), 'mg/L')
  t.is(normalizeUnit('milligramme par litre'), 'mg/L')
})

test('normalizeUnit - gère les espaces superflus', t => {
  t.is(normalizeUnit('  µS/cm  '), 'µS/cm')
  t.is(normalizeUnit('  degrés Celsius  '), 'degrés Celsius')
  t.is(normalizeUnit('m  NGR'), 'm NGR')
})

test('normalizeUnit - retourne undefined pour unité inconnue', t => {
  t.is(normalizeUnit('unité inconnue'), undefined)
  t.is(normalizeUnit('xyz'), undefined)
  t.is(normalizeUnit(''), undefined)
})

test('normalizeUnit - gère les valeurs nulles', t => {
  t.is(normalizeUnit(null), undefined)
  t.is(normalizeUnit(undefined), undefined)
})

test('normalizeUnit - gère les variantes de "autre"', t => {
  t.is(normalizeUnit('autre'), 'autre')
  t.is(normalizeUnit('Autre'), 'autre')
  t.is(normalizeUnit('AUTRE'), 'autre')
  t.is(normalizeUnit('autres'), 'autre')
})

test('normalizeUnit - toutes les unités standards sont trouvées', t => {
  const units = [
    'µS/cm',
    'degrés Celsius',
    'L/s',
    'm³/h',
    'm³',
    'm NGR',
    'mg/L',
    'autre'
  ]

  for (const unit of units) {
    t.truthy(normalizeUnit(unit), `L'unité "${unit}" devrait être trouvée`)
  }
})
