import test from 'ava'

import {
  getDeclarantZoneUpdatePlan,
  getDeclarantRelationsOptions,
  getInstructorZoneScope,
  parseDeclarantsSearchQuery
} from '../declarants.js'

test('parseDeclarantsSearchQuery normalise la pagination, la recherche et les filtres', t => {
  t.deepEqual(parseDeclarantsSearchQuery({
    page: '3',
    pageSize: '50',
    query: '  Dupont  ',
    role: 'collecteur',
    declarantType: 'legal_person',
    preleveurType: 'irrigant',
    emailStatus: 'without_email',
    collecteurStatus: 'with_collecteur',
    connectorStatus: 'without_connector',
    activityRange: 'days_30_90',
    zoneIds: [
      '73e76b9a-0b61-43e0-a45c-99052970ab14',
      'invalid',
      '73e76b9a-0b61-43e0-a45c-99052970ab14'
    ],
    usageCodes: ['5.1.1', '5.1.1,5.5.1'],
    waterBodyTypes: 'superficielle,transition',
    exploitationStatuses: ['en_activite', 'terminee'],
    sort: 'last_declaration',
    order: 'asc'
  }), {
    page: 3,
    pageSize: 50,
    query: 'Dupont',
    role: 'COLLECTEUR',
    declarantType: 'LEGAL_PERSON',
    preleveurType: 'IRRIGANT',
    emailStatus: 'WITHOUT_EMAIL',
    collecteurStatus: 'WITH_COLLECTEUR',
    connectorStatus: 'WITHOUT_CONNECTOR',
    activityRange: 'DAYS_30_90',
    sort: 'LAST_DECLARATION',
    order: 'ASC',
    zoneIds: ['73e76b9a-0b61-43e0-a45c-99052970ab14'],
    usageCodes: ['5.1.1', '5.5.1'],
    waterBodyTypes: ['SUPERFICIELLE', 'TRANSITION'],
    exploitationStatuses: ['EN_ACTIVITE', 'TERMINEE']
  })
})

test('parseDeclarantsSearchQuery borne les valeurs et ignore les filtres inconnus', t => {
  t.deepEqual(parseDeclarantsSearchQuery({
    page: '-2',
    perPage: '500',
    role: 'ADMIN',
    email: 'ALL'
  }), {
    page: 1,
    pageSize: 100,
    query: '',
    role: null,
    declarantType: null,
    preleveurType: null,
    emailStatus: null,
    collecteurStatus: null,
    connectorStatus: null,
    activityRange: null,
    sort: 'RELEVANCE',
    order: 'DESC',
    zoneIds: [],
    usageCodes: [],
    waterBodyTypes: [],
    exploitationStatuses: []
  })
})

test('getInstructorZoneScope transmet uniquement le périmètre des instructeurs', t => {
  t.deepEqual(getInstructorZoneScope({
    user: {role: 'INSTRUCTOR'},
    permittedZoneIds: ['zone-1']
  }), {
    zoneIds: ['zone-1']
  })
  t.deepEqual(getInstructorZoneScope({
    user: {role: 'INSTRUCTOR'}
  }), {
    zoneIds: []
  })
  t.deepEqual(getInstructorZoneScope({
    user: {role: 'ADMIN'},
    permittedZoneIds: ['zone-1']
  }), {})
  t.deepEqual(getInstructorZoneScope({
    user: {role: 'DECLARANT'},
    permittedZoneIds: ['zone-1']
  }), {})
})

test('getDeclarantRelationsOptions calcule séparément les zones où les exploitations sont lisibles', async t => {
  const now = new Date('2026-08-04T12:00:00.000Z')
  let permissionQuery
  const client = {
    instructorZone: {
      async findMany(arguments_) {
        permissionQuery = arguments_
        return [{zoneId: 'zone-exploitation'}]
      }
    }
  }

  t.deepEqual(await getDeclarantRelationsOptions({
    id: 'instructor-1',
    role: 'INSTRUCTOR'
  }, {client, now}), {
    exploitationZoneIds: ['zone-exploitation']
  })
  t.deepEqual(permissionQuery.where.permissions, {
    some: {permission: 'exploitation.list'}
  })
  t.deepEqual(permissionQuery.where.AND, [
    {startDate: {lte: now}},
    {OR: [{endDate: null}, {endDate: {gte: now}}]}
  ])
  t.deepEqual(await getDeclarantRelationsOptions({role: 'ADMIN'}, {
    client: {
      instructorZone: {
        findMany: () => t.fail('Un administrateur ne doit pas charger un scope de zone.')
      }
    }
  }), {})
})

