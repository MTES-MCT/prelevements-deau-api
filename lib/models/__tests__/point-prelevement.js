import test from 'ava'

import {getPointMapSummaries} from '../point-prelevement.js'

test('le résumé carte ne charge que les liens de collecteurs actifs', async t => {
  let pointQuery
  const client = {
    pointPrelevement: {
      async findMany(query) {
        pointQuery = query
        return []
      }
    }
  }

  t.deepEqual(await getPointMapSummaries(false, {client}), [])
  t.deepEqual(
    pointQuery.select.declarants.select.collecteurs.where,
    {collecteur: {user: {deletedAt: null}}}
  )
})
