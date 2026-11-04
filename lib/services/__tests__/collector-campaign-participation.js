import test from 'ava'
import {getCollectorCampaignParticipationOptions, prepareCollectorCampaignParticipation, addCollectorCampaignParticipation} from '../collector-campaign-participation.js'
import {validateCampaignParticipationBody, validateCampaignParticipationOptions} from '../../validation/collector-campaign-participation-validation.js'

const COLLECTOR = '11111111-1111-4111-8111-111111111111'
const CAMPAIGN = '22222222-2222-4222-8222-222222222222'
const OWNER = '33333333-3333-4333-8333-333333333333'
const POINT = '44444444-4444-4444-8444-444444444444'
const EXPLOITATION = '55555555-5555-4555-8555-555555555555'
const RESPONSE = '66666666-6666-4666-8666-666666666666'
const OTHER = '77777777-7777-4777-8777-777777777777'
const NOW = new Date('2026-11-04T10:00:00Z')
const user = {id: COLLECTOR, role: 'DECLARANT'}
const pick = (record, select) => record && Object.fromEntries(Object.keys(select).map(key => [key, record[key]]))

function fixture() {
  const calls = []
  const state = {
    enabled: true, delegated: true, responses: [], audits: [],
    campaign: {id: CAMPAIGN, collecteurUserId: COLLECTOR, name: 'Collecte synthétique', status: 'OPEN',
      opensOn: new Date('2026-10-01Z'), closesOn: new Date('2026-12-13Z'), closedAt: null},
    exploitation: {id: EXPLOITATION, declarantUserId: OWNER, pointPrelevementId: POINT, status: 'EN_ACTIVITE',
      startDate: null, endDate: null, excludeFromQuickDeclaration: true,
      declarant: {declarantRole: 'PRELEVEUR', quickDeclarationEnabled: true, user: {role: 'DECLARANT', deletedAt: null}},
      pointPrelevement: {deletedAt: null, flowType: 'PRELEVEMENT', collectionMode: null}}
  }
  const tx = {
    async $queryRaw(strings) { calls.push(['sql', strings.join('')]); return [] },
    async $executeRaw(strings) { calls.push(['sql', strings.join('')]); return 0 },
    declarant: {async findFirst(query) {
      calls.push(['management', query])
      return {pointManagementEnabled: state.enabled, pointManagementZones: []}
    }},
    declarantPointPrelevement: {async findFirst(query) {
      calls.push(['exploitation', query])
      return state.delegated && query.where.collecteurs.some.collecteurUserId === COLLECTOR ? state.exploitation : null
    }},
    collectionCampaign: {
      async findFirst({where}) {
        return where.id === state.campaign.id && where.collecteurUserId === state.campaign.collecteurUserId ? state.campaign : null
      },
      async findMany(query) { calls.push(['campaigns', query]); return [{...state.campaign, responses: state.responses.map(row => ({id: row.id}))}] },
      async count(query) { calls.push(['count', query]); return 1 }
    },
    collectionResponse: {
      async findUnique({where, select}) {
        const {campaignId, exploitationId} = where.campaignId_exploitationId
        return pick(state.responses.find(row => row.campaignId === campaignId && row.exploitationId === exploitationId), select)
      },
      async create({data, select}) {
        calls.push(['create', data])
        const record = {id: state.responses.length ? OTHER : RESPONSE, ...data, revision: 0, firstSubmittedAt: null,
          lastSubmittedAt: null, declarationId: null, publicationStatus: 'NOT_SUBMITTED', draftData: null, submittedData: null}
        state.responses.push(record)
        return pick(record, select)
      }
    }
  }
  const client = {...tx, async $transaction(fn, options) {
    calls.push(['transaction', options])
    const before = structuredClone(state)
    try { return await fn(tx) } catch (error) { Object.assign(state, before); throw error }
  }}
  return {state, calls, tx, options: {client, now: NOW, onAdded: mutation => state.audits.push(mutation)}}
}

test('inscription crée seulement la réponse de l’exploitation déléguée et une mutation après commit', async t => {
  const {state, calls, options} = fixture()
  const result = await addCollectorCampaignParticipation(user, CAMPAIGN, {exploitationId: EXPLOITATION}, options)
  t.deepEqual(result, {campaignParticipation: {campaignId: CAMPAIGN, responseId: RESPONSE, created: true}})
  t.deepEqual(calls.find(([name]) => name === 'create')[1], {campaignId: CAMPAIGN, exploitationId: EXPLOITATION, preleveurUserId: OWNER})
  t.is(state.audits.length, 1)
  t.is(state.audits[0].entityType, 'COLLECTION_RESPONSE')
  t.is(state.audits[0].after.pointPrelevementId, POINT)
  t.false(Object.hasOwn(state.audits[0].after, 'submittedData'))
  t.is(calls[0][1].isolationLevel, 'Serializable')
  const locks = calls.filter(([name]) => name === 'sql').map(([, sql]) => sql)
  t.regex(locks[0], /FOR UPDATE OF d, u/)
  t.regex(locks[1], /collection-campaign/)
  t.regex(locks[2], /CollectionCampaign.*FOR UPDATE/)
  t.regex(locks[3], /FOR SHARE OF p/)
})

