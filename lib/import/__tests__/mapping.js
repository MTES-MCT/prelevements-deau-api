import test from 'ava'

import {REGLES_DEFINITION} from '../mapping.js'

function parseRegle(row) {
  const parsed = {}
  for (const [key, config] of Object.entries(REGLES_DEFINITION.schema)) {
    const parser = config.parse
    if (typeof parser === 'function') {
      parsed[key] = parser.length === 2 ? parser(row[key], row) : parser(row[key])
    }
  }

  return parsed
}

test('REGLES_DEFINITION / parse volume journalier (ID 1) avec fréquence auto', t => {
  const row = {
    id_regle: '100',
    parametre: '1',
    unite: '1',
    valeur: '1000',
    contrainte: '2',
    debut_validite: '2024-01-01',
    fin_validite: '',
    debut_periode: '',
    fin_periode: '',
    remarque: '',
    id_document: ''
  }

  t.deepEqual(parseRegle(row), {
    id_regle: 100,
    parametre: 'volume prélevé',
    frequence: '1 day',
    unite: 'm³',
    valeur: 1000,
    contrainte: 'max',
    debut_validite: '2024-01-01',
    fin_validite: undefined,
    debut_periode: undefined,
    fin_periode: undefined,
    remarque: undefined,
    id_document: undefined
  })
})

test('REGLES_DEFINITION / parse volume mensuel (ID 2) avec fréquence auto', t => {
  const row = {
    id_regle: '200',
    parametre: '2',
    unite: '1',
    valeur: '30000',
    contrainte: '2',
    debut_validite: '',
    fin_validite: '',
    debut_periode: '',
    fin_periode: '',
    remarque: '',
    id_document: ''
  }

  t.deepEqual(parseRegle(row), {
    id_regle: 200,
    parametre: 'volume prélevé',
    frequence: '1 month',
    unite: 'm³',
    valeur: 30_000,
    contrainte: 'max',
    debut_validite: undefined,
    fin_validite: undefined,
    debut_periode: undefined,
    fin_periode: undefined,
    remarque: undefined,
    id_document: undefined
  })
})

test('REGLES_DEFINITION / parse volume annuel (ID 3) avec fréquence auto', t => {
  const row = {
    id_regle: '300',
    parametre: '3',
    unite: '1',
    valeur: '365000',
    contrainte: '2',
    debut_validite: '',
    fin_validite: '',
    debut_periode: '',
    fin_periode: '',
    remarque: '',
    id_document: ''
  }

  t.deepEqual(parseRegle(row), {
    id_regle: 300,
    parametre: 'volume prélevé',
    frequence: '1 year',
    unite: 'm³',
    valeur: 365_000,
    contrainte: 'max',
    debut_validite: undefined,
    fin_validite: undefined,
    debut_periode: undefined,
    fin_periode: undefined,
    remarque: undefined,
    id_document: undefined
  })
})

test('REGLES_DEFINITION / parse débit prélevé (ID 5) sans fréquence auto', t => {
  const row = {
    id_regle: '500',
    parametre: '5',
    unite: '2',
    valeur: '60',
    contrainte: '2',
    debut_validite: '',
    fin_validite: '',
    debut_periode: '',
    fin_periode: '',
    remarque: '',
    id_document: ''
  }

  t.deepEqual(parseRegle(row), {
    id_regle: 500,
    parametre: 'débit prélevé',
    frequence: undefined,
    unite: 'L/s',
    valeur: 60,
    contrainte: 'max',
    debut_validite: undefined,
    fin_validite: undefined,
    debut_periode: undefined,
    fin_periode: undefined,
    remarque: undefined,
    id_document: undefined
  })
})

test('REGLES_DEFINITION / parse contrainte min/max', t => {
  const rowMin = {parametre: '5', contrainte: '1'}
  const rowMax = {parametre: '5', contrainte: '2'}

  const parseContrainte = REGLES_DEFINITION.schema.contrainte.parse

  t.is(parseContrainte(rowMin.contrainte), 'min')
  t.is(parseContrainte(rowMax.contrainte), 'max')
})

test('REGLES_DEFINITION / parse unités avec degrés Celsius', t => {
  const row = {parametre: '10', unite: '5'}

  const parseUnite = REGLES_DEFINITION.schema.unite.parse

  t.is(parseUnite(row.unite), 'degrés Celsius')
})
