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
    codeBSS: '10972X0137/PONT',
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
  t.is(summary.codeBSS, '10972X0137/PONT')
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

test('les résumés cartographiques exposent un index de recherche métier léger', t => {
  const [summary] = serializePointMapSummaries([{
    id: 'point-1',
    name: 'Forage des Prés',
    codeBSS: 'BSS-001',
    codeBNPE: 'BNPE-001',
    otherNames: 'Ancien forage; Forage communal',
    names: [{name: 'Puits des Prés'}],
    identifiers: {local: 'LOCAL-42'},
    communeName: 'Saint-Étienne',
    zones: [{
      zoneId: 'zone-1',
      zone: {id: 'zone-1', code: '42', name: 'Loire'}
    }],
    declarants: [{
      status: 'EN_ACTIVITE',
      usage,
      pointPrelevementNameAliases: ['Forage historique'],
      declarant: {
        declarantRole: 'PRELEVEUR',
        preleveurType: 'IRRIGANT',
        siret: '12345678900012',
        socialReason: 'EARL des Prés',
        user: {firstName: null, lastName: null, deletedAt: null}
      },
      collecteurs: [{collecteurUserId: 'collecteur-1'}],
      connectors: [{id: 'connector-1'}]
    }]
  }])

  t.deepEqual(summary.searchAliases, [
    'Ancien forage',
    'Forage communal',
    'Puits des Prés',
    'Forage historique'
  ])
  t.deepEqual(summary.searchIdentifiers, ['BSS-001', 'BNPE-001', 'LOCAL-42'])
  t.is(summary.communeName, 'Saint-Étienne')
  t.deepEqual(summary.managementZones, [{id: 'zone-1', code: '42', name: 'Loire'}])
  t.deepEqual(summary.exploitationStatuses, ['EN_ACTIVITE'])
  t.deepEqual(summary.preleveurLabels, ['EARL des Prés'])
  t.deepEqual(summary.preleveurSirets, ['12345678900012'])
  t.deepEqual(summary.preleveurTypes, ['IRRIGANT'])
  t.is(summary.collecteurStatus, 'WITH_COLLECTEUR')
  t.is(summary.connectorStatus, 'WITH_CONNECTOR')
  t.deepEqual(summary.searchAccess, {exploitations: true, declarants: true})
  t.false(Object.hasOwn(summary, 'codeBNPE'))
  t.false(Object.hasOwn(summary, 'identifiers'))
})

test('les agrégats cartographiques sensibles respectent les droits par zone', t => {
  const [summary] = serializePointMapSummaries([{
    id: 'point-1',
    otherNames: 'Alias public',
    zones: [{
      zoneId: 'zone-map',
      zone: {id: 'zone-map', code: 'MAP', name: 'Zone carte'}
    }],
    declarants: [{
      status: 'EN_ACTIVITE',
      pointPrelevementNameAliases: ['Alias exploitation'],
      declarant: {
        declarantRole: 'PRELEVEUR',
        preleveurType: 'ICPE',
        siret: '12345678900012',
        socialReason: 'Identité protégée',
        user: {deletedAt: null}
      },
      collecteurs: [],
      connectors: []
    }]
  }], {
    readableDeclarantZoneIds: new Set(),
    readableExploitationZoneIds: new Set(),
    visibleZoneIds: new Set(['zone-map'])
  })

  t.deepEqual(summary.searchAliases, ['Alias public'])
  t.deepEqual(summary.exploitationStatuses, [])
  t.deepEqual(summary.preleveurLabels, [])
  t.is(summary.collecteurStatus, null)
  t.is(summary.connectorStatus, null)
  t.deepEqual(summary.searchAccess, {exploitations: false, declarants: false})
})