test('un rejeu après clôture conserve entièrement brouillon, envoi, révision et publication', async t => {
  const {state, options} = fixture()
  await addCollectorCampaignParticipation(user, CAMPAIGN, {exploitationId: EXPLOITATION}, options)
  Object.assign(state.responses[0], {revision: 7, draftData: {comment: 'Modification'}, submittedData: {comment: 'Réponse'},
    firstSubmittedAt: NOW, lastSubmittedAt: NOW, declarationId: OTHER, publicationStatus: 'PUBLISHED'})
  state.campaign.closedAt = NOW
  const before = structuredClone(state.responses)
  const replay = await addCollectorCampaignParticipation(user, CAMPAIGN, {exploitationId: EXPLOITATION}, options)
  t.false(replay.campaignParticipation.created)
  t.is(replay.campaignParticipation.responseId, RESPONSE)
  t.deepEqual(state.responses, before)
  t.is(state.audits.length, 1)
})

test('deux exploitations du même point ont chacune leur formulaire', async t => {
  const {state, options} = fixture()
  await addCollectorCampaignParticipation(user, CAMPAIGN, {exploitationId: EXPLOITATION}, options)
  state.exploitation.id = OTHER
  await addCollectorCampaignParticipation(user, CAMPAIGN, {exploitationId: OTHER}, options)
  t.is(state.responses.length, 2)
  t.deepEqual(state.responses.map(row => row.exploitationId), [EXPLOITATION, OTHER])
})

for (const [title, mutate, status, code] of [
  ['habilitation retirée', state => { state.enabled = false }, 403],
  ['autre collecteur de campagne', state => { state.campaign.collecteurUserId = OTHER }, 404],
  ['délégation retirée', state => { state.delegated = false }, 404],
  ['campagne clôturée', state => { state.campaign.closedAt = NOW }, 409, 'CAMPAIGN_NOT_OPEN'],
  ['campagne archivée', state => { state.campaign.status = 'ARCHIVED' }, 409, 'CAMPAIGN_NOT_OPEN'],
  ['campagne future', state => { state.campaign.opensOn = new Date('2027-01-01Z') }, 409, 'CAMPAIGN_NOT_OPEN'],
  ['campagne dépassée', state => { state.campaign.closesOn = new Date('2026-11-03Z') }, 409, 'CAMPAIGN_NOT_OPEN'],
  ['exploitation future', state => { state.exploitation.startDate = new Date('2026-11-05Z') }, 409, 'CAMPAIGN_EXPLOITATION_INELIGIBLE'],
  ['exploitation terminée', state => { state.exploitation.status = 'TERMINEE' }, 409, 'CAMPAIGN_EXPLOITATION_INELIGIBLE'],
  ['période terminée', state => { state.exploitation.endDate = new Date('2026-11-03Z') }, 409, 'CAMPAIGN_EXPLOITATION_INELIGIBLE'],
  ['saisie désactivée', state => { state.exploitation.declarant.quickDeclarationEnabled = false }, 409, 'CAMPAIGN_EXPLOITATION_INELIGIBLE'],
  ['point externe', state => { state.exploitation.pointPrelevement.collectionMode = 'EXTERNAL' }, 409, 'CAMPAIGN_EXPLOITATION_INELIGIBLE'],
  ['point de rejet', state => { state.exploitation.pointPrelevement.flowType = 'REJET' }, 409, 'CAMPAIGN_EXPLOITATION_INELIGIBLE'],
  ['point supprimé', state => { state.exploitation.pointPrelevement.deletedAt = NOW }, 409, 'CAMPAIGN_EXPLOITATION_INELIGIBLE'],
  ['compte supprimé', state => { state.exploitation.declarant.user.deletedAt = NOW }, 409, 'CAMPAIGN_EXPLOITATION_INELIGIBLE']
]) {
  test(`l’inscription refuse ${title} sans création ni audit`, async t => {
    const {state, options} = fixture()
    mutate(state)
    const error = await t.throwsAsync(addCollectorCampaignParticipation(user, CAMPAIGN, {exploitationId: EXPLOITATION}, options))
    t.is(error.status, status)
    if (code) t.is(error.data.code, code)
    t.is(state.responses.length, 0)
    t.is(state.audits.length, 0)
  })
}

