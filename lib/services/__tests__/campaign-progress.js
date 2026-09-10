import test from 'ava'
import {campaignProgressSummary, loadCampaignListProgress} from '../campaign-progress.js'
import {listCampaigns} from '../campaigns.js'

const id = suffix => `10000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
const admin = {id: id(1), role: 'ADMIN'}
const farmer = {id: id(2), role: 'DECLARANT'}
const otherFarmer = {id: id(3), role: 'DECLARANT'}
const owner = {id: id(4), role: 'DECLARANT'}
const access = (campaignId, preleveurUserIds, overrides = {}) => ({
  campaign: {id: campaignId, status: 'OPEN'}, targets: preleveurUserIds.map(preleveurUserId => ({preleveurUserId})),
  permissions: {canFollowup: true}, scopeComplete: true, ...overrides
})

function aggregationClient(rows = []) {
  const calls = []
  return {calls, async $queryRaw(strings, scopesJson) {
    const scopes = JSON.parse(scopesJson)
    calls.push({sql: strings.join('?'), scopes})
    const groups = new Map()
    for (const row of rows) {
      if (!row.latestSubmissionId || !['INDEX', 'NEEDS'].includes(row.kind)
        || !scopes.some(scope => scope.campaignId === row.campaignId && scope.preleveurUserIds.includes(row.preleveurUserId))) {
        continue
      }

      const key = `${row.campaignId}:${row.kind}`
      const count = groups.get(key) ?? {campaignId: row.campaignId, kind: row.kind, receivedCount: 0, correctionCount: 0}
      count.receivedCount++
      count.correctionCount += Number(row.status === 'DRAFT')
      groups.set(key, count)
    }

    return [...groups.values()]
  }}
}

test('la construction du résumé reste identique au détail : deux volets par préleveur distinct', t => {
  const summary = campaignProgressSummary(access(id(10), [farmer.id, farmer.id, otherFarmer.id]), [
    {kind: 'INDEX', receivedCount: 2, correctionCount: 1}, {kind: 'NEEDS', receivedCount: 1, correctionCount: 0}
  ])
  t.deepEqual(summary, {preleveurCount: 2, expectedCount: 4, receivedCount: 3, correctionCount: 1, scopeComplete: true,
    byKind: {INDEX: {expectedCount: 2, receivedCount: 2, correctionCount: 1}, NEEDS: {expectedCount: 2, receivedCount: 1, correctionCount: 0}}})
})

test('la liste agrège toutes les campagnes en une seule lecture et compte les corrections dans les réponses reçues', async t => {
  const first = id(10)
  const second = id(11)
  const client = aggregationClient([
    {campaignId: first, preleveurUserId: farmer.id, kind: 'INDEX', status: 'DRAFT', latestSubmissionId: id(20)},
    {campaignId: first, preleveurUserId: farmer.id, kind: 'NEEDS', status: 'SUBMITTED', latestSubmissionId: id(21)},
    {campaignId: second, preleveurUserId: otherFarmer.id, kind: 'INDEX', status: 'DRAFT', latestSubmissionId: null},
    {campaignId: second, preleveurUserId: otherFarmer.id, kind: 'NEEDS', status: 'SUBMITTED', latestSubmissionId: null}
  ])
  const result = await loadCampaignListProgress([access(first, [farmer.id, farmer.id]), access(second, [otherFarmer.id])], {client})
  t.is(client.calls.length, 1)
  t.deepEqual(result.get(first).byKind, {
    INDEX: {expectedCount: 1, receivedCount: 1, correctionCount: 1}, NEEDS: {expectedCount: 1, receivedCount: 1, correctionCount: 0}
  })
  t.is(result.get(second).receivedCount, 0)
  t.is(result.get(second).correctionCount, 0)
  t.deepEqual(client.calls[0].scopes, [{campaignId: first, preleveurUserIds: [farmer.id]}, {campaignId: second, preleveurUserIds: [otherFarmer.id]}])
  const {sql} = client.calls[0]
  t.regex(sql, /scope\."campaignId" = response\."campaignId"/)
  t.regex(sql, /scope\."preleveurUserId" = response\."preleveurUserId"/)
  t.regex(sql, /"latestSubmissionId" IS NOT NULL/)
  t.notRegex(sql.replaceAll('\'DRAFT\'', ''), /\bdraft\b|\bsnapshot\b|\bpublication\b|\bcreatedby\b/i)
})

test('les couples campagne/préleveur restent exacts et les réponses hors périmètre ne sont jamais comptées', async t => {
  const first = id(10)
  const second = id(11)
  const client = aggregationClient([
    {campaignId: first, preleveurUserId: farmer.id, kind: 'INDEX', status: 'SUBMITTED', latestSubmissionId: id(20)},
    {campaignId: first, preleveurUserId: otherFarmer.id, kind: 'NEEDS', status: 'SUBMITTED', latestSubmissionId: id(21)},
    {campaignId: second, preleveurUserId: farmer.id, kind: 'INDEX', status: 'SUBMITTED', latestSubmissionId: id(22)},
    {campaignId: id(99), preleveurUserId: farmer.id, kind: 'INDEX', status: 'SUBMITTED', latestSubmissionId: id(23)}
  ])
  const result = await loadCampaignListProgress([access(first, [farmer.id], {scopeComplete: false}), access(second, [otherFarmer.id])], {client})
  t.is(result.get(first).receivedCount, 1)
  t.is(result.get(first).expectedCount, 2)
  t.false(result.get(first).scopeComplete)
  t.is(result.get(second).receivedCount, 0)
  t.is(result.size, 2)
})

test('aucune lecture de réponses pour les brouillons, les simples déclarants et les listes vides', async t => {
  const client = aggregationClient()
  const result = await loadCampaignListProgress([
    access(id(10), [farmer.id], {permissions: {canFollowup: false}}),
    access(id(11), [farmer.id], {campaign: {id: id(11), status: 'DRAFT'}})
  ], {client})
  t.is(result.size, 0)
  t.deepEqual(client.calls, [])
  const empty = await loadCampaignListProgress([], {client})
  t.is(empty.size, 0)
})

test('un périmètre vide renvoie des zéros sans requête et une campagne clôturée garde son avancement', async t => {
  const client = aggregationClient()
  const result = await loadCampaignListProgress([access(id(10), [], {scopeComplete: false, campaign: {id: id(10), status: 'CLOSED'}})], {client})
  t.is(result.get(id(10)).expectedCount, 0)
  t.is(result.get(id(10)).receivedCount, 0)
  t.false(result.get(id(10)).scopeComplete)
  t.deepEqual(client.calls, [])
})

test('deux cents campagnes n’ajoutent toujours qu’une seule requête de progression', async t => {
  const client = aggregationClient()
  const result = await loadCampaignListProgress(Array.from({length: 200}, (_, index) => access(id(index + 100), [farmer.id])), {client})
  t.is(result.size, 200)
  t.is(client.calls.length, 1)
  t.is(client.calls[0].scopes.length, 200)
})

function listClient(user, {partial = false, status = 'OPEN'} = {}) {
  const targets = [farmer, otherFarmer].map((person, index) => ({
    id: id(30 + index), pointPrelevementId: id(40 + index), preleveurUserId: person.id,
    pointPrelevement: {id: id(40 + index), name: `Point ${index}`, zones: [{zoneId: id(partial && index === 1 ? 60 : 50)}]},
    preleveur: {userId: person.id, user: {}, socialReason: `Préleveur ${index}`}, meters: [],
    exploitation: {usageId: id(70), collecteurs: index === 0 ? [{collecteurUserId: owner.id}] : []}
  }))
  const campaigns = [id(10), id(11)].map(campaignId => ({
    id: campaignId, status, ownerCollecteurUserId: owner.id, zoneId: id(50), managers: [], targets, periods: [], indexDates: []
  }))
  const client = aggregationClient(campaigns.flatMap(campaign => [farmer, otherFarmer].map(person => ({
    campaignId: campaign.id, preleveurUserId: person.id, kind: 'INDEX', latestSubmissionId: id(80), status: 'SUBMITTED'
  }))))
  const detailReads = []
  Object.assign(client, {
    campaign: {
      async findMany() {
        return campaigns.map(campaign => ({...campaign, _count: {targets: campaign.targets.length}, targets: campaign.targets.filter(target => user.role === 'ADMIN'
          || target.preleveurUserId === user.id || target.exploitation.collecteurs.some(link => link.collecteurUserId === user.id)
          || (user.role === 'INSTRUCTOR' && target.pointPrelevement.zones.some(zone => zone.zoneId === id(50))))}))
      },
      async findUnique({where}) {
        detailReads.push(where.id)
        return campaigns.find(campaign => campaign.id === where.id)
      }
    },
    declarant: {
      async findUnique() {
        return {declarantRole: user.id === owner.id ? 'COLLECTEUR' : 'PRELEVEUR'}
      },
      async findMany() {
        return []
      }
    },
    zone: {async findMany() {
      return [{id: id(50)}]
    }},
    instructorZone: {async findMany() {
      return [{zoneId: id(50), permissions: [{permission: 'campaign.read'}]}]
    }},
    compteurPointPrelevement: {async findMany() {
      return []
    }}
  })
  return {client, detailReads}
}

test('listCampaigns fournit les compteurs et la progression sans charger un détail par campagne', async t => {
  const {client, detailReads} = listClient(admin)
  const result = await listCampaigns(admin, {client})
  t.true(result.permissions.canCreate)
  t.is(result.items.length, 2)
  t.deepEqual(detailReads, [])
  t.is(client.calls.length, 1)
  t.true(result.items.every(item => item.campaign && item.permissions && item.counts))
  t.true(result.items.every(item => !Object.hasOwn(item, 'targets') && !Object.hasOwn(item.campaign, 'targets') && !Object.hasOwn(item, 'managerOptions')))
  t.true(result.items.every(item => item.progress.receivedCount === 2 && item.progress.expectedCount === 4 && item.progress.scopeComplete))
})

test('un agent ne reçoit que l’avancement des préleveurs de ses points autorisés', async t => {
  const user = {id: id(90), role: 'INSTRUCTOR'}
  const {client} = listClient(user, {partial: true})
  const result = await listCampaigns(user, {client})
  t.true(result.items.every(item => item.progress.preleveurCount === 1 && item.progress.receivedCount === 1 && !item.progress.scopeComplete))
  t.true(client.calls[0].scopes.every(scope => scope.preleveurUserIds.length === 1 && scope.preleveurUserIds[0] === farmer.id))
})

test('le collecteur propriétaire garde le même sous-périmètre que le détail', async t => {
  const {client} = listClient(owner)
  const result = await listCampaigns(owner, {client})
  t.true(result.permissions.canCreate)
  t.true(result.items.every(item => item.progress.preleveurCount === 1 && item.progress.receivedCount === 1 && !item.progress.scopeComplete))
})

test('la liste d’un simple préleveur ne révèle aucun avancement transverse', async t => {
  const {client} = listClient(farmer)
  const result = await listCampaigns(farmer, {client})
  t.true(result.items.every(item => item.progress === null))
  t.deepEqual(client.calls, [])
})

test('un brouillon de campagne renvoie progress null sans agrégation des réponses', async t => {
  const {client} = listClient(admin, {status: 'DRAFT'})
  const result = await listCampaigns(admin, {client})
  t.true(result.items.every(item => item.progress === null))
  t.deepEqual(client.calls, [])
})
