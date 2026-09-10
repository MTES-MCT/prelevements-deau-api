import test from 'ava'
import {listCampaigns} from '../campaigns.js'
import {getCampaignAccess} from '../campaign-permissions.js'

const id = suffix => `10000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
const admin = {id: id(1), role: 'ADMIN'}
const agent = {id: id(2), role: 'INSTRUCTOR'}
const farmer = {id: id(3), role: 'DECLARANT'}
const collector = {id: id(4), role: 'DECLARANT'}
const other = id(5)
const sage = id(10)
const department = id(11)
const foreignZone = id(12)
const allCodes = ['campaign.read', 'campaign.manage', 'campaign.export']

function matches(record, where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') {
      return expected.some(item => matches(record, item))
    }

    if (key === 'AND') {
      return (Array.isArray(expected) ? expected : [expected]).every(item => matches(record, item))
    }

    const value = record?.[key]
    if (expected === null || typeof expected !== 'object' || expected instanceof Date) {
      return value === expected
    }

    if (Object.hasOwn(expected, 'in')) {
      return expected.in.includes(value)
    }

    if (Object.hasOwn(expected, 'some')) {
      return (value ?? []).some(item => matches(item, expected.some))
    }

    for (const [operator, predicate] of Object.entries({lte: (a, b) => a <= b, gt: (a, b) => a > b, gte: (a, b) => a >= b})) {
      if (Object.hasOwn(expected, operator)) {
        return value !== null && value !== undefined && predicate(value, expected[operator])
      }
    }

    return matches(value, expected)
  })
}

function project(record, select) {
  return Object.fromEntries(Object.entries(select).map(([key, selection]) => {
    const value = record[key]
    if (selection === true) {
      return [key, value]
    }

    if (Array.isArray(value)) {
      return [key, value.filter(item => matches(item, selection.where)).map(item => project(item, selection.select))]
    }

    return [key, value ? project(value, selection.select) : null]
  }))
}

function fixture({campaignId = id(20), status = 'OPEN', zoneId = sage, managers = [], targets} = {}) {
  const campaign = {
    id: campaignId, name: 'Collecte de bassin', year: 2026, version: 1, status, zoneId,
    ownerCollecteurUserId: collector.id, ownerCollecteur: {socialReason: 'Collecteur', user: {email: 'private@example.test'}},
    zone: {id: zoneId, name: 'Zone', code: '01', type: 'SAGE'},
    managers, indexDates: ['2026-01-01', '2026-07-01'],
    periods: [{id: id(30), kind: 'NEEDS', position: 0, label: 'Besoins', startDate: new Date('2027-01-01'), endDate: new Date('2028-01-01')}],
    openingMessage: 'Message non nécessaire à la liste', responses: [{draft: {comment: 'Confidentiel'}}]
  }
  campaign.targets = (targets ?? [
    {id: id(40), preleveurUserId: farmer.id, pointId: id(50), zoneIds: [sage, department], collectors: [collector.id]},
    {id: id(41), preleveurUserId: other, pointId: id(51), zoneIds: [sage, foreignZone], collectors: [collector.id]}
  ]).map(target => ({
    id: target.id, preleveurUserId: target.preleveurUserId, pointPrelevementId: target.pointId,
    exploitation: {usageId: id(60), collecteurs: target.collectors.map(collecteurUserId => ({collecteurUserId}))},
    pointPrelevement: {id: target.pointId, name: 'Point privé', zones: target.zoneIds.map(zoneId => ({zoneId}))},
    preleveur: {userId: target.preleveurUserId, socialReason: 'Préleveur privé', user: {}},
    meters: [{compteurId: id(70), compteur: {serialNumber: 'Compteur privé'}}], campaign
  }))
  campaign._count = {targets: campaign.targets.length}
  return campaign
}

function assignment(zoneId, permissions, extra = {}) {
  return {instructorUserId: agent.id, zoneId, permissions: permissions.map(permission => ({permission})), startDate: new Date('2020-01-01'), endDate: null, ...extra}
}

function database(campaigns, assignments = [], responses = []) {
  const calls = []
  const client = {
    instructorZone: {async findMany(query) {
      calls.push({kind: 'rights', query})
      return assignments.filter(item => matches(item, query.where)).map(item => project(item, query.select))
    }},
    declarant: {async findUnique(query) {
      calls.push({kind: 'actor', query})
      return {declarantRole: query.where.userId === collector.id ? 'COLLECTEUR' : 'PRELEVEUR'}
    }},
    campaign: {
      async findMany(query) {
        calls.push({kind: 'list', query})
        return campaigns.filter(campaign => matches(campaign, query.where)).slice(0, query.take).map(campaign => project(campaign, query.select))
      },
      async findUnique(query) {
        calls.push({kind: 'detail', query})
        return campaigns.find(campaign => campaign.id === query.where.id)
      }
    },
    async $queryRaw(strings, json) {
      const scopes = JSON.parse(json)
      calls.push({kind: 'progress', sql: strings.join('?'), scopes})
      const counts = new Map()
      for (const response of responses) {
        if (!response.latestSubmissionId || !scopes.some(scope => scope.campaignId === response.campaignId && scope.preleveurUserIds.includes(response.preleveurUserId))) {
          continue
        }

        const key = `${response.campaignId}:${response.kind}`
        const count = counts.get(key) ?? {campaignId: response.campaignId, kind: response.kind, receivedCount: 0, correctionCount: 0}
        count.receivedCount++
        count.correctionCount += Number(response.status === 'DRAFT')
        counts.set(key, count)
      }

      return [...counts.values()]
    }
  }
  return {client, calls}
}

test('un brouillon de la zone ne bloque pas la liste d’un lecteur et ne prend pas une place avant la limite', async t => {
  const hidden = Array.from({length: 210}, (_, index) => fixture({campaignId: id(100 + index), status: 'DRAFT'}))
  const allowed = fixture()
  const {client, calls} = database([...hidden, allowed], [assignment(sage, ['campaign.read'])])
  const result = await listCampaigns(agent, {client})
  t.deepEqual(result.items.map(item => item.campaign.id), [allowed.id])
  t.false(result.permissions.canCreate)
  t.is(calls.find(call => call.kind === 'list').query.take, 200)
  t.false(calls.some(call => call.kind === 'detail'))
})

test('un partage READER ne donne pas accès au brouillon et ne bloque pas les campagnes ouvertes partagées', async t => {
  const managers = [{userId: other, role: 'READER'}]
  const {client} = database([fixture({status: 'DRAFT', managers}), fixture({campaignId: id(21), managers})])
  const {items} = await listCampaigns({id: other, role: 'DECLARANT'}, {client})
  t.deepEqual(items.map(item => item.campaign.id), [id(21)])
  t.false(items[0].permissions.canManage)
  t.true(items[0].permissions.canExport)
})

test('la zone d’un point suffit à trouver une campagne SAGE et les autres points ne sont ni comptés ni exposés', async t => {
  const campaign = fixture()
  const {client, calls} = database([campaign], [assignment(department, ['campaign.read'])], [
    {campaignId: campaign.id, preleveurUserId: farmer.id, kind: 'INDEX', latestSubmissionId: id(80), status: 'DRAFT'},
    {campaignId: campaign.id, preleveurUserId: other, kind: 'NEEDS', latestSubmissionId: id(81), status: 'SUBMITTED'}
  ])
  const {items: [item]} = await listCampaigns(agent, {client})
  t.is(item.campaign.id, campaign.id)
  t.deepEqual(item.counts, {pointCount: 1, preleveurCount: 1})
  t.is(item.progress.receivedCount, 1)
  t.false(item.progress.scopeComplete)
  t.deepEqual(calls.find(call => call.kind === 'progress').scopes, [{campaignId: campaign.id, preleveurUserIds: [farmer.id]}])
  t.false(JSON.stringify(item).includes(other))
  const detail = await getCampaignAccess(agent, campaign.id, {client})
  t.deepEqual({...detail.permissions, exportTargetIds: undefined}, {...item.permissions, exportTargetIds: undefined})
  t.is(detail.targets.length, item.counts.pointCount)
})

for (const status of ['DRAFT', 'OPEN', 'CLOSED']) {
  test(`les droits administrateur, propriétaire et MANAGER restent identiques en ${status}`, async t => {
    const campaign = fixture({status, managers: [{userId: other, role: 'MANAGER'}]})
    await Promise.all([admin, collector, {id: other, role: 'DECLARANT'}].map(async user => {
      const {client} = database([campaign])
      const {items: [item]} = await listCampaigns(user, {client})
      t.true(item.permissions.canManage)
      t.true(item.permissions.canManageSharing)
      t.deepEqual(item.counts, {pointCount: 2, preleveurCount: 2})
      t.is(item.progress === null, status === 'DRAFT')
    }))
  })
}

test('un gestionnaire de zone voit son brouillon, même sans aucun point sélectionné', async t => {
  const {client} = database([fixture({status: 'DRAFT', targets: []})], [assignment(sage, ['campaign.read', 'campaign.manage'])])
  const {items: [item], permissions} = await listCampaigns(agent, {client})
  t.true(permissions.canCreate)
  t.true(item.permissions.canManage)
  t.true(item.permissions.canManageSharing)
  t.false(item.permissions.canExport)
  t.deepEqual(item.counts, {pointCount: 0, preleveurCount: 0})
  t.is(item.progress, null)
})

test('les droits expirés, futurs ou d’un autre agent ne rendent aucune campagne visible', async t => {
  const {client} = database([fixture()], [
    assignment(sage, allCodes, {endDate: new Date('2020-01-02')}),
    assignment(sage, allCodes, {startDate: new Date('2200-01-01')}),
    assignment(sage, allCodes, {instructorUserId: other})
  ])
  t.deepEqual(await listCampaigns(agent, {client}), {items: [], permissions: {canCreate: false}})
})

test('un préleveur ne voit que ses points et aucune progression transverse', async t => {
  const {client, calls} = database([fixture(), fixture({campaignId: id(21), status: 'DRAFT'})])
  const {items: [item], permissions} = await listCampaigns(farmer, {client})
  t.false(permissions.canCreate)
  t.deepEqual(item.counts, {pointCount: 1, preleveurCount: 1})
  t.false(item.permissions.canFollowup)
  t.is(item.progress, null)
  t.false(calls.some(call => ['rights', 'progress'].includes(call.kind)))
})

test('la perte d’un mandat limite aussi le propriétaire, sans transformer son rôle en accès global', async t => {
  const campaign = fixture()
  campaign.targets[1].exploitation.collecteurs = []
  const {client} = database([campaign])
  const {items: [item]} = await listCampaigns(collector, {client})
  t.true(item.permissions.canManage)
  t.false(item.permissions.canManageSharing)
  t.deepEqual(item.counts, {pointCount: 1, preleveurCount: 1})
  t.false(item.progress.scopeComplete)
})

test('l’export reste limité au droit des points, pas au droit de leur campagne', async t => {
  const {client} = database([fixture()], [assignment(sage, ['campaign.read']), assignment(department, ['campaign.read', 'campaign.export'])])
  const {items: [item]} = await listCampaigns(agent, {client})
  t.true(item.permissions.canExport)
  t.false(item.permissions.canManage)
  t.deepEqual(item.counts, {pointCount: 2, preleveurCount: 2})
  t.false(Object.hasOwn(item.permissions, 'exportTargetIds'))
})

test('une liste de 200 campagnes garde trois lectures groupées, sans aucune fiche compteur, réponse ou identité de préleveur', async t => {
  const campaigns = Array.from({length: 200}, (_, index) => fixture({campaignId: id(100 + index)}))
  const {client, calls} = database(campaigns, [assignment(sage, allCodes)])
  const result = await listCampaigns(agent, {client})
  t.is(result.items.length, 200)
  t.deepEqual(calls.map(call => call.kind), ['rights', 'list', 'progress'])
  const {select} = calls.find(call => call.kind === 'list').query
  t.notRegex(JSON.stringify(select), /draft|snapshot|publication|meters|compteur|email|contactEmails|openingMessage/)
  t.notRegex(JSON.stringify(select.targets.select), /socialReason|firstName|lastName|preleveur"/)
  for (const item of result.items) {
    t.false(Object.hasOwn(item, 'targets'))
    t.false(Object.hasOwn(item, 'managerOptions'))
    t.false(Object.hasOwn(item.campaign, 'targets'))
    t.false(Object.hasOwn(item.campaign, 'managers'))
    t.false(Object.hasOwn(item.campaign, '_count'))
    t.is(item.campaign.periods[0].startDate, '2027-01-01')
    t.notRegex(JSON.stringify(item), /privé|Confidentiel|private@example.test|Message non nécessaire/)
  }
})

test('aucune lecture sans authentification, et aucune agrégation pour une liste vide', async t => {
  const {client, calls} = database([])
  const error = await t.throwsAsync(() => listCampaigns(null, {client}))
  t.is(error.statusCode, 401)
  t.deepEqual(calls, [])
  t.deepEqual(await listCampaigns(admin, {client}), {items: [], permissions: {canCreate: true}})
  t.deepEqual(calls.map(call => call.kind), ['list'])
})
