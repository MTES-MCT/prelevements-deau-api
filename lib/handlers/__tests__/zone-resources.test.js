import test from 'ava'

import {
  getZoneListCapabilities,
  getZoneDeclarantBaseWhere,
  getZoneDeclarantInclude,
  listDeclarantOptionsForZone,
  normalizeZoneExploitationListQuery,
  parseListQuery,
  scopeZoneListQuery
} from '../zone-resources.js'

test('parseListQuery accepte les multi-valeurs et conserve les alias historiques', t => {
  const query = parseListQuery({
    page: '2',
    pageSize: '250',
    query: '  captage église  ',
    status: 'en activité,terminée',
    usageCodes: ['2', '5'],
    waterBodyTypes: ['souterrain', 'transition'],
    flowTypes: 'prelevement,rejet',
    preleveurTypes: 'irrigant,icpe',
    collecteur: 'avec collecteur',
    connectorStatus: 'without_connector',
    sort: 'name',
    order: 'asc'
  })

  t.is(query.page, 2)
  t.is(query.perPage, 100)
  t.is(query.search, 'captage église')
  t.is(query.sort, 'NAME')
  t.is(query.order, 'ASC')
  t.deepEqual(query.filters.exploitationStatuses, ['EN_ACTIVITE', 'TERMINEE'])
  t.deepEqual(query.filters.usageCodes, ['2', '5'])
  t.deepEqual(query.filters.waterBodyTypes, ['SOUTERRAIN', 'TRANSITION'])
  t.deepEqual(query.filters.flowTypes, ['PRELEVEMENT', 'REJET'])
  t.deepEqual(query.filters.preleveurTypes, ['IRRIGANT', 'ICPE'])
  t.is(query.filters.collecteurStatus, 'WITH_COLLECTEUR')
  t.is(query.filters.connectorStatus, 'WITHOUT_CONNECTOR')
  t.is(query.filters.status, 'EN_ACTIVITE')
})

test('les filtres croisés de zone sont neutralisés quand le droit manque', t => {
  const capabilities = getZoneListCapabilities(
    {role: 'INSTRUCTOR'},
    {permissions: [{permission: 'pp.list'}, {permission: 'declarant.list'}]}
  )
  const query = parseListQuery({
    preleveurTypes: 'IRRIGANT',
    usageCodes: '2',
    status: 'EN_ACTIVITE',
    collecteurStatus: 'WITH_COLLECTEUR',
    connectorStatus: 'WITH_CONNECTOR',
    activityRange: 'LT_30_DAYS'
  })
  const scoped = scopeZoneListQuery(query, capabilities)

  t.deepEqual(capabilities, {
    canReadDeclarants: true,
    canReadExploitations: false,
    canReadPointDetails: false
  })
  t.deepEqual(scoped.filters.preleveurTypes, ['IRRIGANT'])
  t.is(scoped.filters.activityRange, 'LT_30_DAYS')
  t.deepEqual(scoped.filters.usageCodes, [])
  t.deepEqual(scoped.filters.exploitationStatuses, [])
  t.is(scoped.filters.collecteurStatus, null)
  t.is(scoped.filters.connectorStatus, null)
})

test('un administrateur dispose de toutes les capacités de liste de zone', t => {
  t.deepEqual(getZoneListCapabilities({role: 'ADMIN'}, {permissions: []}), {
    canReadDeclarants: true,
    canReadExploitations: true,
    canReadPointDetails: true
  })
})

test('la liste des exploitations conserve le tri historique par création', t => {
  const defaultQuery = normalizeZoneExploitationListQuery(parseListQuery({}))
  const searchQuery = normalizeZoneExploitationListQuery(parseListQuery({
    query: 'captage'
  }))
  const ascendingQuery = normalizeZoneExploitationListQuery(parseListQuery({
    sort: 'created_at',
    order: 'asc'
  }))

  t.is(defaultQuery.sort, 'CREATED_AT')
  t.is(defaultQuery.order, 'DESC')
  t.is(searchQuery.sort, 'RELEVANCE')
  t.is(ascendingQuery.sort, 'CREATED_AT')
  t.is(ascendingQuery.order, 'ASC')
})

test('getZoneDeclarantBaseWhere limite la requête aux identifiants effectifs et échoue fermé', t => {
  t.deepEqual(getZoneDeclarantBaseWhere([], 'COLLECTEUR'), {
    id: {in: []},
    role: 'DECLARANT',
    deletedAt: null,
    declarant: {declarantRole: 'COLLECTEUR'}
  })
  t.deepEqual(getZoneDeclarantBaseWhere([
    'declarant-1',
    'declarant-1',
    'declarant-2'
  ]), {
    id: {in: ['declarant-1', 'declarant-2']},
    role: 'DECLARANT',
    deletedAt: null
  })
})

test('les documents de recherche de zone écartent les liens de collecteurs supprimés', t => {
  const include = getZoneDeclarantInclude('zone-1')
  const declarantInclude = include.declarant.include

  t.deepEqual(
    declarantInclude.pointPrelevements.include.collecteurs.where,
    {collecteur: {user: {deletedAt: null}}}
  )
  t.deepEqual(
    declarantInclude.collecteurExploitations.include.exploitation.include.collecteurs.where,
    {collecteur: {user: {deletedAt: null}}}
  )
  t.deepEqual(
    declarantInclude.pointPrelevements.include.secondaryUsageLinks,
    {include: {usage: true}, orderBy: {usageId: 'asc'}}
  )
  t.deepEqual(
    declarantInclude.collecteurExploitations.include.exploitation.include.secondaryUsageLinks,
    {include: {usage: true}, orderBy: {usageId: 'asc'}}
  )
})

test('listDeclarantOptionsForZone résout le périmètre effectif avant de charger les options', async t => {
  let userQuery
  let effectiveZoneQueries = 0
  const client = {
    async $queryRaw() {
      effectiveZoneQueries += 1
      return [{declarantUserId: 'declarant-1', zoneId: 'zone-1'}]
    },
    user: {
      async findMany(query) {
        userQuery = query
        return [{
          id: 'declarant-1',
          email: 'declarant@example.test',
          declarant: {
            declarantRole: 'PRELEVEUR',
            socialReason: 'Déclarant 1'
          }
        }]
      }
    }
  }

  const options = await listDeclarantOptionsForZone('zone-1', {client})

  t.is(effectiveZoneQueries, 1)
  t.deepEqual(userQuery.where, {
    id: {in: ['declarant-1']},
    role: 'DECLARANT',
    deletedAt: null
  })
  t.is(options.length, 1)
  t.is(options[0].id, 'declarant-1')
})

test('listDeclarantOptionsForZone ne charge aucun utilisateur sans preuve effective', async t => {
  const client = {
    async $queryRaw() {
      return []
    },
    user: {
      async findMany() {
        t.fail('Une zone sans déclarant effectif doit rester fermée.')
      }
    }
  }

  t.deepEqual(await listDeclarantOptionsForZone('zone-1', {client}), [])
})
