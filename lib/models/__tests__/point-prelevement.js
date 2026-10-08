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
  t.true(pointQuery.select.nature)
  t.true(pointQuery.select.withdrawalType)
  t.true(pointQuery.select.zones.select.zone.select.type)
  t.true(pointQuery.select.declarants.select.usage.select.parentId)
  t.true(pointQuery.select.declarants.select.secondaryUsageLinks.select.usage.select.parentId)
})
