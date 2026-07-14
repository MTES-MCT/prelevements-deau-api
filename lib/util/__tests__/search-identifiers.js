import test from 'ava'

import {normalizeSiretSearch} from '../search-identifiers.js'

test('normalizeSiretSearch accepte les SIRET avec séparateurs', t => {
  t.is(normalizeSiretSearch('123 456 789 00012'), '12345678900012')
  t.is(normalizeSiretSearch('123-456-789-00012'), '12345678900012')
  t.is(normalizeSiretSearch('SIRET : 12345678900012'), '12345678900012')
})

test('normalizeSiretSearch ignore une recherche sans chiffre', t => {
  t.is(normalizeSiretSearch('ASA des Albères'), null)
  t.is(normalizeSiretSearch('ASA 66'), null)
  t.is(normalizeSiretSearch(null), null)
})
