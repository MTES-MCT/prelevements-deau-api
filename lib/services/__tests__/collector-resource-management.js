/* eslint-disable no-await-in-loop -- Each scenario asserts an independent transaction and its rollback. */
import test from 'ava'
import createHttpError from 'http-errors'
import {buildAuditMutations, stageAuditMutation} from '../../audit/mutations.js'
import {
  collectorResourceVersion, pendingCollectorCampaignResponses, isCurrentCollectorExploitation,
  getCollectorExploitationForm, updateCollectorExploitationForm,
  getCollectorPreleveurContactDetails, updateCollectorPreleveurContactDetails, createCollectorExploitation
} from '../collector-resource-management.js'
import {
  validateCollectorExploitationCreation, validateCollectorExploitationUpdate, validateCollectorContactDetails
} from '../../validation/collector-resource-management-validation.js'

const collectorId = '11111111-1111-4111-8111-111111111111'
const ownerId = '22222222-2222-4222-8222-222222222222'
const pointId = '33333333-3333-4333-8333-333333333333'
const exploitationId = '44444444-4444-4444-8444-444444444444'
const usageId = '55555555-5555-4555-8555-555555555555'
const campaignId = '66666666-6666-4666-8666-666666666666'
const requestId = '77777777-7777-4777-8777-777777777777'
const user = {id: collectorId, role: 'DECLARANT'}
const now = new Date('2026-11-04T12:00:00Z')
const version = 'a'.repeat(64)
const campaign = {id: campaignId, name: 'Collecte synthétique', status: 'OPEN', opensOn: new Date('2026-01-01'), closesOn: new Date('2026-12-31'), closedAt: null, collecteurUserId: collectorId}

function fixture() {
  const calls = []
  const state = {enabled: true, delegated: true, history: false, responses: [], meters: [], request: null,
    auth: {email: 'owner@example.test', authVersion: 3, aliases: ['alias@example.test']},
    record: {id: exploitationId, declarantUserId: ownerId, pointPrelevementId: pointId, updatedAt: now,
      usageId, usage: {id: usageId, code: '2', label: 'Usage synthétique'}, secondaryUsageLinks: [],
      status: 'EN_ACTIVITE', startDate: null, endDate: null, countingCode: null, abandonReason: null,
      pointPrelevement: {id: pointId, name: 'Point synthétique', deletedAt: null},
      declarant: {userId: ownerId, socialReason: 'Préleveur synthétique', user: {firstName: 'Test', lastName: 'Synthétique'}}},
    contact: {userId: ownerId, user: {updatedAt: now}, phoneNumber: '0102030405', addressLine1: 'Adresse synthétique', addressLine2: null,
      poBox: null, postalCode: '75000', city: 'Paris', contactEmails: [{id: 'contact', email: 'contact@example.test', isPrimary: true, sourceId: 'source', updatedAt: now}]}}
  const tx = {
    async $queryRaw() { calls.push('lock'); return [] },
    async $executeRaw() { calls.push('lock-campaign') },
    declarant: {
      async findFirst({where, select}) {
        if (where.userId === collectorId) return {pointManagementEnabled: state.enabled, pointManagementZones: []}
        if (!state.delegated) return null
        return select.contactEmails ? structuredClone(state.contact) : {userId: ownerId}
      },
      async update({data}) { calls.push('write-contact'); Object.assign(state.contact, data) }
    },
    user: {async findFirst() { return null }, async update({data}) { calls.push('write-user'); state.contact.user.updatedAt = data.updatedAt }},
    userEmailAlias: {async findUnique() { return null }},
    userEmailVerification: {async findFirst() { return null }},
    declarantContactEmail: {async findFirst() { return null }},
    declarantPointPrelevement: {
      async findFirst({where}) { return state.delegated && (!where.id || where.id === exploitationId) ? structuredClone(state.record) : null },
      async findUniqueOrThrow() { return structuredClone(state.record) }
    },
    compteur: {async findMany() { return state.meters }},
    collectionCampaign: {async findMany() { return state.responses.map(row => ({id: row.campaignId})) }},
    collectionResponse: {async findMany() { return structuredClone(state.responses) }},
    chunk: {async findFirst(query) { calls.push(['history', query]); return state.history ? {id: 'history'} : null }},
    collectorPointCreationRequest: {
      async findUnique() { return state.request },
      async create({data}) { state.request = structuredClone(data) },
      async update({data}) { Object.assign(state.request, data) }
    }
  }
  const client = {async $transaction(fn) {
    const before = structuredClone(state)
    try { return await fn(tx) } catch (error) { Object.assign(state, before); throw error }
  }, ...tx}
  const options = {user, now, client,
    async updateExploitation(id, changes, settings) {
      calls.push(['write-exploitation', id, changes, settings.client === tx])
      Object.assign(state.record, changes, {updatedAt: new Date(now.getTime() + 1)})
      return structuredClone(state.record)
    },
    async saveMeters() { calls.push('write-meter'); return {mutations: []} },
    async replaceContacts(id, contacts, settings) {
      calls.push(['write-emails', id, settings.client === tx])
      state.contact.contactEmails = contacts.map((row, index) => ({...row, id: `contact-${index}`, sourceId: null, updatedAt: now}))
    },
    async onUpdated(mutations) { calls.push(['audit', mutations]) }
  }
  return {state, calls, tx, client, options}
}

