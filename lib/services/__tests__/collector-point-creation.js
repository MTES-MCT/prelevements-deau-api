import test from 'ava'
import createHttpError from 'http-errors'
import {createCollectorPoint} from '../collector-point-creation.js'
import {validateCollectorPointCreation} from '../../validation/collector-point-creation-validation.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const REQUEST_ID = '22222222-2222-4222-8222-222222222222'
const PRELEVEUR_ID = '33333333-3333-4333-8333-333333333333'
const POINT_ID = '44444444-4444-4444-8444-444444444444'
const EXPLOITATION_ID = '55555555-5555-4555-8555-555555555555'
const USAGE_ID = '66666666-6666-4666-8666-666666666666'

function payload() {
  return {
    requestId: REQUEST_ID,
    point: {name: 'Point synthétique', waterBodyType: 'SOUTERRAIN', flowType: 'PRELEVEMENT', coordinates: {type: 'Point', coordinates: [1, 44]}},
    preleveur: {firstName: 'Test', lastName: 'Synthétique', preleveurType: 'IRRIGANT'},
    exploitation: {usageId: USAGE_ID, status: 'EN_ACTIVITE'}
  }
}

function fixture() {
  const calls = []
  const state = {request: null, points: 0, preleveurs: 0, exploitations: 0, emails: 0}
  const tx = {
    async $queryRaw(strings) { calls.push(['sql', strings.join('')]); return [] },
    user: {async findFirst() { return null }},
    userEmailAlias: {async findUnique() { return null }},
    userEmailVerification: {async findFirst() { return null }},
    declarantContactEmail: {async findFirst() { return null }},
    declarant: {async findFirst(query) { calls.push(['followed', query]); return {userId: PRELEVEUR_ID} }},
    declarantPointPrelevement: {async findFirst() { return {id: EXPLOITATION_ID} }},
    collectorPointCreationRequest: {
      async findUnique({where}) {
        return state.request?.requestId === where.collecteurUserId_requestId.requestId ? state.request : null
      },
      async create({data}) { state.request = data },
      async update({data}) { Object.assign(state.request, data) }
    }
  }
  const options = {
    user: {id: USER_ID, role: 'DECLARANT'},
    client: {
      async $transaction(fn, transactionOptions) {
        calls.push(['transaction', transactionOptions])
        const before = structuredClone(state)
        try { return await fn(tx) } catch (error) { Object.assign(state, before); throw error }
      },
      collectorPointCreationRequest: tx.collectorPointCreationRequest
    },
    async checkManagement(user, settings) { calls.push(['management', user, settings]); return {enabled: true, zoneIds: ['zone']} },
    async checkLocation(...args) { calls.push(['location', ...args]); return ['zone'] },
    async createPreleveur(data, {client}) {
      calls.push(['preleveur', data, client === tx]); state.preleveurs++
      return {userId: PRELEVEUR_ID, user: {id: PRELEVEUR_ID, email: data.email}}
    },
    async createPoint(data, {client}) {
      calls.push(['point', data, client === tx]); state.points++
      return {id: POINT_ID, ...data}
    },
    async createExploitation(data, {client}) {
      calls.push(['exploitation', data, client === tx]); state.exploitations++
      return {id: EXPLOITATION_ID, ...data}
    },
    async notifyAccountCreation() { calls.push(['mail', Boolean(state.request)]); state.emails++ },
    async onCreated() { calls.push(['audit', Boolean(state.request)]) }
  }
  return {options, calls, state, tx}
}

test('création atomique avec identités imposées, transaction sérialisée et aucun email par défaut', async t => {
  const {options, calls, state} = fixture()
  const result = await createCollectorPoint(payload(), options)
  t.is(result.preleveurId, PRELEVEUR_ID)
  t.is(result.exploitationId, EXPLOITATION_ID)
  t.false(result.replayed)
  t.deepEqual(result.notification, {status: 'not_requested'})
  t.is(state.emails, 0)
  t.is(calls.find(call => call[0] === 'transaction')[1].isolationLevel, 'Serializable')
  t.true(calls.find(call => call[0] === 'management')[2].lock)
  const exploitation = calls.find(call => call[0] === 'exploitation')
  t.deepEqual(exploitation[1].collecteurUserIds, [USER_ID])
  t.is(exploitation[1].declarantUserId, PRELEVEUR_ID)
  t.is(exploitation[1].pointPrelevementId, POINT_ID)
  for (const name of ['point', 'preleveur', 'exploitation']) t.true(calls.find(call => call[0] === name)[2])
  t.true(calls.find(call => call[0] === 'audit')[1])
})

test('une même demande ne crée et ne notifie qu’une fois, même avec ordre des propriétés différent', async t => {
  const {options, state, calls} = fixture()
  const input = payload()
  input.preleveur.email = 'test@example.org'
  input.notifyAccountCreation = true
  const first = await createCollectorPoint(input, options)
  const replay = await createCollectorPoint(Object.fromEntries(Object.entries(input).reverse()), options)
  t.deepEqual(replay, {...first, replayed: true})
  t.is(state.points, 1)
  t.is(state.preleveurs, 1)
  t.is(state.exploitations, 1)
  t.is(state.emails, 1)
  t.is(calls.filter(call => call[0] === 'audit').length, 1)
  t.true(calls.find(call => call[0] === 'mail')[1])
})

