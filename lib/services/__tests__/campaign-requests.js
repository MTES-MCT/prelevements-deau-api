import {Buffer} from 'node:buffer'
import {readFile} from 'node:fs/promises'
import test from 'ava'
import {listCampaignRequests} from '../campaign-requests.js'

const id = value => `10000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const farmer = {id: id(1), role: 'DECLARANT'}
const collector = {id: id(2), role: 'DECLARANT'}
const aroundNow = days => new Date(Date.now() + (days * 86_400_000))

function campaignFixture() {
  return {
    id: id(3), name: 'Collecte annuelle', year: 2026, status: 'OPEN', createdAt: new Date('2026-01-01'),
    ownerCollecteurUserId: collector.id, ownerCollecteur: {socialReason: 'Organisme', user: {email: 'private-owner@example.test'}},
    opensAt: null, closesAt: null, timezone: 'Europe/Paris', indexDates: ['2026-01-01', '2027-01-01'],
    managers: [{userId: collector.id, role: 'MANAGER'}],
    targets: [0, 1].map(index => ({
      id: id(10 + index), preleveurUserId: farmer.id,
      preleveur: {socialReason: 'Exploitation', user: {deletedAt: null, email: 'private-farmer@example.test'}},
      pointPrelevement: {collectionMode: null, deletedAt: null},
      exploitation: {status: 'EN_ACTIVITE', startDate: null, endDate: null, collecteurs: index ? [] : [{collecteurUserId: collector.id}]}
    }))
  }
}

function fixture({campaign = campaignFixture(), responses = [], actorRole = 'PRELEVEUR', page} = {}) {
  const calls = []
  const defaultRow = {campaignId: campaign.id, preleveurUserId: farmer.id, priority: campaign.status === 'OPEN' ? 0 : 1, year: campaign.year, createdAt: campaign.createdAt}
  const client = {
    declarant: {async findUnique(query) {
      calls.push({method: 'actor', query})
      return {declarantRole: actorRole, user: {deletedAt: null}}
    }},
    async $queryRaw(strings, ...values) {
      calls.push({method: 'page', sql: strings.join('?'), values})
      return page ?? [defaultRow]
    },
    campaign: {async findMany(query) {
      calls.push({method: 'campaigns', query})
      return [campaign]
    }},
    campaignResponse: {async findMany(query) {
      calls.push({method: 'responses', query})
      return responses.map(response => ({campaignId: campaign.id, preleveurUserId: farmer.id, ...response}))
    }},
    campaignTarget: {async groupBy(query) {
      calls.push({method: 'counts', query})
      return [{campaignId: campaign.id, preleveurUserId: farmer.id, _count: {_all: campaign.targets.length}}]
    }}
  }
  return {campaign, client, calls}
}

test('aucune réponse enregistrée reste null, sans brouillon ou transmission inventés', async t => {
  const {client} = fixture()
  const result = await listCampaignRequests(farmer, {client})
  t.is(result.items.length, 1)
  t.is(result.items[0].pointCount, 2)
  t.deepEqual(result.items[0].responses.INDEX, {status: null, latestSubmissionAt: null, reopenUntil: null, canEdit: true, canSubmit: true})
  t.deepEqual(result.items[0].responses.NEEDS, result.items[0].responses.INDEX)
  t.deepEqual(result.items[0].preleveur, {userId: farmer.id, label: 'Exploitation'})
  t.deepEqual(result.items[0].campaign.owner, {userId: collector.id, label: 'Organisme'})
  t.false(JSON.stringify(result).includes('private-'))
})

test('les statuts réels et la dernière transmission survivent à une correction en brouillon', async t => {
  const date = new Date('2026-09-01T10:00:00Z')
  const {client} = fixture({responses: [
    {kind: 'INDEX', status: 'DRAFT', latestSubmission: {submittedAt: date}, draft: {secret: 'index 100'}, publication: {secret: 'volume 42'}},
    {kind: 'NEEDS', status: 'SUBMITTED', latestSubmission: {submittedAt: date}}
  ]})
  const {items: [item]} = await listCampaignRequests(farmer, {client})
  t.is(item.responses.INDEX.status, 'DRAFT')
  t.is(item.responses.INDEX.latestSubmissionAt, date.toISOString())
  t.is(item.responses.NEEDS.status, 'SUBMITTED')
  t.is(item.responses.NEEDS.latestSubmissionAt, date.toISOString())
  t.false(JSON.stringify(item).includes('secret'))
})

test('un collecteur partiellement mandaté voit seulement ses points et ne peut pas transmettre l’ensemble', async t => {
  const {client, calls} = fixture({actorRole: 'COLLECTEUR'})
  const {items: [item]} = await listCampaignRequests(collector, {client})
  t.is(item.pointCount, 1)
  t.true(item.responses.INDEX.canEdit)
  t.false(item.responses.INDEX.canSubmit)
  const {query} = calls.find(call => call.method === 'campaigns')
  t.deepEqual(query.select.targets.where.AND[0].OR[1], {exploitation: {collecteurs: {some: {collecteurUserId: collector.id}}}})
})

test('propriété et partage de suivi seuls ne donnent aucune demande pour un autre préleveur', async t => {
  const data = fixture({actorRole: 'COLLECTEUR'})
  for (const target of data.campaign.targets) {
    target.exploitation.collecteurs = []
  }

  const result = await listCampaignRequests(collector, {client: data.client})
  t.deepEqual(result.items, [])
  const {sql} = data.calls.find(call => call.method === 'page')
  t.false(sql.includes('CampaignManager'))
  t.false(sql.includes('ownerCollecteurUserId'))
  t.true(sql.includes('DeclarantCollecteurExploitation'))
})

test('un préleveur ne récupère pas un mandat collecteur résiduel sur des points étrangers', async t => {
  const {client} = fixture()
  const result = await listCampaignRequests(collector, {client})
  t.deepEqual(result.items, [])
})

test('les points externes ou archivés restent consultables mais non saisissables', async t => {
  const {client, campaign} = fixture()
  campaign.targets[0].pointPrelevement.collectionMode = 'EXTERNAL'
  campaign.targets[1].pointPrelevement.deletedAt = new Date()
  const {items: [item]} = await listCampaignRequests(farmer, {client})
  t.is(item.pointCount, 2)
  t.false(item.responses.INDEX.canEdit)
  t.false(item.responses.NEEDS.canSubmit)
})

test('les dates d’ouverture, de clôture et les réouvertures restent distinctes pour chaque volet', async t => {
  const {client, campaign} = fixture()
  campaign.opensAt = aroundNow(1)
  const unopened = await listCampaignRequests(farmer, {client})
  t.false(unopened.items[0].responses.INDEX.canEdit)
  t.is(unopened.items[0].campaign.opensAt, campaign.opensAt.toISOString())
  campaign.opensAt = aroundNow(-2)
  campaign.closesAt = aroundNow(-1)
  const expired = await listCampaignRequests(farmer, {client})
  t.false(expired.items[0].responses.NEEDS.canEdit)
  campaign.status = 'CLOSED'
  const reopenedUntil = aroundNow(1)
  const reopened = fixture({campaign, responses: [{kind: 'INDEX', status: 'DRAFT', reopenUntil: reopenedUntil}]})
  const {items: [item]} = await listCampaignRequests(farmer, {client: reopened.client})
  t.true(item.responses.INDEX.canSubmit)
  t.is(item.responses.INDEX.reopenUntil, reopenedUntil.toISOString())
  t.false(item.responses.NEEDS.canEdit)
})

test('les campagnes en préparation ne sont jamais exposées même à leur propriétaire', async t => {
  const {client, campaign, calls} = fixture({actorRole: 'COLLECTEUR'})
  campaign.status = 'DRAFT'
  const result = await listCampaignRequests(collector, {client})
  t.deepEqual(result.items, [])
  t.true(calls.find(call => call.method === 'page').sql.includes('campaign.status IN (\'OPEN\', \'CLOSED\')'))
})

test('les administrateurs, agents, anonymes et comptes archivés sont refusés', async t => {
  const {client, calls} = fixture()
  await Promise.all([null, {...farmer, role: 'ADMIN'}, {...farmer, role: 'INSTRUCTOR'}].map(async user => {
    const error = await t.throwsAsync(() => listCampaignRequests(user, {client}))
    t.is(error.statusCode, user ? 403 : 401)
  }))

  t.deepEqual(calls, [])
  client.declarant.findUnique = async () => ({declarantRole: 'PRELEVEUR', user: {deletedAt: new Date()}})
  const archivedError = await t.throwsAsync(() => listCampaignRequests(farmer, {client}))
  t.is(archivedError.statusCode, 403)
})

test('la lecture est groupée, ne charge ni brouillon ni snapshot et ne lance aucun calcul', async t => {
  const {client, calls} = fixture()
  await listCampaignRequests(farmer, {client})
  t.is(calls.length, 5)
  const selected = calls.find(call => call.method === 'responses').query.select
  t.deepEqual(selected.latestSubmission, {select: {submittedAt: true}})
  t.false(Object.hasOwn(selected, 'draft'))
  t.false(Object.hasOwn(selected, 'submissions'))
  const empty = fixture({page: []})
  const emptyResult = await listCampaignRequests(farmer, {client: empty.client})
  t.deepEqual(emptyResult.items, [])
  t.is(empty.calls.length, 2)
})

test('pagination bornée par couple, ouverte avant clôturée, curseur stable sans offset', async t => {
  const campaign = campaignFixture()
  const first = {campaignId: campaign.id, preleveurUserId: farmer.id, priority: 0, year: 2026, createdAt: campaign.createdAt}
  const {client, calls} = fixture({campaign, page: [first, {...first, preleveurUserId: id(99)}]})
  const result = await listCampaignRequests(farmer, {limit: 1, client})
  t.is(result.items.length, 1)
  t.true(result.pagination.hasMore)
  const cursor = JSON.parse(Buffer.from(result.pagination.nextCursor, 'base64url').toString())
  t.is(cursor.campaignId, campaign.id)
  t.is(cursor.preleveurUserId, farmer.id)
  await listCampaignRequests(farmer, {limit: 1, cursor: result.pagination.nextCursor, client})
  const query = calls.findLast(call => call.method === 'page')
  t.true(query.sql.includes('ORDER BY priority ASC, year DESC'))
  t.false(query.sql.includes('OFFSET'))
  t.true(query.values.some(value => value?.sql?.includes('EXTRACT(EPOCH')))
  await Promise.all([{limit: 0}, {limit: 101}, {cursor: 'not-json'}, {cursor: Buffer.from('{"priority":0}').toString('base64url')}].map(async input => {
    const error = await t.throwsAsync(() => listCampaignRequests(farmer, {...input, client}))
    t.is(error.statusCode, 400)
  }))
})

test('la route demandes est authentifiée et déclarée avant la route identifiant', async t => {
  const routes = await readFile(new URL('../../routes.js', import.meta.url), 'utf8')
  const requests = routes.indexOf('app.get(\'/campaigns/requests\', ensureAuthenticated, listCampaignRequestsHandler)')
  t.true(requests > 0)
  t.true(requests < routes.indexOf('app.get(\'/campaigns/:campaignId\','))
})
