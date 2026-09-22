import test from 'ava'

import {
  createMatrixRows,
  createMissingDeclarationsWorkbook,
  getZoneListCapabilities,
  getZoneDeclarantBaseWhere,
  getZoneDeclarantInclude,
  listDeclarantOptionsForZone,
  normalizeZoneExploitationListQuery,
  parseListQuery,
  scopeZoneListQuery
} from '../zone-resources.js'

const matrixPeriod = {key: '2026-06', periodType: 'month', fullLabel: 'Juin 2026', start: new Date('2026-06-01'), end: new Date('2026-06-30T23:59:59Z')}
const matrixExploitation = {
  id: 'exploitation-1', countingCode: '001', pointPrelevementId: 'point-1', declarantUserId: 'owner-1', status: 'EN_ACTIVITE',
  declarant: {userId: 'owner-1', socialReason: 'Préleveur synthétique', user: {email: 'owner@example.test'}},
  pointPrelevement: {id: 'point-1', name: 'Point synthétique', zones: [{zone: {declarationSettings: {defaultPeriodType: 'MONTH'}}}]}
}
const matrixChunk = {
  pointPrelevementId: 'point-1', preleveurUserId: 'owner-1', minDate: '2026-06-01', maxDate: '2026-06-30',
  source: {declaration: {id: 'declaration-1', declarantUserId: 'owner-1'}}
}

test('le suivi ne valide pas deux comptages à partir de la déclaration d’une seule exploitation', t => {
  const matrix = createMatrixRows({
    exploitations: [matrixExploitation, {...matrixExploitation, id: 'exploitation-2', countingCode: '002'}],
    chunks: [{...matrixChunk, exploitationId: matrixExploitation.id}], periods: [matrixPeriod]
  })
  t.deepEqual(matrix.rows.map(row => [row.countingCode, row.cells[0].status]), [['001', 'DECLARED'], ['002', 'MISSING']])
  t.is(matrix.summary.declared, 1)
  t.is(matrix.summary.missing, 1)
})

test('le suivi historique sans exploitation reste compatible avec un couple unique et échoue fermé en cas ambigu', t => {
  const unique = createMatrixRows({exploitations: [matrixExploitation], chunks: [matrixChunk], periods: [matrixPeriod]})
  t.is(unique.rows[0].cells[0].status, 'DECLARED')
  const ambiguous = createMatrixRows({
    exploitations: [matrixExploitation, {...matrixExploitation, id: 'exploitation-2', countingCode: '002'}],
    chunks: [matrixChunk], periods: [matrixPeriod]
  })
  t.deepEqual(ambiguous.rows.map(row => row.cells[0].status), ['MISSING', 'MISSING'])
})

test('l’export du suivi conserve deux lignes et les zéros des codes comptage', t => {
  const matrix = createMatrixRows({
    exploitations: [matrixExploitation, {...matrixExploitation, id: 'exploitation-2', countingCode: '002'}],
    chunks: [], periods: [matrixPeriod]
  })
  const workbook = createMissingDeclarationsWorkbook({matrix, periods: [matrixPeriod]})
  const sheet = workbook.getWorksheet('Non déclarants')
  t.is(sheet.rowCount, 3)
  t.is(sheet.getCell('G1').value, 'Code comptage')
  t.is(sheet.getCell('G2').value, '001')
  t.is(sheet.getCell('G3').value, '002')
  t.is(sheet.autoFilter.to, 'M1')
})

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