test('getDeclarantZoneUpdatePlan promeut seulement les zones dérivées inchangées que l’agent gère', async t => {
  const now = new Date('2026-08-04T12:00:00.000Z')
  let permissionQuery
  const client = {
    instructorZone: {
      async findMany(arguments_) {
        permissionQuery = arguments_
        return [{zoneId: 'zone-managed'}]
      }
    }
  }
  const currentLinks = [
    {zoneId: 'zone-managed', source: 'DECLARATION'},
    {zoneId: 'zone-outside', source: 'EXPLOITATION'},
    {zoneId: 'zone-persistent', source: 'CREATION'}
  ]

  t.deepEqual(await getDeclarantZoneUpdatePlan({
    currentLinks,
    effectiveZoneIds: ['zone-managed', 'zone-outside', 'zone-persistent'],
    nextZoneIds: currentLinks.map(link => link.zoneId),
    user: {id: 'instructor-1', role: 'INSTRUCTOR'}
  }, {client, now}), {
    addedZoneIds: [],
    removedZoneIds: [],
    promotableZoneIds: ['zone-managed']
  })
  t.deepEqual(permissionQuery.where.zoneId, {
    in: ['zone-managed', 'zone-outside']
  })
  t.deepEqual(permissionQuery.where.permissions, {
    some: {permission: 'declarant.zone.update'}
  })
})

test('getDeclarantZoneUpdatePlan conserve le contrôle strict des ajouts et suppressions', async t => {
  const client = {
    instructorZone: {
      async findMany() {
        return [{zoneId: 'zone-removed'}]
      }
    }
  }

  const error = await t.throwsAsync(getDeclarantZoneUpdatePlan({
    currentLinks: [{zoneId: 'zone-removed', source: 'MANUAL'}],
    nextZoneIds: ['zone-added'],
    user: {id: 'instructor-1', role: 'INSTRUCTOR'}
  }, {client}))

  t.is(error.status, 403)
})

test('getDeclarantZoneUpdatePlan permet à un administrateur de promouvoir toutes les provenances dérivées', async t => {
  t.deepEqual(await getDeclarantZoneUpdatePlan({
    currentLinks: [
      {zoneId: 'zone-1', source: 'EXPLOITATION'},
      {zoneId: 'zone-2', source: 'RECONCILIATION'}
    ],
    effectiveZoneIds: ['zone-1', 'zone-2'],
    nextZoneIds: ['zone-1', 'zone-2', 'zone-3'],
    user: {id: 'admin-1', role: 'ADMIN'}
  }, {client: {}}), {
    addedZoneIds: ['zone-3'],
    removedZoneIds: [],
    promotableZoneIds: ['zone-1', 'zone-2']
  })
})

test('getDeclarantZoneUpdatePlan ne promeut pas une zone dérivée obsolète lors d’un ajout administrateur', async t => {
  t.deepEqual(await getDeclarantZoneUpdatePlan({
    currentLinks: [
      {zoneId: 'zone-stale', source: 'EXPLOITATION'}
    ],
    effectiveZoneIds: [],
    nextZoneIds: ['zone-stale', 'zone-added'],
    user: {id: 'admin-1', role: 'ADMIN'}
  }, {client: {}}), {
    addedZoneIds: ['zone-added'],
    removedZoneIds: [],
    promotableZoneIds: []
  })
})

test('getDeclarantZoneUpdatePlan ne charge pas les droits sans zone dérivée à promouvoir', async t => {
  const client = {
    instructorZone: {
      findMany: () => t.fail('Un périmètre de promotion vide doit rester vide.')
    }
  }

  t.deepEqual(await getDeclarantZoneUpdatePlan({
    currentLinks: [{zoneId: 'zone-1', source: 'MANUAL'}],
    nextZoneIds: ['zone-1'],
    user: {id: 'instructor-1', role: 'INSTRUCTOR'}
  }, {client}), {
    addedZoneIds: [],
    removedZoneIds: [],
    promotableZoneIds: []
  })
})
