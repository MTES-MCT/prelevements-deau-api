import test from 'ava'
import {assertCollectorPointLocation, assertCollectorPointManagementEnabled, getCollectorPointManagement,
  getCollectorPointRights, updateCollectorPoint, updateCollectorPointManagement} from '../collector-point-management.js'

const collectorId = 'd29e4212-7917-4fb1-b66d-a9d53b3349de'
const pointId = 'f593f99b-dc2a-479a-9c04-c4ad74d3a503'
const zoneId = '8e5768a8-de21-49a7-a762-d08c75996564'
const user = {id: collectorId, role: 'DECLARANT'}
const zone = {id: zoneId, code: 'dep-47', type: 'DEPARTEMENT', name: 'Zone synthétique'}
const now = new Date('2026-10-07T12:00:00.000Z')
const point = {id: pointId, updatedAt: now, waterBodyType: 'SUPERFICIELLE', nature: 'PLAN_EAU',
  coordinates: {type: 'Point', coordinates: [1, 44]}}

function clientFixture({enabled = true, delegated = true, exceptional = false, shared = false} = {}) {
  const calls = []
  const client = {
    declarant: {
      async findFirst(query) {
        calls.push(['collector', query])
        return {pointManagementEnabled: enabled, pointManagementZones: [{zone}]}
      }
    },
    declarantPointPrelevement: {async findMany(query) {
      calls.push(['delegations', query])
      return delegated ? [{pointPrelevementId: pointId}] : []
    }},
    pointPrelevement: {async findMany(query) {
      calls.push(['points', query])
      return [{id: pointId, waterBodyType: point.waterBodyType, zones: [{zoneId: exceptional ? 'exceptional-zone' : zoneId}], _count: {declarants: shared ? 2 : 1}}]
    }},
    async $queryRaw(strings) {
      const sql = strings.join('?')
      calls.push(['sql', sql])
      if (sql.includes('FOR UPDATE OF d, u')) return [{userId: collectorId}]
      if (sql.includes('ST_AsGeoJSON')) return [point]
      if (sql.includes('FOR SHARE OF e, link')) return delegated ? [{id: 'delegation'}] : []
      return [{pointId, ...zone}]
    },
    async $transaction(callback, options) {
      calls.push(['transaction', options])
      return callback(client)
    }
  }
  return {client, calls}
}

test('configuration conserve uniquement le périmètre explicite', async t => {
  const {client} = clientFixture()
  t.deepEqual(await getCollectorPointManagement(collectorId, {client}), {enabled: true, zoneIds: [zoneId], zones: [zone]})
  t.is((await t.throwsAsync(() => assertCollectorPointManagementEnabled({role: 'ADMIN'}, {client}))).status, 403)
  t.is((await t.throwsAsync(() => updateCollectorPointManagement(collectorId, {enabled: true, zoneIds: [zoneId]}, {user, client}))).status, 403)
})

test('habilitation révoquée interdit la création et l’édition', async t => {
  const {client, calls} = clientFixture({enabled: false})
  t.is((await t.throwsAsync(() => assertCollectorPointManagementEnabled(user, {client, lock: true}))).status, 403)
  t.true(calls[0][1].includes('FOR UPDATE OF d, u'))
  t.is((await getCollectorPointRights(user, [pointId], {client})).size, 0)
})

test('un ancien rattachement ne permet pas de gérer le point', async t => {
  const {client, calls} = clientFixture({delegated: false})
  t.is((await getCollectorPointRights(user, [pointId], {client, now})).size, 0)
  const query = calls.find(([name]) => name === 'delegations')[1]
  t.deepEqual(query.where.status, {in: ['EN_ACTIVITE', 'NON_RENSEIGNE']})
  t.deepEqual(query.where.collecteurs, {some: {collecteurUserId: collectorId}})
  t.is(calls.filter(([name]) => name === 'points').length, 0)
})

test('point partagé reste modifiable sans exposer les bénéficiaires', async t => {
  const {client, calls} = clientFixture({shared: true})
  const right = (await getCollectorPointRights(user, [pointId], {client, now})).get(pointId)
  t.true(right.canEdit)
  t.true(right.isShared)
  t.true(right.canEditLocation)
  t.is(right.editScope, 'COLLECTOR')
  t.false(right.editableFields.includes('name'))
  t.false(right.editableFields.includes('internalComment'))
  t.is(calls.length, 4)
})

test('rattachement exceptionnel bloque seulement localisation et milieu', async t => {
  const {client} = clientFixture({exceptional: true})
  const right = (await getCollectorPointRights(user, [pointId], {client})).get(pointId)
  t.true(right.canEdit)
  t.false(right.canEditLocation)
  const error = await t.throwsAsync(() => updateCollectorPoint(pointId, {
    expectedUpdatedAt: now.toISOString(), coordinates: {type: 'Point', coordinates: [2, 44]}
  }, {user, client, now}), {message: /rattachements particuliers/})
  t.is(error.status, 409)
})

test('la localisation nouvelle doit être couverte par une zone explicitement autorisée', async t => {
  const {client} = clientFixture()
  t.deepEqual(await assertCollectorPointLocation({enabled: true, zoneIds: [zoneId]}, point.coordinates, point.waterBodyType, {client}), [zoneId])
  t.is((await t.throwsAsync(() => assertCollectorPointLocation({enabled: true, zoneIds: []}, point.coordinates, point.waterBodyType, {client}))).status, 403)
})

test('édition verrouille puis revérifie habilitation, rattachement et version', async t => {
  const {client, calls} = clientFixture()
  t.is((await t.throwsAsync(() => updateCollectorPoint(pointId, {expectedUpdatedAt: '2026-01-01T00:00:00.000Z', usageName: 'Nom'}, {user, client, now}))).status, 409)
  t.deepEqual(calls[0], ['transaction', {isolationLevel: 'Serializable'}])
  t.true(calls.some(([name, sql]) => name === 'sql' && sql.includes('FOR SHARE OF e, link')))
  const revoked = clientFixture({enabled: false}).client
  t.is((await t.throwsAsync(() => updateCollectorPoint(pointId, {expectedUpdatedAt: now.toISOString(), usageName: 'Nom'}, {user, client: revoked, now}))).status, 403)
  const undelegated = clientFixture({delegated: false}).client
  t.is((await t.throwsAsync(() => updateCollectorPoint(pointId, {expectedUpdatedAt: now.toISOString(), usageName: 'Nom'}, {user, client: undelegated, now}))).status, 403)
})

test('conflit sérialisable retourne une erreur métier sans rejouer automatiquement', async t => {
  const client = {$transaction: async () => { throw Object.assign(new Error('conflict'), {code: 'P2034'}) }}
  t.is((await t.throwsAsync(() => updateCollectorPoint(pointId, {expectedUpdatedAt: now.toISOString(), usageName: 'Nom'}, {user, client}))).status, 409)
})
