import test from 'ava'
import {getCampaignOptions} from '../campaigns.js'

function fixture() {
  const queries = {}
  const database = {
    zone: {async findMany(input) {
      queries.zones = input
      return [{id: 'zone', name: 'Territoire', type: 'SAGE', code: 'SAGE-1'}]
    }},
    declarant: {
      async findUnique() {
        return {declarantRole: 'COLLECTEUR'}
      },
      async findMany() {
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
