import test from 'ava'

import {getPointMapSummaries} from '../point-prelevement.js'

test('le chargement carte rapproche la télérelève des seules exploitations chargées', async t => {
  const points = [{id: 'point-1', declarants: [{id: 'exploitation-1', connectors: []}, {id: 'exploitation-2', connectors: []}]}]
  let telemetryQuery
  const client = {
    pointPrelevement: {async findMany() { return points }},
    async $queryRaw(query) {
      const sql = (query.strings ?? query).join(' ')
      if (sql.includes('MeterAllocation')) {
        telemetryQuery = query
        return [{exploitation_id: 'exploitation-1'}]
      }
      return [{id: 'point-1', coordinates: {type: 'Point', coordinates: [2, 46]}}]
    }
  }

  const [point] = await getPointMapSummaries(false, {client})
  t.deepEqual(point.coordinates.coordinates, [2, 46])
  t.true(point.declarants[0].hasMeterTelemetry)
  t.false(point.declarants[1].hasMeterTelemetry)
  t.deepEqual(telemetryQuery.values.at(-1), ['exploitation-1', 'exploitation-2'])
  t.false(Object.hasOwn(points[0].declarants[0], 'hasMeterTelemetry'))
})

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
