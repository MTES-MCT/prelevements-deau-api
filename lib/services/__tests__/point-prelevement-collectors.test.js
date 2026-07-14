import test from 'ava'

import {aggregateCollectors} from '../point-prelevement.js'

test('aggregateCollectors expose et déduplique les comptes collecteurs d’un point', t => {
  const collectorLink = {
    collecteur: {
      id: 'declarant-collecteur',
      socialReason: 'Collecteur du territoire',
      user: {
        id: 'user-collecteur',
        email: 'collecteur@example.test'
      }
    }
  }

  const collectors = aggregateCollectors([
    {collecteurs: [collectorLink]},
    {collecteurs: [collectorLink]},
    {collecteurs: [{collecteur: null}]}
  ])

  t.deepEqual(collectors, [{
    id: 'user-collecteur',
    email: 'collecteur@example.test',
    declarant: {
      id: 'declarant-collecteur',
      socialReason: 'Collecteur du territoire'
    }
  }])
})
