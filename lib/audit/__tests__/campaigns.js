import {EventEmitter} from 'node:events'
import test from 'ava'
import {AUDIT_ACTIONS, findAuditAction} from '../catalog.js'
import {AUDIT_MUTATION_PROFILES, buildAuditMutations, captureFinalAuditMutation, captureInitialAuditMutation} from '../mutations.js'
import {loadCampaignAuditSnapshot} from '../campaigns.js'
import {createAuditMiddleware} from '../middleware.js'

const campaignId = '11111111-1111-4111-8111-111111111111'
const responseId = '22222222-2222-4222-8222-222222222222'
const exploitationId = '33333333-3333-4333-8333-333333333333'
const preleveurUserId = '44444444-4444-4444-8444-444444444444'
const compteurId = '55555555-5555-4555-8555-555555555555'
const collecteurUserId = '66666666-6666-4666-8666-666666666666'

test('les neuf mutations de campagne ont une action et un profil métier sans exemption', t => {
  const actions = AUDIT_ACTIONS.filter(action => action.category === 'CAMPAIGN' && action.method !== 'GET')
  t.is(actions.length, 9)
  for (const action of actions) {
    t.truthy(AUDIT_MUTATION_PROFILES[action.type], action.type)
    t.deepEqual(action.safeBodyValueFields, [])
  }
})

test('les noms libres et toutes les réponses sont absents des snapshots de campagne', async t => {
  const population = Array.from({length: 396}, (_, index) => ({exploitationId: `exploitation-${index}`, preleveurUserId}))
  let selection
  const client = {collectionCampaign: {findUnique: async ({select}) => {
    selection = select
    return {id: campaignId, type: 'DROPT_INDEX_NEEDS_2026_2027', status: 'DRAFT', opensOn: null, closesOn: null,
      closedAt: null, collecteurUserId, createdByUserId: preleveurUserId, responses: population}
  }}}
  const before = await loadCampaignAuditSnapshot(client, 'COLLECTION_CAMPAIGN', campaignId, {})
  t.false(Object.hasOwn(selection, 'name'))
  t.deepEqual(selection.responses.select, {exploitationId: true, preleveurUserId: true})
  t.is(before.exploitationCount, 396)
  t.regex(before.populationHash, /^[a-f\d]{64}$/)
  t.false(Object.hasOwn(before, 'responses'))
  population[395] = {...population[395], preleveurUserId: collecteurUserId}
  const after = await loadCampaignAuditSnapshot(client, 'COLLECTION_CAMPAIGN', campaignId, {})
  t.not(before.populationHash, after.populationHash, 'La population complète est couverte au-delà de 100 exploitations.')
})

test('sauvegarde et soumission : révision/statut audités sans lire le contenu en base', async t => {
  const auditAction = findAuditAction('PUT', `/campaigns/${campaignId}/responses/${responseId}`)
  const before = {id: responseId, campaignId, exploitationId, preleveurUserId, revision: 0,
    firstSubmittedAt: null, lastSubmittedAt: null, declarationId: null, publicationStatus: 'NOT_SUBMITTED'}
  let row = before
  const request = {auditAction, params: {}, body: {revision: 0, data: {comment: 'PRIVATE_COMMENT', meters: [{serialNumber: 'PRIVATE_SERIAL'}]}}, auditContext: {metadata: {}}}
  const client = {collectionResponse: {findFirst: async ({where, select}) => {
    t.deepEqual(where, {id: responseId, campaignId})
    for (const field of ['draftData', 'submittedData', 'publicationIssues', 'preleveur']) t.false(Object.hasOwn(select, field))
    return row
  }}}
  await captureInitialAuditMutation(request, auditAction, client)
  row = {...before, revision: 1}
  request.auditContext.responseBody = {success: true, data: {response: {...row, draftData: request.body.data},
    preleveur: {email: 'PRIVATE_EMAIL@example.test'}}}
  await captureFinalAuditMutation(request, auditAction, client)
  const [draft] = buildAuditMutations(request, auditAction)
  t.deepEqual(draft.changedFields, ['revision'])
  t.deepEqual(draft.after, {revision: 1})
  t.deepEqual(draft.redactedFields, ['data'])
  t.is(draft.entityLabel, 'Réponse de campagne')
  t.true(draft.scopes.some(scope => scope.resourceType === 'COLLECTION_CAMPAIGN' && scope.resourceId === campaignId))
  t.true(draft.scopes.some(scope => scope.resourceType === 'EXPLOITATION' && scope.resourceId === exploitationId))
  t.true(draft.scopes.some(scope => scope.resourceType === 'DECLARANT' && scope.resourceId === preleveurUserId))
  t.notRegex(JSON.stringify(draft), /PRIVATE_/)
  request.auditContext.mutationBefore = row
  request.auditContext.mutationAfter = {...row, revision: 2, firstSubmittedAt: new Date('2026-11-01'),
    lastSubmittedAt: new Date('2026-11-01'), publicationStatus: 'PENDING_REVIEW', declarationId: compteurId}
  const [submitted] = buildAuditMutations(request, {type: 'CAMPAIGN.RESPONSE_SUBMITTED'})
  t.is(submitted.after.publicationStatus, 'PENDING_REVIEW')
  t.is(submitted.after.declarationId, compteurId)
  t.is(submitted.after.firstSubmittedAt, '2026-11-01T00:00:00.000Z')
})