test('une demande rejouée avec un autre contenu renvoie un conflit', async t => {
  const {options, state} = fixture()
  await createCollectorPoint(payload(), options)
  const input = payload()
  input.point.name = 'Autre nom'
  const error = await t.throwsAsync(createCollectorPoint(input, options))
  t.is(error.statusCode, 409)
  t.is(state.points, 1)
})

test('échec exploitation annule compte, point et idempotence, sans notification ni audit', async t => {
  const {options, state, calls} = fixture()
  options.createExploitation = async () => { throw createHttpError(400, 'Usage invalide') }
  await t.throwsAsync(createCollectorPoint(payload(), options))
  t.is(state.points, 0)
  t.is(state.preleveurs, 0)
  t.is(state.request, null)
  t.false(calls.some(call => ['mail', 'audit'].includes(call[0])))
})

test('préleveur existant exige une exploitation actuelle du collecteur sans créer de compte', async t => {
  const {options, tx, state, calls} = fixture()
  const input = payload()
  delete input.preleveur
  input.preleveurId = PRELEVEUR_ID
  await createCollectorPoint(input, options)
  t.is(state.preleveurs, 0)
  const where = calls.find(call => call[0] === 'followed')[1].where
  t.deepEqual(where.pointPrelevements.some.collecteurs, {some: {collecteurUserId: USER_ID}})
  t.deepEqual(where.pointPrelevements.some.status, {in: ['EN_ACTIVITE', 'NON_RENSEIGNE']})
  t.is(where.pointPrelevements.some.AND.length, 2)
  tx.declarant.findFirst = async () => null
  input.requestId = POINT_ID
  const error = await t.throwsAsync(createCollectorPoint(input, options))
  t.is(error.statusCode, 403)
  t.is(state.points, 1)
})

for (const kind of ['primary', 'alias', 'reservation', 'contact', 'siret']) {
  test(`doublon ${kind} refusé sans révéler de compte ni créer de point`, async t => {
    const {options, tx, state} = fixture()
    const input = payload()
    input.preleveur.email = 'test@example.org'
    input.preleveur.siret = '12345678900012'
    if (kind === 'primary') tx.user.findFirst = async () => ({id: PRELEVEUR_ID})
    if (kind === 'alias') tx.userEmailAlias.findUnique = async () => ({id: PRELEVEUR_ID})
    if (kind === 'reservation') tx.userEmailVerification.findFirst = async () => ({id: PRELEVEUR_ID})
    if (kind === 'contact') tx.declarantContactEmail.findFirst = async () => ({id: PRELEVEUR_ID})
    if (kind === 'siret') tx.$queryRaw = async strings => strings.join('').includes('FROM "Declarant"') ? [{userId: PRELEVEUR_ID}] : []
    const error = await t.throwsAsync(createCollectorPoint(input, options))
    t.is(error.statusCode, 409)
    t.false(error.message.includes(PRELEVEUR_ID))
    t.false(error.message.includes(input.preleveur.email))
    t.is(state.points, 0)
    t.is(state.preleveurs, 0)
  })
}

test('habilitation révoquée bloque aussi le rejeu, et position hors zone bloque avant toute création', async t => {
  const {options, state} = fixture()
  await createCollectorPoint(payload(), options)
  options.checkManagement = async () => { throw createHttpError(403, 'Droit révoqué') }
  t.is((await t.throwsAsync(createCollectorPoint(payload(), options))).statusCode, 403)
  const other = fixture()
  other.options.checkLocation = async () => { throw createHttpError(403, 'Hors zone') }
  t.is((await t.throwsAsync(createCollectorPoint(payload(), other.options))).statusCode, 403)
  t.is(other.state.points, 0)
  t.is(state.points, 1)
})

test('échec mail conserve les objets créés et le rejeu ne renvoie pas de notification', async t => {
  const {options, state} = fixture()
  let failed = 0
  options.notifyAccountCreation = async () => { failed++; throw new Error('Mail indisponible') }
  const input = payload()
  input.preleveur.email = 'test@example.org'
  input.notifyAccountCreation = true
  const first = await createCollectorPoint(input, options)
  const second = await createCollectorPoint(input, options)
  t.is(first.notification.status, 'failed')
  t.is(second.notification.status, 'failed')
  t.true(second.replayed)
  t.is(failed, 1)
  t.is(state.points, 1)
})

