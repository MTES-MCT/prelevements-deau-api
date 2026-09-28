import test from 'ava'
import express from 'express'
import request from 'supertest'
import {createImportAliasResolver, resolvePointImportAlias} from '../import-aliases.js'
import {createPointResolver} from '../../resolvers.js'

const SOURCE = '11111111-1111-5111-8111-111111111111'
const TARGET = '22222222-2222-4222-8222-222222222222'
const THIRD = '33333333-3333-4333-8333-333333333333'
const alias = (source = SOURCE, target = TARGET, extra = {}) => ({provider: 'pe-import-alias', scope: 'epidropt', kind: 'POINT', externalId: source, pointPrelevementId: target, ...extra})

test('seuls les alias PE explicites du périmètre résolvent un UUID, jamais un retrait ni une référence fournisseur', t => {
  const resolve = createImportAliasResolver([alias(), alias(THIRD, SOURCE, {provider: 'pe-import-retired'}),
    alias(THIRD, SOURCE, {scope: 'other'}), alias(THIRD, SOURCE, {provider: 'rives-et-eaux'})], {scope: 'epidropt', points: [{id: TARGET}]})
  t.is(resolve.point(SOURCE), TARGET)
  t.is(resolve.point(TARGET), TARGET)
  t.is(resolve.point(THIRD), THIRD)
})

test('les chaînes sont résolues sans tolérer cycles, conflits ou cible absente/supprimée', t => {
  t.is(createImportAliasResolver([alias(), alias(TARGET, THIRD)], {points: [{id: THIRD}]}).point(SOURCE), THIRD)
  for (const [refs, options, message] of [
    [[alias(), alias(TARGET, SOURCE)], {}, 'IMPORT_ALIAS_CYCLE'],
    [[alias(), alias(SOURCE, THIRD)], {}, 'IMPORT_ALIAS_CONFLICT'],
    [[alias(SOURCE, null)], {}, 'IMPORT_ALIAS_CONFLICT'],
    [[alias()], {points: []}, 'IMPORT_ALIAS_TARGET_MISSING'],
    [[alias()], {points: [{id: TARGET, deletedAt: new Date()}]}, 'IMPORT_ALIAS_TARGET_MISSING']
  ]) t.throws(() => createImportAliasResolver(refs, options).point(SOURCE), {message})
})

test('les exploitations fusionnées se résolvent par ancien UUID ou sourceId import, sans cacher les contradictions', t => {
  const refs = [alias(SOURCE, TARGET, {metadata: {exploitationAliases: [
    {sourceId: 'old', targetId: 'kept', sourceSourceId: 'old-source'}
  ]}})]
  const resolve = createImportAliasResolver(refs, {exploitations: [{id: 'kept'}]})
  t.is(resolve.exploitation('old'), 'kept')
  t.is(resolve.exploitation('generated', 'old-source'), 'kept')
  t.is(resolve.exploitation('kept'), 'kept')
  t.throws(() => createImportAliasResolver(refs, {exploitations: []}).exploitation('old'), {message: 'IMPORT_ALIAS_TARGET_MISSING'})
  refs[0].metadata.exploitationAliases.push({sourceId: 'old', targetId: 'different'})
  t.throws(() => createImportAliasResolver(refs).exploitation('old'), {message: 'IMPORT_ALIAS_CONFLICT'})
})

test('la résolution DB est bornée, vérifie la cible active, et ne mélange pas les périmètres d’import', async t => {
  const queries = []
  const client = {
    externalReference: {async findMany({where}) {
      queries.push(where)
      return where.externalId === SOURCE ? [{pointPrelevementId: TARGET}] : []
    }},
    pointPrelevement: {async findUnique() { return {id: TARGET, deletedAt: null} }}
  }
  t.is(await resolvePointImportAlias(client, SOURCE, {scope: 'epidropt'}), TARGET)
  t.true(queries.every(where => where.provider === 'pe-import-alias' && where.kind === 'POINT' && where.scope === 'epidropt'))
  client.pointPrelevement.findUnique = async () => null
  await t.throwsAsync(resolvePointImportAlias(client, SOURCE), {message: 'IMPORT_ALIAS_TARGET_MISSING'})
})

function appFixture({allowed = true, resolveAlias = async () => TARGET, deletedAt = null} = {}) {
  const app = express()
  const seen = []
  app.use((req, _res, next) => { req.auditEventId = 'synthetic-audit-event'; next() })
  app.param('pointId', createPointResolver({resolveAlias,
    getById: async id => ({id, deletedAt}), getByName: async name => ({id: TARGET, name, deletedAt})}))
  app.get('/points-prelevement/:pointId', (req, res) => {
    seen.push({pointId: req.point.id, parameter: req.params.pointId, metadata: req.auditContext?.metadata})
    // Permissions are necessarily evaluated AFTER resolving the target, never
    // against the former point's territorial or exploitation links.
    res.status(allowed && req.point.id === TARGET ? 200 : 403).json({id: req.point.id})
  })
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({message: error.message}))
  return {app, seen}
}

test('le resolver HTTP transmet l’identité canonique aux handlers et conserve l’ancien UUID dans l’audit', async t => {
  const {app, seen} = appFixture()
  const response = await request(app).get(`/points-prelevement/${SOURCE}`)
  t.is(response.status, 200)
  t.is(response.body.id, TARGET)
  t.deepEqual(seen, [{pointId: TARGET, parameter: TARGET, metadata: {requestedPointId: SOURCE}}])
  const denied = appFixture({allowed: false})
  t.is((await request(denied.app).get(`/points-prelevement/${SOURCE}`)).status, 403)
})

test('un alias invalide ou une cible supprimée reste 404 sans exécuter le handler protégé', async t => {
  await Promise.all([{deletedAt: new Date()}, {resolveAlias: async () => { throw new Error('IMPORT_ALIAS_CONFLICT') }}].map(async options => {
    const {app, seen} = appFixture(options)
    t.is((await request(app).get(`/points-prelevement/${SOURCE}`)).status, 404)
    t.deepEqual(seen, [])
  }))
})

test('l’audit d’écriture remplace l’ancienne cible et son snapshot avant le handler', async t => {
  const req = {params: {pointId: SOURCE}, auditEventId: 'test-event',
    auditAction: {target: {type: 'POINT', param: 'pointId'}, params: {pointId: SOURCE}},
    auditContext: {metadata: {}, mutationBefore: {id: SOURCE}}}
  const point = {id: TARGET}
  let continued = false
  await createPointResolver({resolveAlias: async () => TARGET, getById: async () => point,
    captureMutation: async request => {
      t.is(request.auditAction.params.pointId, TARGET)
      request.auditContext.mutationBefore = point
    }})(req, {}, () => { continued = true })
  t.true(continued)
  t.deepEqual(req.auditContext.target, {id: TARGET, type: 'POINT'})
  t.is(req.auditContext.mutationBefore.id, TARGET)
  t.is(req.auditContext.metadata.requestedPointId, SOURCE)
})