test('la validation compteur audite les changements physiques sans index, série ni allocation en clair', async t => {
  let enabled = false
  const queries = []
  const client = {
    compteur: {findUnique: async options => {queries.push(options); return {id: compteurId}}},
    meterStream: {findMany: async options => {queries.push(options); return enabled ? [{id: compteurId, enabled: true, activatedAt: new Date('2026-11-01')}] : []}},
    meterAllocation: {findMany: async options => {queries.push(options); return enabled ? [{id: exploitationId, exploitationId,
      versions: [{id: responseId, version: 1, percentage: '100', startDate: new Date('2025-10-31'), endDate: new Date('2026-06-01'), enabled: true, additive: false, usageId: null}]}] : []}},
    meterPublication: {findMany: async options => {queries.push(options); return enabled ? [{id: campaignId}, {id: responseId}] : []}},
    collectionResponse: {findMany: async options => {queries.push(options); return [{id: responseId, revision: 1,
      publicationStatus: enabled ? 'PUBLISHED' : 'PENDING_REVIEW', lastSubmittedAt: new Date('2026-11-01')}]}}
  }
  const auditAction = findAuditAction('POST', `/campaigns/${campaignId}/meters/${compteurId}/approve`)
  const request = {auditAction, params: {}, body: {allocations: [{exploitationId, seasonPercentage: 'PRIVATE_VALUE'}]}, auditContext: {metadata: {}}}
  await captureInitialAuditMutation(request, auditAction, client)
  enabled = true
  await captureFinalAuditMutation(request, auditAction, client)
  const [mutation] = buildAuditMutations(request, auditAction)
  t.is(mutation.after.activePublicationCount, 2)
  t.is(mutation.after.allocationVersionCount, 1)
  t.true(mutation.after.enabled)
  t.deepEqual(mutation.redactedFields, ['allocations'])
  t.true(mutation.scopes.some(scope => scope.resourceType === 'COMPTEUR' && scope.resourceId === compteurId))
  t.notRegex(JSON.stringify(mutation), /PRIVATE_|percentage|serialNumber|submittedData|indexStart/)
  for (const query of queries) t.false(Object.hasOwn(query.select, 'submittedData'))
})

test('la création trace la cible, les dates et la population sans propager noms libres ou données personnelles', async t => {
  const events = []
  const mutations = []
  const client = {
    auditEvent: {create: async ({data}) => {events.push(data); return {id: responseId}}, update: async ({data}) => {events.push(data)}},
    auditMutation: {create: async ({data}) => {mutations.push(data)}},
    collectionCampaign: {findUnique: async () => ({id: campaignId, type: 'DROPT_INDEX_NEEDS_2026_2027', status: 'DRAFT',
      opensOn: null, closesOn: null, closedAt: null, collecteurUserId, createdByUserId: preleveurUserId,
      responses: [{exploitationId, preleveurUserId}]})}
  }
  const request = {method: 'POST', path: '/api/campaigns', body: {name: 'PRIVATE_NAME', type: 'PRIVATE_TYPE',
    exploitationIds: [exploitationId], unexpectedPrivateKey: 'PRIVATE_EXTRA', data: {comment: 'PRIVATE_COMMENT', email: 'PRIVATE_EMAIL'}},
  params: {}, query: {search: 'PRIVATE_SEARCH'}, get: () => undefined, requestId: 'audit-campaign-test'}
  const response = new EventEmitter()
  response.statusCode = 201
  response.writableFinished = true
  response.json = value => value
  response.send = value => value
  await new Promise((resolve, reject) => createAuditMiddleware({client})(request, response, error => error ? reject(error) : resolve()))
  response.json({success: true, data: {id: campaignId, name: 'PRIVATE_NAME', collecteur: {email: 'PRIVATE_EMAIL'}}})
  response.emit('finish')
  await new Promise(resolve => {setImmediate(resolve)})
  t.is(events.length, 2)
  t.is(events[1].actionType ?? events[0].actionType, 'CAMPAIGN.CREATED')
  t.is(events[1].targetId, campaignId)
  t.is(events[1].targetLabel, null)
  t.is(events[1].outcome, 'SUCCESS')
  t.is(events[1].metadata.exploitationIdsCount, 1)
  t.is(mutations.length, 1)
  t.is(mutations[0].after.exploitationCount, 1)
  t.notRegex(JSON.stringify({events, mutations}), /PRIVATE_|unexpectedPrivateKey|comment|email/)
})

test('fermeture, archivage et suppression produisent leurs snapshots minimaux', t => {
  const before = {id: campaignId, status: 'OPEN', closedAt: null, name: 'PRIVATE_NAME',
    responses: [{submittedData: {comment: 'PRIVATE_COMMENT'}}]}
  for (const [type, after, operation] of [
    ['CAMPAIGN.CLOSED', {...before, closedAt: new Date('2026-11-15')}, 'UPDATE'],
    ['CAMPAIGN.ARCHIVED', {...before, status: 'ARCHIVED'}, 'UPDATE'],
    ['CAMPAIGN.DELETED', null, 'DELETE']
  ]) {
    const request = {auditAction: {type, params: {campaignId}}, body: {}, params: {},
      auditContext: {mutationBefore: before, mutationAfter: after}}
    const [mutation] = buildAuditMutations(request, {type})
    t.is(mutation.operation, operation)
    t.notRegex(JSON.stringify(mutation), /PRIVATE_|submittedData/)
  }
})
