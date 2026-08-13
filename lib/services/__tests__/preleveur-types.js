import test from 'ava'

import {
  getPreleveurTypeFromUsages,
  normalizePreleveurType
} from '../preleveur-types.js'

test('getPreleveurTypeFromUsages déduit les types depuis les racines et sous-usages SANDRE', t => {
  t.is(getPreleveurTypeFromUsages(['4A']), 'ICPE')
  t.is(getPreleveurTypeFromUsages(['2', '2F']), 'IRRIGANT')
  t.is(getPreleveurTypeFromUsages(['5B']), 'GESTIONNAIRE_AEP')
  t.is(getPreleveurTypeFromUsages(['3', '17']), 'AUTRE')
  t.is(getPreleveurTypeFromUsages([]), 'AUTRE')
})

test('getPreleveurTypeFromUsages refuse plusieurs catégories spécialisées', t => {
  t.throws(
    () => getPreleveurTypeFromUsages(['2', '4A']),
    {message: /plusieurs catégories d’usage/}
  )
})

test('normalizePreleveurType fournit le fallback compatible et masque les collecteurs', t => {
  t.is(normalizePreleveurType({declarantRole: 'PRELEVEUR'}), 'AUTRE')
  t.is(normalizePreleveurType({declarantRole: 'PRELEVEUR', preleveurType: 'ICPE'}), 'ICPE')
  t.is(normalizePreleveurType({declarantRole: 'COLLECTEUR', preleveurType: 'ICPE'}), null)
})
