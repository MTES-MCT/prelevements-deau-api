import test from 'ava'
import express from 'express'
import request from 'supertest'

import {createZoneResourceSettingsHandlers} from '../zone-resource-settings.js'
import {createRoutes} from '../../routes.js'
import {ZONE_AGENT_MANAGEMENT_PERMISSIONS} from '../../constants/zone-permissions.js'
import {findAuditAction} from '../../audit/catalog.js'
import {buildAuditMutations} from '../../audit/mutations.js'

const ZONE_ID = '11111111-1111-4111-8111-111111111111'
const USER = {id: '22222222-2222-4222-8222-222222222222', role: 'INSTRUCTOR'}
const ZONE = {id: ZONE_ID, code: 'sage-test', type: 'SAGE', name: 'SAGE fictif', managedResourceType: 'MIXTE'}
const PATH = `/zones/${ZONE_ID}/resource-settings`

function fixture({user = USER, authType = 'USER_SESSION', impersonation, permissions = ['zone.detail.read'], zone = ZONE} = {}) {
  const writes = []
  let stored = zone ? {...zone} : null
  let lastRequest
  const client = {
    zone: {
      async findUnique() { return stored ? {...stored} : null },
      async update(args) {
        writes.push(args)
        stored = {...stored, ...args.data}
        return {...stored}
      }
    },
    async $transaction(execute) { return execute(client) }
  }
  const handlers = createZoneResourceSettingsHandlers({client,
    checkPermission: async (actor, permission, zoneIds) => actor.role === 'INSTRUCTOR'
      && actor.id === USER.id && zoneIds.length === 1 && zoneIds[0] === ZONE_ID && permissions.includes(permission)})
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = user
    req.userRole = user?.role
    req.auth = user ? {type: authType, user, role: user.role, impersonation} : null
    req.auditEventId = 'synthetic-audit-event'
    req.auditAction = findAuditAction(req.method, req.path)
    lastRequest = req
    next()
  })
  const routes = createRoutes({zoneResourceSettingsHandlers: handlers})
  app.use('/', routes)
  app.use('/api', routes)
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({message: error.message}))
  return {app, writes, getRequest: () => lastRequest, getZone: () => stored}
}

test('un lecteur de la zone consulte le type sans capacité de modification', async t => {
  const db = fixture()
  const response = await request(db.app).get(PATH)
  t.is(response.status, 200)
  t.deepEqual(response.body, {data: {managedResourceType: 'MIXTE'}, canEdit: false})
  t.is(response.headers['cache-control'], 'no-store')
  t.deepEqual(db.writes, [])
})

test('un administrateur global et un gestionnaire complet modifient uniquement cet attribut PE', async t => {
  await Promise.all([{user: {...USER, role: 'ADMIN'}}, {permissions: ['zone.detail.read', ...ZONE_AGENT_MANAGEMENT_PERMISSIONS]}].map(async options => {
    const db = fixture(options)
    const response = await request(db.app).patch(PATH).send({managedResourceType: 'SOUTERRAIN'})
    t.is(response.status, 200)
    t.deepEqual(response.body, {data: {managedResourceType: 'SOUTERRAIN'}, canEdit: true})
    t.deepEqual(db.writes, [{where: {id: ZONE_ID}, data: {managedResourceType: 'SOUTERRAIN'}}])
    t.is(db.getZone().name, ZONE.name)
    const req = db.getRequest()
    const mutations = buildAuditMutations(req, req.auditAction)
    t.is(mutations.length, 1)
    t.deepEqual(mutations[0].changedFields, ['managedResourceType'])
    t.is(mutations[0].before.managedResourceType, 'MIXTE')
    t.is(mutations[0].after.managedResourceType, 'SOUTERRAIN')
  }))
})

test('chaque permission de gestion manquante bloque la modification et aucune valeur isAdmin cliente ne suffit', async t => {
  await Promise.all(ZONE_AGENT_MANAGEMENT_PERMISSIONS.map(async missing => {
    const db = fixture({permissions: ['zone.detail.read', ...ZONE_AGENT_MANAGEMENT_PERMISSIONS.filter(permission => permission !== missing)]})
    t.is((await request(db.app).patch(PATH).send({managedResourceType: 'MIXTE'})).status, 403)
    t.deepEqual(db.writes, [])
  }))
  const db = fixture()
  t.is((await request(db.app).patch(PATH).send({managedResourceType: 'MIXTE', isAdmin: true})).status, 400)
  t.deepEqual(db.writes, [])
})

test('les sessions non autorisées, les comptes de service et les impersonations ne peuvent pas modifier le SAGE', async t => {
  const cases = [
    [{user: null}, 401],
    [{user: {...USER, role: 'DECLARANT'}}, 403],
    [{user: {...USER, role: 'ADMIN'}, authType: 'SERVICE_ACCOUNT_ACCESS'}, 403],
    [{user: {...USER, role: 'ADMIN'}, impersonation: {actorId: USER.id}}, 403],
    [{user: {...USER, role: 'ADMIN', deletedAt: new Date()}}, 403]
  ]
  await Promise.all(cases.map(async ([options, status]) => {
    const db = fixture(options)
    t.is((await request(db.app).patch(PATH).send({managedResourceType: 'MIXTE'})).status, status)
    t.deepEqual(db.writes, [])
  }))
})

test('un agent sans droit sur cette zone ne peut ni la lire ni la modifier', async t => {
  const db = fixture({permissions: []})
  t.is((await request(db.app).get(PATH)).status, 403)
  t.is((await request(db.app).patch(PATH).send({managedResourceType: 'MIXTE'})).status, 403)
  t.deepEqual(db.writes, [])
})

test('le contrat refuse les types absents, inconnus, null et les champs supplémentaires', async t => {
  await Promise.all([{}, {managedResourceType: null}, {managedResourceType: 'surface'}, {managedResourceType: ['MIXTE']},
    {managedResourceType: 'MIXTE', name: 'Un autre nom'}, {managedResourceType: 'MIXTE', type: 'REGION'}].map(async body => {
    const db = fixture({user: {...USER, role: 'ADMIN'}})
    t.is((await request(db.app).patch(PATH).send(body)).status, 400)
    t.deepEqual(db.writes, [])
  }))
})

test('les quatre valeurs sont acceptées et le préfixe API reste compatible', async t => {
  await Promise.all(['SUPERFICIELLE', 'SOUTERRAIN', 'TRANSITION', 'MIXTE'].map(async managedResourceType => {
    const db = fixture({user: {...USER, role: 'ADMIN'}})
    const response = await request(db.app).patch(`/api${PATH}`).send({managedResourceType})
    t.is(response.status, 200)
    t.is(response.body.data.managedResourceType, managedResourceType)
  }))
})

test('les zones non-SAGE, inexistantes et les identifiants invalides sont rejetés sans écriture', async t => {
  await Promise.all([[{...ZONE, type: 'REGION'}, 400], [{...ZONE, type: 'DEPARTEMENT'}, 400], [null, 404]].map(async ([zone, expected]) => {
    const db = fixture({user: {...USER, role: 'ADMIN'}, zone})
    t.is((await request(db.app).get(PATH)).status, expected)
    t.is((await request(db.app).patch(PATH).send({managedResourceType: 'MIXTE'})).status, expected)
    t.deepEqual(db.writes, [])
  }))
  const db = fixture({user: {...USER, role: 'ADMIN'}})
  t.is((await request(db.app).get('/zones/invalid/resource-settings')).status, 400)
})