test('validation refuse les identités, droits et connexions dans les parcours de modification', t => {
  for (const changes of [{declarantUserId: ownerId}, {pointPrelevementId: pointId}, {collecteurUserIds: [collectorId]}, {connectors: []}, {sourceId: 'source'}]) {
    t.throws(() => validateCollectorExploitationUpdate({version, changes}))
  }
  for (const details of [{email: 'other@example.test'}, {siret: '12345678901234'}, {firstName: 'Autre'}, {socialReason: 'Autre'}, {declarantRole: 'COLLECTEUR'}, {emailAliases: []}]) {
    t.throws(() => validateCollectorContactDetails({version, details}))
  }
  t.throws(() => validateCollectorContactDetails({version, details: {contactEmails: [{email: 'a@example.test', isPrimary: true}, {email: 'b@example.test', isPrimary: true}]}}))
  t.throws(() => validateCollectorExploitationUpdate({version, changes: {startDate: '2026-02-30'}}))
  t.deepEqual(validateCollectorContactDetails({version, details: {phoneNumber: '0102030405', contactEmails: [{email: ' Contact@Example.test ', isPrimary: true}]}}).details,
    {phoneNumber: '0102030405', contactEmails: [{email: 'contact@example.test', isPrimary: true}]})
})

test('version inclut contenu et identités des emails, indépendamment de l’ordre des clés', t => {
  t.is(collectorResourceVersion({a: 1, b: 2}), collectorResourceVersion({b: 2, a: 1}))
  t.not(collectorResourceVersion({contactEmails: [{id: 'one', email: 'a@example.test'}]}), collectorResourceVersion({contactEmails: [{id: 'two', email: 'a@example.test'}]}))
})

test('une période terminant aujourd’hui reste courante pendant toute la journée française', t => {
  t.true(isCurrentCollectorExploitation({status: 'EN_ACTIVITE', startDate: null, endDate: new Date('2026-11-04')}, now))
  t.false(isCurrentCollectorExploitation({status: 'TERMINEE'}, now))
  t.false(isCurrentCollectorExploitation({status: 'EN_ACTIVITE', startDate: new Date('2026-11-05')}, now))
})

test('formulaires non transmis et modifications non transmises bloquent seulement les campagnes ouvertes', t => {
  const response = {id: exploitationId, campaignId, campaign, firstSubmittedAt: null, draftData: null, submittedData: null}
  const submitted = {...response, firstSubmittedAt: now, submittedData: {needs: 1}, draftData: {needs: 1}}
  t.is(pendingCollectorCampaignResponses([response, submitted], now).length, 1)
  t.is(pendingCollectorCampaignResponses([response], now)[0].href, `/campagnes/${campaignId}/reponses/${exploitationId}`)
  t.is(pendingCollectorCampaignResponses([{...submitted, draftData: {needs: 2}}], now).length, 1)
  t.deepEqual(pendingCollectorCampaignResponses([{...response, campaign: {...campaign, status: 'CLOSED'}}], now), [])
})

test('édition autorisée conserve identité et transmet le client de transaction aux modèles', async t => {
  const {options, calls, state} = fixture()
  const updateModel = options.updateExploitation
  options.updateExploitation = async (...args) => ({...await updateModel(...args),
    collecteurs: [{collecteurUserId: collectorId}], connectors: [{id: requestId, connectorType: 'synthetic'}]})
  const form = await getCollectorExploitationForm(exploitationId, options)
  const updated = await updateCollectorExploitationForm(exploitationId, {version: form.version, changes: {countingCode: '42'}}, options)
  t.is(updated.exploitation.countingCode, '42')
  t.is(state.record.declarantUserId, ownerId)
  t.true(calls.find(call => Array.isArray(call) && call[0] === 'write-exploitation')[3])
  t.is(calls.filter(call => Array.isArray(call) && call[0] === 'audit').length, 1)
  const action = {type: 'COLLECTOR.EXPLOITATION_FORM_UPDATED'}
  const request = {auditEventId: 'synthetic', auditAction: action, body: {changes: {countingCode: '42'}}, params: {}}
  for (const mutation of calls.find(call => Array.isArray(call) && call[0] === 'audit')[1]) stageAuditMutation(request, mutation)
  t.deepEqual(buildAuditMutations(request, action)[0].changedFields, ['countingCode'])
})

