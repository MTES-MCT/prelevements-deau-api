import test from 'ava'
import {getCampaignOptions} from '../campaigns.js'

function fixture({zones = [{id: 'zone', name: 'Territoire', type: 'SAGE', code: 'SAGE-1'}], declarantRole = 'COLLECTEUR', permittedZoneIds = ['zone']} = {}) {
  const queries = {}
  const database = {
    zone: {async findMany(input) {
      queries.zones = input
      return zones
    }},
    instructorZone: {async findMany(input) {
      queries.permissions = input
      return permittedZoneIds.map(zoneId => ({zoneId}))
    }},
    declarant: {
      async findUnique() {
        return {declarantRole}
      },
      async findMany(input) {
        queries.collecteurs ??= []
        queries.collecteurs.push(input)
        return [{userId: 'owner', socialReason: 'Organisme', user: {}}]
      }
    },
    sandreWaterUse: {async findMany(input) {
      queries.usages = input
      return [{id: 'usage', label: 'Irrigation', code: '2', color: '#00AA00'}]
    }},
    declarantPointPrelevement: {
      async findFirst(input) {
        queries.cursor = input
        return input.where.id === 'first' ? {id: 'first'} : null
      },
      async findMany(input) {
        queries.exploitations = input
        return ['first', 'second'].map(id => ({id, pointPrelevementId: 'point', usage: {id: 'usage', label: 'Irrigation', code: '2', color: '#00AA00'}}))
      },
      async count(input) {
        queries.total = input
        return 501
      },
      async groupBy(input) {
        queries.ambiguities = input
        return [{pointPrelevementId: 'point', _count: {_all: 2}}]
      }
    }
  }
  return {queries, database}
}

test('les usages et ambiguïtés restent limités au territoire et à l’organisme, avant recherche et pagination', async t => {
  const {database, queries} = fixture()
  const result = await getCampaignOptions({id: 'owner', role: 'DECLARANT'}, {zoneId: 'zone', ownerCollecteurUserId: 'owner', usageId: 'usage', q: 'Jean Dupont', limit: 1, client: database})
  t.deepEqual(result.usages, [{id: 'usage', name: 'Irrigation', code: '2', color: '#00AA00'}])
  t.deepEqual(result.exploitations[0].usage, {id: 'usage', name: 'Irrigation', code: '2', color: '#00AA00'})
  t.deepEqual(queries.exploitations.include.usage.select, {id: true, label: true, code: true, color: true})
  t.deepEqual(queries.usages.select, {id: true, label: true, code: true, color: true})
  t.true(result.exploitations[0].ambiguousPoint)
  t.deepEqual(result.pagination, {total: 501, limit: 1, hasMore: true, nextCursor: 'first'})
  t.is(queries.exploitations.where.usageId, 'usage')
  t.is(queries.exploitations.where.AND.length, 2)
  t.deepEqual(queries.exploitations.where.collecteurs, {some: {collecteurUserId: 'owner'}})
  t.deepEqual(queries.exploitations.where.pointPrelevement.zones, {some: {zoneId: 'zone'}})
  t.deepEqual(queries.total.where, queries.exploitations.where)
  t.deepEqual(queries.usages.where.exploitations.some, queries.ambiguities.where)
  t.false(Object.hasOwn(queries.ambiguities.where, 'usageId'))
  t.false(Object.hasOwn(queries.ambiguities.where, 'AND'))
  t.deepEqual(queries.zones.select, {id: true, name: true, type: true, code: true})
})

for (const role of ['ADMIN', 'INSTRUCTOR', 'DECLARANT']) {
  test(`${role} : seules les zones occupées par des exploitations et comptes actifs sont proposées`, async t => {
    const {database, queries} = fixture()
    await getCampaignOptions({id: 'owner', role}, {client: database})
    const point = queries.zones.where.pointPrelevementZones.some.pointPrelevement
    const exploitation = point.declarants.some
    t.is(point.deletedAt, null)
    t.deepEqual(exploitation.status, {in: ['EN_ACTIVITE', 'NON_RENSEIGNE']})
    t.deepEqual(exploitation.declarant, {declarantRole: 'PRELEVEUR', user: {deletedAt: null}})
    t.deepEqual(exploitation.collecteurs.some.collecteur, {declarantRole: 'COLLECTEUR', user: {deletedAt: null}})
    t.is(exploitation.collecteurs.some.collecteurUserId, role === 'DECLARANT' ? 'owner' : undefined)
    t.deepEqual(queries.zones.where.id, role === 'INSTRUCTOR' ? {in: ['zone']} : undefined)
    for (const query of queries.collecteurs) {
      const scope = query.where.collecteurExploitations.some.exploitation
      t.deepEqual(scope.status, exploitation.status)
      t.deepEqual(scope.declarant, exploitation.declarant)
      t.is(scope.pointPrelevement.deletedAt, null)
      t.deepEqual(scope.pointPrelevement.zones, {some: {zoneId: 'zone'}})
    }

    if (role === 'INSTRUCTOR') {
      t.deepEqual(queries.permissions.where.permissions, {some: {permission: 'campaign.manage'}})
      t.is(queries.permissions.where.instructorUserId, 'owner')
      t.truthy(queries.permissions.where.AND)
    }
  })

  test(`${role} : une liste de territoires vide ne divulgue aucun collecteur ni point`, async t => {
    const {database, queries} = fixture({zones: []})
    const result = await getCampaignOptions({id: 'owner', role}, {client: database})
    t.deepEqual(result, {zones: [], collecteurs: [], managers: [], exploitations: [], usages: [], pagination: {total: 0, limit: 500, hasMore: false, nextCursor: null}})
    t.is(queries.collecteurs, undefined)
    t.is(queries.exploitations, undefined)
    const error = await t.throwsAsync(() => getCampaignOptions({id: 'owner', role}, {zoneId: 'empty', client: database}))
    t.is(error.statusCode, 403)
  })
}

for (const role of ['DECLARANT', 'INSTRUCTOR', 'SERVICE_ACCOUNT']) {
  test(`${role} : sans droit de gestion ni rôle collecteur, aucune option n’est accessible`, async t => {
    const {database, queries} = fixture({declarantRole: 'PRELEVEUR', permittedZoneIds: []})
    const error = await t.throwsAsync(() => getCampaignOptions({id: 'owner', role}, {client: database}))
    t.is(error.statusCode, 403)
    t.is(queries.zones, undefined)
    t.is(queries.collecteurs, undefined)
  })
}

test('la pagination valide son curseur dans les résultats filtrés et conserve un ordre stable', async t => {
  const {database, queries} = fixture()
  const user = {id: 'owner', role: 'DECLARANT'}
  await getCampaignOptions(user, {cursor: 'first', usageId: 'usage', client: database})
  t.deepEqual(queries.exploitations.cursor, {id: 'first'})
  t.is(queries.exploitations.skip, 1)
  t.deepEqual(queries.exploitations.orderBy, [{pointPrelevement: {name: 'asc'}}, {id: 'asc'}])
  t.is(queries.cursor.where.usageId, 'usage')
  const cursorError = await t.throwsAsync(() => getCampaignOptions(user, {cursor: 'outside', client: database}))
  const zoneError = await t.throwsAsync(() => getCampaignOptions(user, {zoneId: 'outside', client: database}))
  const ownerError = await t.throwsAsync(() => getCampaignOptions(user, {ownerCollecteurUserId: 'outside', client: database}))
  t.is(cursorError.statusCode, 400)
  t.is(zoneError.statusCode, 403)
  t.is(ownerError.statusCode, 403)
})