test('échec de persistance du statut mail conserve la réussite et ne renotifie pas au rejeu', async t => {
  const {options, tx, state} = fixture()
  const failures = []
  options.onNotificationError = (error, details) => failures.push({error, ...details})
  tx.collectorPointCreationRequest.update = async () => { throw new Error('Statut non confirmé') }
  const input = payload()
  input.preleveur.email = 'test@example.org'
  input.notifyAccountCreation = true
  const first = await createCollectorPoint(input, options)
  t.is(first.point.id, POINT_ID)
  t.is(first.notification.status, 'pending')
  t.is(state.emails, 1)
  t.is(state.points, 1)
  t.is(failures.length, 1)
  t.is(failures[0].phase, 'status')
  const replay = await createCollectorPoint(input, options)
  t.true(replay.replayed)
  t.is(replay.notification.status, 'pending')
  t.is(state.emails, 1)
})

for (const error of [
  Object.assign(new Error('Unique name'), {code: 'P2002', meta: {modelName: 'PointPrelevement', target: ['name']}}),
  Object.assign(new Error('Raw query failed'), {code: 'P2010', meta: {driverAdapterError: {cause: {
    originalCode: '23505', originalMessage: 'duplicate key value violates unique constraint "PointPrelevement_name_key"'
  }}}})
]) {
  test(`un nom de point déjà pris donne un conflit explicite et non une erreur d’identité (${error.code})`, async t => {
    const {options, state} = fixture()
    options.createPoint = async () => { throw error }
    const result = await t.throwsAsync(createCollectorPoint(payload(), options))
    t.is(result.statusCode, 409)
    t.is(result.message, 'Ce nom de point n’est pas disponible. Choisissez un autre nom.')
    t.is(state.preleveurs, 0)
    t.is(state.request, null)
  })
}

test('une autre contrainte unique n’est pas présentée comme un doublon de préleveur', async t => {
  const {options} = fixture()
  const error = Object.assign(new Error('Other unique constraint'), {code: 'P2002', meta: {modelName: 'PointPrelevement', target: ['id']}})
  options.createPoint = async () => { throw error }
  t.is(await t.throwsAsync(createCollectorPoint(payload(), options)), error)
})

test('conflit de sérialisation réessaie sans doubler les effets externes', async t => {
  const {options, calls, state} = fixture()
  const create = options.createExploitation
  let attempts = 0
  options.createExploitation = async (...args) => {
    if (attempts++ === 0) throw Object.assign(new Error('Concurrent write'), {code: 'P2034'})
    return create(...args)
  }
  await createCollectorPoint(payload(), options)
  t.is(attempts, 2)
  t.is(state.points, 1)
  t.is(state.preleveurs, 1)
  t.is(calls.filter(call => call[0] === 'audit').length, 1)
})

test('une collision concurrente du requestId est rejouée comme une transaction sérialisée', async t => {
  const {options, tx, state} = fixture()
  const insertRequest = tx.collectorPointCreationRequest.create
  let attempts = 0
  tx.collectorPointCreationRequest.create = async (...args) => {
    if (attempts++ === 0) throw Object.assign(new Error('Unique request'), {
      code: 'P2002', meta: {modelName: 'CollectorPointCreationRequest', target: ['collecteurUserId', 'requestId']}
    })
    return insertRequest(...args)
  }
  await createCollectorPoint(payload(), options)
  t.is(attempts, 2)
  t.is(state.points, 1)
})

test('la création refuse les périodes historiques ou futures et le rejeu refuse un lien retiré', async t => {
  await Promise.all([
    {status: 'TERMINEE'}, {status: 'ABANDONNEE'}, {startDate: '2099-01-01'}, {endDate: '2000-01-01'}
  ].map(async exploitation => {
    const {options, state} = fixture()
    const input = payload()
    Object.assign(input.exploitation, exploitation)
    t.is((await t.throwsAsync(createCollectorPoint(input, options))).statusCode, 400)
    t.is(state.points, 0)
  }))

  const {options, tx} = fixture()
  await createCollectorPoint(payload(), options)
  tx.declarantPointPrelevement.findFirst = async () => null
  t.is((await t.throwsAsync(createCollectorPoint(payload(), options))).statusCode, 403)
})

test('validation refuse champs réservés, identités ambiguës, invitation sans nouveau mail et dates incohérentes', t => {
  const invalidPayloads = [
    {...payload(), point: {...payload().point, internalComment: 'Interdit'}},
    {...payload(), point: {...payload().point, pointKind: 'FICTIF'}},
    {...payload(), preleveur: {...payload().preleveur, declarantRole: 'COLLECTEUR'}},
    {...payload(), preleveur: {...payload().preleveur, quickDeclarationEnabled: true}},
    {...payload(), exploitation: {...payload().exploitation, collecteurUserIds: [USER_ID]}},
    {...payload(), preleveurId: PRELEVEUR_ID},
    {...payload(), notifyAccountCreation: true},
    {...payload(), exploitation: {...payload().exploitation, startDate: '2026-02-30'}},
    {...payload(), exploitation: {...payload().exploitation, startDate: '2026-10-02', endDate: '2026-10-01'}}
  ]
  for (const input of invalidPayloads) t.is(t.throws(() => validateCollectorPointCreation(input)).statusCode, 400)
})
