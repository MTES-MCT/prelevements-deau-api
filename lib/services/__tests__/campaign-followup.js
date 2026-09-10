import test from 'ava'
import {getCampaignResponseSummary, listCampaignResponseOverview, getCampaignResponseResults} from '../campaign-followup.js'

const id = value => `10000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const admin = {id: id(1), role: 'ADMIN'}
const owner = {id: id(2), role: 'DECLARANT'}
const farmer = {id: id(3), role: 'DECLARANT'}
const otherFarmer = {id: id(4), role: 'DECLARANT'}
const thirdFarmer = {id: id(5), role: 'DECLARANT'}
const submittedAt = new Date('2026-09-10T08:00:00Z')

function target(index, preleveurUserId = farmer.id) {
  return {
    id: id(10 + index), pointPrelevementId: id(20 + index), exploitationId: id(30 + index), preleveurUserId,
    preleveur: {userId: preleveurUserId, socialReason: 'Éleveurs du Rhône', user: {firstName: '', lastName: '', deletedAt: null}},
    pointPrelevement: {id: id(20 + index), name: `Forage ${index + 1}`, collectionMode: 'MANUAL', deletedAt: null, zones: [{zoneId: id(100)}]},
    exploitation: {usageId: id(90), usage: {id: id(90), label: 'Irrigation', code: '1', color: '#0088ff'}, status: 'EN_ACTIVITE', collecteurs: [{collecteurUserId: owner.id}]},
    meters: []
  }
}

function response(kind, overrides = {}) {
  return {
    id: id(kind === 'INDEX' ? 40 : 41), preleveurUserId: farmer.id, kind, status: 'SUBMITTED',
    latestSubmissionId: id(kind === 'INDEX' ? 50 : 51),
    latestSubmission: {submittedAt, snapshot: {comment: 'Commentaire transmis'}, publication: null},
    draft: {comment: 'Brouillon privé'},
    ...overrides
  }
}

function fixture({targets = [target(0), target(1)], responses = [], campaign: changes = {}} = {}) {
  const calls = []
  const campaign = {id: id(9), name: 'Campagne annuelle', status: 'OPEN', ownerCollecteurUserId: owner.id, zoneId: id(100), managers: [], periods: [], indexDates: [], targets, ...changes}
  const client = {
    campaign: {async findUnique(query) {
      calls.push({type: 'campaign', query})
      return campaign
    }},
    campaignResponse: {async findMany(query) {
      calls.push({type: 'responses', query})
      const requested = query.where.preleveurUserId
      return responses.filter(row => typeof requested === 'string' ? row.preleveurUserId === requested : requested.in.includes(row.preleveurUserId))
    }},
    instructorZone: {async findMany(query) {
      calls.push({type: 'zone-permissions', query})
      return query.where.permissions.some.permission === 'campaign.read' ? [{zoneId: id(100)}] : []
    }},
    compteurPointPrelevement: {async findMany() {
      return []
    }}
  }
  return {campaign, client, calls}
}

test('la jauge attend deux volets par préleveur, pas par point ni par période', async t => {
  const {campaign, client, calls} = fixture({targets: [target(0), target(1), target(2, otherFarmer.id)]})
  const result = await getCampaignResponseSummary(admin, campaign.id, {client})
  t.deepEqual(result, {
    preleveurCount: 2, expectedCount: 4, receivedCount: 0, correctionCount: 0, scopeComplete: true,
    byKind: {INDEX: {expectedCount: 2, receivedCount: 0, correctionCount: 0}, NEEDS: {expectedCount: 2, receivedCount: 0, correctionCount: 0}}
  })
  t.is(calls.filter(call => call.type === 'responses').length, 1)
})

test('la jauge compte la dernière transmission même pendant une correction libre sans réouverture', async t => {
  const {campaign, client} = fixture({responses: [response('INDEX', {status: 'DRAFT', reopenUntil: null}), response('NEEDS')]})
  const result = await getCampaignResponseSummary(admin, campaign.id, {client})
  t.is(result.receivedCount, 2)
  t.is(result.correctionCount, 1)
  t.deepEqual(result.byKind.INDEX, {expectedCount: 1, receivedCount: 1, correctionCount: 1})
  t.deepEqual(result.byKind.NEEDS, {expectedCount: 1, receivedCount: 1, correctionCount: 0})
})

test('un brouillon réouvert sans transmission ne devient ni une réponse reçue ni une correction', async t => {
  const {campaign, client} = fixture({responses: [response('INDEX', {status: 'DRAFT', latestSubmissionId: null, latestSubmission: null, reopenUntil: new Date('2030-01-01')})]})
  const result = await getCampaignResponseSummary(admin, campaign.id, {client})
  t.is(result.receivedCount, 0)
  t.is(result.correctionCount, 0)
})

for (const operation of [getCampaignResponseSummary, listCampaignResponseOverview]) {
  test(`${operation.name} sélectionne seulement les métadonnées, sans JSON de réponse`, async t => {
    const {campaign, client, calls} = fixture({responses: [response('INDEX')]})
    const result = await operation(admin, campaign.id, {client})
    const {query} = calls.find(call => call.type === 'responses')
    t.deepEqual(query.select, {
      preleveurUserId: true, kind: true, status: true, latestSubmissionId: true,
      latestSubmission: {select: {submittedAt: true}}
    })
    t.deepEqual(query.where, {campaignId: campaign.id, preleveurUserId: {in: [farmer.id]}})
    t.false(JSON.stringify(result).includes('Brouillon privé'))
    t.false(JSON.stringify(result).includes('Commentaire transmis'))
  })
}

test('la jauge vide reste à zéro sans requête de réponses ni division par zéro', async t => {
  const {campaign, client, calls} = fixture({targets: []})
  const result = await getCampaignResponseSummary(admin, campaign.id, {client})
  t.is(result.expectedCount, 0)
  t.is(result.receivedCount, 0)
  t.is(result.preleveurCount, 0)
  t.false(calls.some(call => call.type === 'responses'))
})

test('5 000 points restent une seule lecture légère de réponses et une page de 20 préleveurs', async t => {
  const targets = Array.from({length: 5000}, (_, index) => target(index, id(10_000 + index)))
  const {campaign, client, calls} = fixture({targets})
  const result = await listCampaignResponseOverview(admin, campaign.id, {client})
  t.is(result.items.length, 20)
  t.is(result.pagination.totalCount, 5000)
  t.true(result.pagination.hasMore)
  const metadataCalls = calls.filter(call => call.type === 'responses')
  t.is(metadataCalls.length, 1)
  t.is(metadataCalls[0].query.where.preleveurUserId.in.length, 5000)
  t.deepEqual(metadataCalls[0].query.select.latestSubmission, {select: {submittedAt: true}})
})

test('un administrateur peut consulter le suivi d’une campagne encore en brouillon', async t => {
  const {campaign, client} = fixture({campaign: {status: 'DRAFT'}})
  const result = await getCampaignResponseSummary(admin, campaign.id, {client})
  t.is(result.expectedCount, 2)
  t.is(result.receivedCount, 0)
})

test('le suivi décrit fidèlement chaque volet sans inventer un brouillon pour une absence', async t => {
  const {campaign, client} = fixture({responses: [response('INDEX', {status: 'DRAFT'})]})
  const result = await listCampaignResponseOverview(admin, campaign.id, {client})
  t.deepEqual(result.items, [{
    preleveur: {userId: farmer.id, label: 'Éleveurs du Rhône'}, pointCount: 2,
    responses: {
      INDEX: {status: 'DRAFT', received: true, correctionPending: true, latestSubmissionAt: submittedAt.toISOString()},
      NEEDS: {status: null, received: false, correctionPending: false, latestSubmissionAt: null}
    }
  }])
  t.deepEqual(result.pagination, {totalCount: 1, limit: 20, hasMore: false, nextCursor: null})
})

for (const [status, expectedIds] of [
  ['all', [farmer.id, otherFarmer.id, thirdFarmer.id]],
  ['missing', [farmer.id]],
  ['received', [otherFarmer.id, thirdFarmer.id]],
  ['correction', [thirdFarmer.id]]
]) {
  test(`le filtre ${status} est calculé sur les deux volets avant la pagination`, async t => {
    const {campaign, client} = fixture({
      targets: [target(0), target(1, otherFarmer.id), target(2, thirdFarmer.id)],
      responses: [
        response('INDEX'),
        response('INDEX', {preleveurUserId: otherFarmer.id}),
        response('NEEDS', {preleveurUserId: otherFarmer.id}),
        response('INDEX', {preleveurUserId: thirdFarmer.id, status: 'DRAFT'}),
        response('NEEDS', {preleveurUserId: thirdFarmer.id})
      ]
    })
    const result = await listCampaignResponseOverview(admin, campaign.id, {client, status, limit: 1})
    t.deepEqual(result.items.map(item => item.preleveur.userId), expectedIds.slice(0, 1))
    t.is(result.pagination.totalCount, expectedIds.length)
    t.is(result.pagination.hasMore, expectedIds.length > 1)
  })
}

test('pagination stable par nom puis UUID, sans doublons ni omission entre les pages', async t => {
  const first = target(0)
  first.preleveur.socialReason = 'Zébulle'
  const second = target(1, otherFarmer.id)
  second.preleveur.socialReason = 'Alpha'
  const {campaign, client} = fixture({targets: [first, second, target(2, thirdFarmer.id)]})
  const page1 = await listCampaignResponseOverview(admin, campaign.id, {client, limit: 2})
  t.deepEqual(page1.items.map(item => item.preleveur.userId), [otherFarmer.id, thirdFarmer.id])
  t.is(page1.pagination.nextCursor, thirdFarmer.id)
  const page2 = await listCampaignResponseOverview(admin, campaign.id, {client, limit: 2, cursor: page1.pagination.nextCursor})
  t.deepEqual(page2.items.map(item => item.preleveur.userId), [farmer.id])
  t.is(page2.pagination.totalCount, 3)
  t.false(page2.pagination.hasMore)
  t.is(page2.pagination.nextCursor, null)
})

for (const q of ['eleveurs du rhone', 'ÉLEVEURS', 'forage 2', '  Forage 2  ']) {
  test(`la recherche « ${q} » porte sur le préleveur et ses points, sans casse ni accents`, async t => {
    const unrelated = target(2, otherFarmer.id)
    unrelated.preleveur.socialReason = 'Autre exploitation'
    const {campaign, client} = fixture({targets: [target(0), target(1), unrelated]})
    const result = await listCampaignResponseOverview(admin, campaign.id, {client, q, limit: 1})
    t.deepEqual(result.items.map(item => item.preleveur.userId), [farmer.id])
    t.is(result.items[0].pointCount, 2)
    t.is(result.pagination.totalCount, 1)
  })
}

test('une recherche sans résultat retourne une page vide, pas des résultats non filtrés', async t => {
  const {campaign, client} = fixture()
  const result = await listCampaignResponseOverview(admin, campaign.id, {client, q: 'absent'})
  t.deepEqual(result.items, [])
  t.deepEqual(result.pagination, {totalCount: 0, limit: 20, hasMore: false, nextCursor: null})
})

test('le nom usuel affiché du point est également recherchable', async t => {
  const point = target(0)
  point.pointPrelevement.usageName = 'Pompage des Érables'
  const {campaign, client} = fixture({targets: [point]})
  const result = await listCampaignResponseOverview(admin, campaign.id, {client, q: 'pompage des erables'})
  t.deepEqual(result.items.map(item => item.preleveur.userId), [farmer.id])
  t.is(result.pagination.totalCount, 1)
})

test('un curseur étranger, hors filtre ou révoqué est refusé sans révéler sa cible', async t => {
  const {campaign, client} = fixture()
  await Promise.all([{cursor: otherFarmer.id}, {cursor: farmer.id, q: 'absent'}].map(async input => {
    const error = await t.throwsAsync(listCampaignResponseOverview(admin, campaign.id, {client, ...input}))
    t.is(error.statusCode, 400)
    t.false(error.message.includes(input.cursor))
  }))
})

test('la jauge, la recherche et les compteurs n’exposent jamais un point hors périmètre', async t => {
  const visible = target(0)
  const hidden = target(1, otherFarmer.id)
  hidden.exploitation.collecteurs = []
  hidden.preleveur.socialReason = 'Préleveur confidentiel'
  hidden.pointPrelevement.name = 'Point confidentiel'
  const {campaign, client, calls} = fixture({targets: [visible, hidden], responses: [response('INDEX', {preleveurUserId: otherFarmer.id})]})
  const summary = await getCampaignResponseSummary(owner, campaign.id, {client})
  t.false(summary.scopeComplete)
  t.is(summary.expectedCount, 2)
  t.is(summary.receivedCount, 0)
  const overview = await listCampaignResponseOverview(owner, campaign.id, {client})
  t.is(overview.items[0].pointCount, 1)
  t.is(overview.pagination.totalCount, 1)
  t.false(JSON.stringify(overview).includes('confidentiel'))
  const search = await listCampaignResponseOverview(owner, campaign.id, {client, q: 'confidentiel'})
  t.deepEqual(search.items, [])
  for (const {query} of calls.filter(call => call.type === 'responses')) {
    t.deepEqual(query.where.preleveurUserId, {in: [farmer.id]})
  }
})

test('un agent avec le seul droit de lecture obtient seulement les résultats de ses zones', async t => {
  const hidden = target(1, otherFarmer.id)
  hidden.pointPrelevement.zones = [{zoneId: id(101)}]
  const {campaign, client} = fixture({targets: [target(0), hidden], responses: [response('INDEX'), response('NEEDS', {preleveurUserId: otherFarmer.id})]})
  const instructor = {id: id(6), role: 'INSTRUCTOR'}
  const result = await getCampaignResponseSummary(instructor, campaign.id, {client})
  t.false(result.scopeComplete)
  t.is(result.preleveurCount, 1)
  t.is(result.receivedCount, 1)
  const overview = await listCampaignResponseOverview(instructor, campaign.id, {client})
  t.deepEqual(overview.items.map(item => item.preleveur.userId), [farmer.id])
})

for (const operation of [getCampaignResponseSummary, listCampaignResponseOverview, getCampaignResponseResults]) {
  test(`${operation.name} exige l’authentification et le droit de suivi à chaque lecture`, async t => {
    const {campaign, client, calls} = fixture()
    const options = {client, ...(operation === getCampaignResponseResults ? {preleveurUserId: farmer.id} : {})}
    const unauthenticated = await t.throwsAsync(operation(null, campaign.id, options))
    t.is(unauthenticated.statusCode, 401)
    const forbidden = await t.throwsAsync(operation(farmer, campaign.id, options))
    t.is(forbidden.statusCode, 403)
    t.false(calls.some(call => call.type === 'responses'))
    campaign.managers.push({userId: farmer.id, role: 'READER'})
    await t.notThrowsAsync(operation(farmer, campaign.id, options))
    campaign.managers = []
    const revoked = await t.throwsAsync(operation(farmer, campaign.id, options))
    t.is(revoked.statusCode, 403)
  })
}

test('le détail des résultats refuse un préleveur non autorisé avant de lire ses réponses', async t => {
  const {campaign, client, calls} = fixture()
  const error = await t.throwsAsync(getCampaignResponseResults(owner, campaign.id, {client, preleveurUserId: otherFarmer.id}))
  t.is(error.statusCode, 403)
  t.false(calls.some(call => call.type === 'responses'))
})

test('le détail garde la dernière réponse officielle en correction et ne sélectionne jamais le brouillon', async t => {
  const {campaign, client, calls} = fixture({responses: [response('INDEX', {status: 'DRAFT'})]})
  const result = await getCampaignResponseResults(admin, campaign.id, {client, preleveurUserId: farmer.id})
  t.is(result.targets.length, 2)
  t.is(result.responses.INDEX.status, 'DRAFT')
  t.is(result.responses.INDEX.latestSubmission.snapshot.comment, 'Commentaire transmis')
  t.is(result.responses.INDEX.latestSubmission.submittedAt, submittedAt.toISOString())
  t.is(result.responses.NEEDS, null)
  t.false(JSON.stringify(result).includes('Brouillon privé'))
  const {query} = calls.find(call => call.type === 'responses')
  t.deepEqual(query.where, {campaignId: campaign.id, preleveurUserId: farmer.id})
  t.deepEqual(query.select, {
    id: true, kind: true, status: true,
    latestSubmission: {select: {submittedAt: true, snapshot: true, publication: true}}
  })
})

test('un résultat jamais transmis reste vide même si son brouillon contient des valeurs', async t => {
  const {campaign, client} = fixture({responses: [response('INDEX', {status: 'DRAFT', latestSubmissionId: null, latestSubmission: null, draft: {readings: [{targetId: id(10), value: '120'}]}})]})
  const result = await getCampaignResponseResults(admin, campaign.id, {client, preleveurUserId: farmer.id})
  t.is(result.responses.INDEX.status, 'DRAFT')
  t.is(result.responses.INDEX.latestSubmission, null)
  t.is(result.responses.NEEDS, null)
  t.false(JSON.stringify(result).includes('120'))
})

test('les résultats filtrent toutes les valeurs et les commentaires hors périmètre du même préleveur', async t => {
  const visible = target(0)
  const hidden = target(1)
  hidden.exploitation.collecteurs = []
  const snapshot = {
    comment: 'Commentaire global privé', readings: [{targetId: visible.id, value: '0'}, {targetId: hidden.id, value: '999'}],
    needs: [{targetId: hidden.id}], meterEvents: [{targetId: hidden.id}]
  }
  const publication = {
    sourceId: 'global', coverageIds: ['global'], issues: ['global'],
    totals: [{targetId: visible.id, status: 'MISSING', value: null}, {targetId: hidden.id, value: '999'}],
    readingReferences: [{targetId: hidden.id}], eventReadingReferences: [{targetId: hidden.id}], meterEventReferences: [{targetId: hidden.id}]
  }
  const {campaign, client} = fixture({targets: [visible, hidden], responses: [response('INDEX', {latestSubmission: {submittedAt, snapshot, publication}})]})
  const result = await getCampaignResponseResults(owner, campaign.id, {client, preleveurUserId: farmer.id})
  t.deepEqual(result.targets.map(item => item.id), [visible.id])
  t.deepEqual(result.responses.INDEX.latestSubmission.snapshot, {readings: [{targetId: visible.id, value: '0'}], needs: [], meterEvents: []})
  t.deepEqual(result.responses.INDEX.latestSubmission.publication, {
    totals: [{targetId: visible.id, status: 'MISSING', value: null}], readingReferences: [], eventReadingReferences: [], meterEventReferences: []
  })
  t.false(JSON.stringify(result).includes(hidden.id))
  t.false(JSON.stringify(result).includes('global'))
  t.is(snapshot.comment, 'Commentaire global privé')
  t.is(snapshot.readings.length, 2)
})

for (const input of [{limit: 0}, {limit: 101}, {limit: 1.5}, {cursor: 'bad-id'}, {status: 'SUBMITTED'}, {q: 'a'.repeat(101)}, {q: ['a', 'b']}, {includeDrafts: true}]) {
  test(`le suivi refuse les paramètres invalides sans lecture : ${JSON.stringify(input)}`, async t => {
    const {campaign, client, calls} = fixture()
    const error = await t.throwsAsync(listCampaignResponseOverview(admin, campaign.id, {client, ...input}))
    t.is(error.statusCode, 400)
    t.deepEqual(calls, [])
  })
}

for (const input of [{}, {preleveurUserId: 'bad-id'}, {preleveurUserId: farmer.id, includeDraft: true}]) {
  test(`le détail refuse les paramètres invalides sans lecture : ${JSON.stringify(input)}`, async t => {
    const {campaign, client, calls} = fixture()
    const error = await t.throwsAsync(getCampaignResponseResults(admin, campaign.id, {client, ...input}))
    t.is(error.statusCode, 400)
    t.deepEqual(calls, [])
  })
}
