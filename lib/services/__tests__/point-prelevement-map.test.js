import test from 'ava'

import {serializePointMapSummaries} from '../point-prelevement.js'

const usage = {
  id: 'usage-1',
  code: '1',
  kind: 'USAGE',
  label: 'Alimentation en eau potable',
  color: '#000091',
  dashboardVisible: true
}

test('les résumés cartographiques exposent les usages sans les associations déclarants', t => {
  const [summary] = serializePointMapSummaries([{
    id: 'point-1',
    name: 'Forage communal',
    usageName: null,
    flowType: 'PRELEVEMENT',
    waterBodyType: 'SOUTERRAIN',
    coordinates: {type: 'Point', coordinates: [2, 46]},
    declarants: [
      {usage},
      {usage},
      {usage: null}
    ]
  }])

  t.false(Object.hasOwn(summary, 'declarants'))
  t.false(Object.hasOwn(summary, 'zones'))
  t.true(summary.canReadDetail)
  t.deepEqual(summary.usages.map(item => item.id), ['usage-1'])
  t.deepEqual(summary.coordinates.coordinates, [2, 46])
})

test('les résumés cartographiques distinguent le droit de consulter la fiche', t => {
  const points = [{
    id: 'point-1',
    zones: [{zoneId: 'zone-map'}, {zoneId: 'zone-detail'}]
  }, {
    id: 'point-2',
    zones: [{zoneId: 'zone-map'}]
  }]

  const summaries = serializePointMapSummaries(points, {
    readableDetailZoneIds: new Set(['zone-detail'])
  })

  t.true(summaries[0].canReadDetail)
  t.false(summaries[1].canReadDetail)
})
