import test from 'ava'

import {countZoneDeclarants} from '../zones.js'

test('countZoneDeclarants compte uniquement les identifiants effectifs dédupliqués', async t => {
  let countQuery
  const client = {
    declarant: {
      async count(query) {
        countQuery = query
        return 2
      }
    }
  }

  t.is(await countZoneDeclarants([
    'declarant-1',
    'declarant-1',
    'declarant-2'
  ], 'PRELEVEUR', {client}), 2)
  t.deepEqual(countQuery.where, {
    userId: {in: ['declarant-1', 'declarant-2']},
    declarantRole: 'PRELEVEUR',
    user: {deletedAt: null}
  })
})

test('countZoneDeclarants reste fermé et évite la base sans identifiant effectif', async t => {
  const client = {
    declarant: {
      async count() {
        t.fail('Une zone vide ne doit pas déclencher un comptage global.')
      }
    }
  }

  t.is(await countZoneDeclarants([], 'COLLECTEUR', {client}), 0)
})
