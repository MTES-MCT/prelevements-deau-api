import test from 'ava'
import {normalizeString, normalizeParameterName} from '../parameter.js'

test('normalizeString - normalise une chaîne basique', t => {
  t.is(normalizeString('Volume Prélevé'), 'volume preleve')
})

test('normalizeString - supprime les accents', t => {
  t.is(normalizeString('débit prélevé'), 'debit preleve')
  t.is(normalizeString('température'), 'temperature')
  t.is(normalizeString('conductivité électrique'), 'conductivite electrique')
})

test('normalizeString - trim les espaces', t => {
  t.is(normalizeString('  volume prélevé  '), 'volume preleve')
  t.is(normalizeString('\tvolume prélevé\n'), 'volume preleve')
})

test('normalizeString - normalise les espaces multiples', t => {
  t.is(normalizeString('volume    prélevé'), 'volume preleve')
  t.is(normalizeString('débit   prélevé'), 'debit preleve')
})

test('normalizeString - met en minuscules', t => {
  t.is(normalizeString('VOLUME PRÉLEVÉ'), 'volume preleve')
  t.is(normalizeString('Débit Prélevé'), 'debit preleve')
})

test('normalizeString - gère les chaînes vides', t => {
  t.is(normalizeString(''), undefined)
  t.is(normalizeString(null), undefined)
  t.is(normalizeString(undefined), undefined)
})

test('normalizeString - gère les apostrophes typographiques', t => {
  t.is(normalizeString('relevé d’index de compteur'), 'releve d\'index de compteur')
  t.is(normalizeString('relevé d\'index de compteur'), 'releve d\'index de compteur')
})

test('normalizeParameterName - trouve le paramètre canonique exact', t => {
  t.is(normalizeParameterName('volume prélevé'), 'volume prélevé')
  t.is(normalizeParameterName('débit prélevé'), 'débit prélevé')
  t.is(normalizeParameterName('température'), 'température')
})

test('normalizeParameterName - normalise la casse', t => {
  t.is(normalizeParameterName('Volume Prélevé'), 'volume prélevé')
  t.is(normalizeParameterName('VOLUME PRÉLEVÉ'), 'volume prélevé')
  t.is(normalizeParameterName('Débit Prélevé'), 'débit prélevé')
})

test('normalizeParameterName - normalise les accents', t => {
  t.is(normalizeParameterName('volume preleve'), 'volume prélevé')
  t.is(normalizeParameterName('debit preleve'), 'débit prélevé')
  t.is(normalizeParameterName('temperature'), 'température')
})

test('normalizeParameterName - normalise les espaces', t => {
  t.is(normalizeParameterName('  volume prélevé  '), 'volume prélevé')
  t.is(normalizeParameterName('volume    prélevé'), 'volume prélevé')
})

test('normalizeParameterName - trouve via alias', t => {
  t.is(normalizeParameterName('conductivité électrique'), 'conductivité')
  t.is(normalizeParameterName('Conductivité Électrique'), 'conductivité')
  t.is(normalizeParameterName('conductivite electrique'), 'conductivité')
})

test('normalizeParameterName - retourne undefined pour paramètre inconnu', t => {
  t.is(normalizeParameterName('paramètre inexistant'), undefined)
  t.is(normalizeParameterName('xyz'), undefined)
  t.is(normalizeParameterName(''), undefined)
})

test('normalizeParameterName - gère les valeurs nulles', t => {
  t.is(normalizeParameterName(null), undefined)
  t.is(normalizeParameterName(undefined), undefined)
})

test('normalizeParameterName - tous les paramètres standards sont trouvés', t => {
  const parameters = [
    'chlorures',
    'conductivité',
    'débit prélevé',
    'débit réservé',
    'débit restitué',
    'nitrates',
    'pH',
    'sulfates',
    'température',
    'turbidité',
    'volume prélevé',
    'volume restitué',
    'niveau piézométrique',
    'relevé d’index de compteur',
    'niveau d’eau'
  ]

  for (const param of parameters) {
    t.truthy(normalizeParameterName(param), `Le paramètre "${param}" devrait être trouvé`)
  }
})