test('habilitation révoquée, délégation retirée, version périmée et période close refusent sans écriture', async t => {
  for (const failure of ['enabled', 'delegated', 'version', 'closed']) {
    const {options, state, calls} = fixture()
    const form = await getCollectorExploitationForm(exploitationId, options)
    if (failure === 'enabled') state.enabled = false
    if (failure === 'delegated') state.delegated = false
    if (failure === 'closed') state.record.status = 'TERMINEE'
    const error = await t.throwsAsync(updateCollectorExploitationForm(exploitationId, {version: failure === 'version' ? version : form.version, changes: {countingCode: '42'}}, options))
    t.true([403, 404, 409].includes(error.statusCode))
    t.false(calls.some(call => Array.isArray(call) && call[0] === 'write-exploitation'))
  }
})

test('clôture attend le bilan et ne divulgue pas les formulaires d’un autre collecteur', async t => {
  const {options, state, calls} = fixture()
  state.responses = [{id: exploitationId, campaignId, campaign, firstSubmittedAt: null, draftData: null, submittedData: null}]
  const form = await getCollectorExploitationForm(exploitationId, options)
  const error = await t.throwsAsync(updateCollectorExploitationForm(exploitationId, {version: form.version, changes: {status: 'TERMINEE'}}, options))
  t.is(error.data.code, 'COLLECTOR_EXPLOITATION_PENDING_CAMPAIGNS')
  t.is(error.data.pendingCampaignResponses[0].responseId, exploitationId)
  state.responses[0].campaign.collecteurUserId = ownerId
  const hidden = await t.throwsAsync(updateCollectorExploitationForm(exploitationId, {version: form.version, changes: {status: 'TERMINEE'}}, options))
  t.deepEqual(hidden.data.pendingCampaignResponses, [])
  t.true(hidden.data.otherPendingCampaigns)
  t.false(calls.some(call => Array.isArray(call) && call[0] === 'write-exploitation'))
})

test('réduction de période ne laisse aucune mutation si elle exclut l’historique', async t => {
  const {options, state, calls} = fixture()
  state.history = true
  const form = await getCollectorExploitationForm(exploitationId, options)
  const error = await t.throwsAsync(updateCollectorExploitationForm(exploitationId, {version: form.version, changes: {startDate: '2026-01-01'}}, options))
  t.is(error.data.code, 'COLLECTOR_EXPLOITATION_HISTORY_PERIOD')
  t.is(state.record.startDate, null)
  t.false(calls.some(call => Array.isArray(call) && call[0] === 'write-exploitation'))
})

test('réduction de période protège aussi les observations transmises avant leur publication', async t => {
  const {options, state} = fixture()
  state.responses = [{id: exploitationId, campaignId, campaign: {...campaign, type: 'DROPT_INDEX_NEEDS_2026_2027'},
    firstSubmittedAt: now, submittedData: {meters: [{offSeason: {indexStart: 0}, season: {}}]}}]
  const form = await getCollectorExploitationForm(exploitationId, options)
  const error = await t.throwsAsync(updateCollectorExploitationForm(exploitationId, {version: form.version, changes: {startDate: '2026-01-01'}}, options))
  t.is(error.data.code, 'COLLECTOR_EXPLOITATION_HISTORY_PERIOD')
})

test('un compteur seul peut être ajouté sans changement de l’exploitation', async t => {
  const {options, calls} = fixture()
  const form = await getCollectorExploitationForm(exploitationId, options)
  await updateCollectorExploitationForm(exploitationId, {version: form.version, meters: [{serialNumber: 'SYNTHETIC-123'}]}, options)
  t.true(calls.includes('write-meter'))
})