test('un rôle humain différent et un compte sans identité ne peuvent inscrire', async t => {
  for (const actor of [{id: COLLECTOR, role: 'ADMIN'}, {id: COLLECTOR, role: 'INSTRUCTOR'}, {role: 'DECLARANT'}]) {
    const {state, options} = fixture()
    // eslint-disable-next-line no-await-in-loop -- Independent denied actors.
    t.is((await t.throwsAsync(addCollectorCampaignParticipation(actor, CAMPAIGN, {exploitationId: EXPLOITATION}, options))).status, 403)
    t.is(state.responses.length, 0)
  }
})

test('la préparation refuse une campagne fermée avant la création des objets', async t => {
  const {state, tx} = fixture()
  state.campaign.closedAt = NOW
  t.is((await t.throwsAsync(prepareCollectorCampaignParticipation(tx, {user, campaignId: CAMPAIGN, now: NOW}))).data.code, 'CAMPAIGN_NOT_OPEN')
  t.is(state.responses.length, 0)
})

test('les options sont bornées, restreintes au collecteur et ne chargent aucune réponse détaillée', async t => {
  const {calls, options} = fixture()
  const result = await getCollectorCampaignParticipationOptions(user, {page: '2', pageSize: '20'}, options)
  t.deepEqual(result.campaigns, [{id: CAMPAIGN, name: 'Collecte synthétique', opensOn: '2026-10-01', closesOn: '2026-12-13', eligible: true}])
  const query = calls.find(([name]) => name === 'campaigns')[1]
  t.is(query.where.collecteurUserId, COLLECTOR)
  t.is(query.take, 20)
  t.is(query.skip, 20)
  t.false(Object.hasOwn(query.select, 'responses'))
})

test('options et ajout appliquent le même blocage de saisie manuelle, sans masquer un formulaire existant', async t => {
  const {state, options, calls} = fixture()
  state.exploitation.declarant.quickDeclarationEnabled = false
  const unavailable = await getCollectorCampaignParticipationOptions(user, {exploitationId: EXPLOITATION}, options)
  t.false(unavailable.campaigns[0].eligible)
  t.regex(unavailable.campaigns[0].reason, /saisie manuelle/)
  state.responses.push({id: RESPONSE})
  state.campaign.closedAt = NOW
  const existing = await getCollectorCampaignParticipationOptions(user, {exploitationId: EXPLOITATION}, options)
  t.is(existing.campaigns[0].responseId, RESPONSE)
  t.false(existing.campaigns[0].eligible)
  const query = calls.find(([name]) => name === 'campaigns')[1]
  t.deepEqual(query.select.responses.select, {id: true})
})

test('un conflit SQL devient un conflit réessayable sans audit de création', async t => {
  const {options, state} = fixture()
  options.client.$transaction = async () => { throw {code: 'P2010', meta: {driverAdapterError: {cause: {originalCode: '40001'}}}} }
  const error = await t.throwsAsync(addCollectorCampaignParticipation(user, CAMPAIGN, {exploitationId: EXPLOITATION}, options))
  t.is(error.status, 409)
  t.is(error.data.code, 'CAMPAIGN_PARTICIPATION_CONFLICT')
  t.is(state.audits.length, 0)
})

test('validation refuse les identités imposées par le client et borne la pagination', t => {
  t.deepEqual(validateCampaignParticipationBody({exploitationId: EXPLOITATION}), {exploitationId: EXPLOITATION})
  for (const body of [{}, {exploitationId: 'bad'}, {exploitationId: EXPLOITATION, preleveurUserId: OTHER}]) {
    t.is(t.throws(() => validateCampaignParticipationBody(body)).statusCode, 400)
  }
  t.is(t.throws(() => validateCampaignParticipationOptions({pageSize: 101})).statusCode, 400)
  t.is(t.throws(() => validateCampaignParticipationOptions({collecteurUserId: OTHER})).statusCode, 400)
})

test('inscription et options incluent la date de fin du jour français courant', async t => {
  const {state, options, calls} = fixture()
  options.now = new Date('2026-11-03T23:30:00Z')
  state.exploitation.startDate = new Date('2026-11-04Z')
  state.exploitation.endDate = new Date('2026-11-04Z')
  const choices = await getCollectorCampaignParticipationOptions(user, {exploitationId: EXPLOITATION}, options)
  t.true(choices.campaigns[0].eligible)
  const openWhere = calls.find(([name]) => name === 'campaigns')[1].where.OR[0]
  t.deepEqual(openWhere.closesOn, {gte: new Date('2026-11-04Z')})
  t.true((await addCollectorCampaignParticipation(user, CAMPAIGN, {exploitationId: EXPLOITATION}, options)).campaignParticipation.created)
})