test('coordonnées et emails métier sont atomiques sans toucher à la connexion', async t => {
  const {options, state, calls} = fixture()
  const auth = structuredClone(state.auth)
  const form = await getCollectorPreleveurContactDetails(ownerId, options)
  const updated = await updateCollectorPreleveurContactDetails(ownerId, {version: form.version,
    details: {phoneNumber: '0607080910', contactEmails: [{email: 'new@example.test', isPrimary: true}]}}, options)
  t.is(updated.details.phoneNumber, '0607080910')
  t.deepEqual(updated.details.contactEmails, [{email: 'new@example.test', isPrimary: true}])
  t.deepEqual(state.auth, auth)
  t.true(calls.find(call => Array.isArray(call) && call[0] === 'write-emails')[2])
  t.true(calls.find(call => Array.isArray(call) && call[0] === 'audit')[1].some(mutation => mutation.entityType === 'DECLARANT_CONTACT_EMAIL'))
  const stale = await t.throwsAsync(updateCollectorPreleveurContactDetails(ownerId, {version: form.version, details: {city: 'Lyon'}}, options))
  t.is(stale.statusCode, 409)
})

test('un échec de remplacement des emails annule aussi les coordonnées', async t => {
  const {options, state} = fixture()
  const before = structuredClone(state.contact)
  const form = await getCollectorPreleveurContactDetails(ownerId, options)
  options.replaceContacts = async () => { throw createHttpError(409, 'Conflit synthétique') }
  await t.throwsAsync(updateCollectorPreleveurContactDetails(ownerId, {version: form.version,
    details: {city: 'Lyon', contactEmails: []}}, options))
  t.deepEqual(state.contact, before)
})

function creationFixture() {
  const base = fixture()
  const {state, calls, tx, options} = base
  state.created = 0
  state.notified = 0
  Object.assign(options, {
    async checkPoint() { return {id: pointId, name: 'Point synthétique'} },
    async createPreleveur() { calls.push('create-preleveur'); return {userId: ownerId} },
    async createExploitation(data, settings) { calls.push(['create-exploitation', data, settings.client === tx]); state.created++; return {...data, id: exploitationId} },
    async prepareParticipation() { calls.push('prepare-campaign') },
    async appendParticipation() { calls.push('append-campaign'); return {campaignParticipation: {campaignId, responseId: requestId, created: true}, mutation: {entityType: 'COLLECTION_RESPONSE'}} },
    async onCreated() { calls.push('created-audit') },
    async notify() { state.notified++ }
  })
  return {...base, input: {requestId, preleveurId: ownerId, exploitation: {usageId, status: 'EN_ACTIVITE'}}}
}

test('création sur point existant impose bénéficiaire et délégation et ne notifie pas par défaut', async t => {
  const {options, calls, state, input} = creationFixture()
  const result = await createCollectorExploitation(pointId, input, options)
  t.is(result.exploitationId, exploitationId)
  t.deepEqual(result.notification, {status: 'not_requested'})
  t.false(result.replayed)
  const write = calls.find(call => Array.isArray(call) && call[0] === 'create-exploitation')
  t.deepEqual(write[1].collecteurUserIds, [collectorId])
  t.is(write[1].pointPrelevementId, pointId)
  t.true(write[2])
  t.is(state.notified, 0)
})

test('rejeu après fermeture de campagne conserve la réponse, sans nouvel objet ni notification', async t => {
  const {options, calls, state, input} = creationFixture()
  input.campaignId = campaignId
  const result = await createCollectorExploitation(pointId, input, options)
  options.prepareParticipation = async () => { throw createHttpError(409, 'Campagne fermée') }
  const replay = await createCollectorExploitation(pointId, input, options)
  t.deepEqual(replay, {...result, replayed: true})
  t.is(state.created, 1)
  t.is(calls.filter(call => call === 'append-campaign').length, 1)
  t.is(calls.filter(call => call === 'created-audit').length, 1)
  input.exploitation.countingCode = 'different'
  t.is((await t.throwsAsync(createCollectorExploitation(pointId, input, options))).statusCode, 409)
})

test('refus de campagne annule création et idempotence avant les effets externes', async t => {
  const {options, calls, state, input} = creationFixture()
  input.campaignId = campaignId
  options.appendParticipation = async () => { throw createHttpError(409, 'Collecte indisponible') }
  await t.throwsAsync(createCollectorExploitation(pointId, input, options))
  t.is(state.created, 0)
  t.is(state.request, null)
  t.false(calls.includes('created-audit'))
  t.is(state.notified, 0)
})

test('création refuse les champs réservés et une invitation pour préleveur existant', t => {
  const input = {requestId, preleveurId: ownerId, exploitation: {usageId, status: 'EN_ACTIVITE'}}
  t.throws(() => validateCollectorExploitationCreation({...input, notifyAccountCreation: true}))
  t.throws(() => validateCollectorExploitationCreation({...input, exploitation: {...input.exploitation, declarantUserId: ownerId}}))
  t.throws(() => validateCollectorExploitationCreation({...input, campaignId: null}))
})
