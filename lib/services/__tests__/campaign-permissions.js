import test from 'ava'
import {getCampaignAccess, getCampaignResponseScope, filterCampaignSnapshot, isCampaignResponseWindowOpen, isCampaignTargetWritable} from '../campaign-permissions.js'

const user = {id: 'collecteur', role: 'DECLARANT'}
function campaignFixture() {
  return {
    id: 'campaign', ownerCollecteurUserId: 'owner', zoneId: 'zone', status: 'OPEN', periods: [], managers: [],
    targets: ['allowed', 'forbidden'].map((id, index) => ({id, preleveurUserId: 'preleveur', exploitation: {usageId: 'usage', collecteurs: [{collecteurUserId: index ? 'someone-else' : user.id}]}, pointPrelevement: {collectionMode: 'MANUAL', zones: [{zoneId: 'zone'}]}, meters: []}))
  }
}

function client(campaign) {
  return {campaign: {async findUnique() {
    return campaign
  }}, instructorZone: {async findMany() {
    return []
  }}}
}

test('un lien collecteur sur un point n’ouvre pas les autres points du même préleveur', async t => {
  const access = await getCampaignAccess(user, 'campaign', {client: client(campaignFixture())})
  t.deepEqual(access.targets.map(target => target.id), ['allowed'])
  t.false(access.scopeComplete)
  const scope = getCampaignResponseScope(access, user, 'preleveur')
  t.true(scope.permissions.canEdit)
  t.false(scope.permissions.canSubmit)
  t.false(scope.complete)
  t.is(t.throws(() => getCampaignResponseScope(access, user, 'another-preleveur')).statusCode, 403)
})

test('un mode absent autorise la saisie seulement dans le périmètre et la fenêtre de campagne', async t => {
  const campaign = campaignFixture()
  for (const target of campaign.targets) {
    target.pointPrelevement.collectionMode = null
  }

  let access = await getCampaignAccess(user, campaign.id, {client: client(campaign)})
  let scope = getCampaignResponseScope(access, user, 'preleveur')
  t.true(scope.permissions.canEdit)
  t.false(scope.permissions.canSubmit)
  t.deepEqual(scope.editableTargets.map(target => target.id), ['allowed'])
  const farmer = {id: 'preleveur', role: 'DECLARANT'}
  access = await getCampaignAccess(farmer, campaign.id, {client: client(campaign)})
  t.true(getCampaignResponseScope(access, farmer, 'preleveur').permissions.canSubmit)
  campaign.targets[0].pointPrelevement.collectionMode = 'EXTERNAL'
  access = await getCampaignAccess(farmer, campaign.id, {client: client(campaign)})
  scope = getCampaignResponseScope(access, farmer, 'preleveur')
  t.false(scope.permissions.canSubmit)
  t.deepEqual(scope.editableTargets.map(target => target.id), ['forbidden'])
  campaign.status = 'CLOSED'
  access = await getCampaignAccess(farmer, campaign.id, {client: client(campaign)})
  t.false(getCampaignResponseScope(access, farmer, 'preleveur').permissions.canEdit)
})

test('un préleveur a seulement ses points sélectionnés, le gestionnaire n’obtient pas un droit de saisie implicite', async t => {
  const campaign = campaignFixture()
  const own = {id: 'preleveur', role: 'DECLARANT'}
  const access = await getCampaignAccess(own, 'campaign', {client: client(campaign)})
  t.true(getCampaignResponseScope(access, own, 'preleveur').permissions.canSubmit)
  const admin = {id: 'admin', role: 'ADMIN'}
  const managed = await getCampaignAccess(admin, 'campaign', {client: client(campaign)})
  t.true(managed.permissions.canManage)
  t.false(getCampaignResponseScope(managed, admin, 'preleveur').permissions.canEdit)
})

test('la révocation d’un mandat s’applique à chaque lecture, sans ancien droit mis en cache', async t => {
  const campaign = campaignFixture()
  campaign.targets[0].exploitation.collecteurs = []
  const error = await t.throwsAsync(getCampaignAccess(user, 'campaign', {client: client(campaign)}))
  t.is(error.statusCode, 403)
})

test('les grants de lecture ne permettent pas de gérer ni de transmettre', async t => {
  const campaign = campaignFixture()
  campaign.managers.push({userId: user.id, role: 'READER'})
  const access = await getCampaignAccess(user, 'campaign', {client: client(campaign)})
  t.is(access.targets.length, 2)
  t.false(access.permissions.canManage)
  t.false(access.permissions.canManageSharing)
  t.true(access.permissions.canExport)
  t.false(getCampaignResponseScope(access, user, 'preleveur').permissions.canSubmit)
})

test('les réponses partielles n’exposent ni le commentaire global ni les références hors périmètre', t => {
  const result = filterCampaignSnapshot({comment: 'Privé', readings: [{targetId: 'allowed'}, {targetId: 'forbidden'}], readingReferences: [{targetId: 'forbidden'}], issues: ['global'], sourceId: 'global', coverageIds: ['global']}, ['allowed'], {complete: false})
  t.deepEqual(result, {readings: [{targetId: 'allowed'}], readingReferences: []})
})

test('fenêtres et réouverture sont bornées par volet, fermeture et externalisation interdisent la saisie', async t => {
  const campaign = campaignFixture()
  const now = new Date('2026-09-08T12:00:00.000Z')
  campaign.closesAt = new Date('2026-09-08T12:00:00.000Z')
  t.falsy(isCampaignResponseWindowOpen(campaign, null, now))
  t.true(isCampaignResponseWindowOpen(campaign, {reopenUntil: '2026-09-09T12:00:00.000Z'}, now))
  t.falsy(isCampaignResponseWindowOpen(campaign, {reopenUntil: '2026-09-08T12:00:00.000Z'}, now))
  campaign.status = 'CLOSED'
  t.true(isCampaignResponseWindowOpen(campaign, {reopenUntil: '2026-09-09T12:00:00.000Z'}, now))
  campaign.status = 'DRAFT'
  t.falsy(isCampaignResponseWindowOpen(campaign, {reopenUntil: '2026-09-09T12:00:00.000Z'}, now))
  campaign.status = 'OPEN'
  campaign.closesAt = null
  campaign.targets[0].pointPrelevement.collectionMode = 'EXTERNAL'
  const access = await getCampaignAccess(user, 'campaign', {client: client(campaign)})
  t.false(getCampaignResponseScope(access, user, 'preleveur').permissions.canEdit)
})

test('un instructeur ne lit que les points couverts par son droit explicite actif', async t => {
  const campaign = campaignFixture()
  campaign.targets[1].pointPrelevement.zones = [{zoneId: 'other'}]
  const database = client(campaign)
  database.instructorZone.findMany = async ({where}) => where.permissions.some.permission === 'campaign.read' ? [{zoneId: 'zone'}] : []
  const access = await getCampaignAccess({id: 'instructor', role: 'INSTRUCTOR'}, 'campaign', {client: database})
  t.deepEqual(access.targets.map(target => target.id), ['allowed'])
  t.false(access.permissions.canManage)
  t.false(access.permissions.canExport)
})

test('le partage exige à la fois gestion et accès à tous les points de la campagne', async t => {
  const campaign = campaignFixture()
  campaign.ownerCollecteurUserId = user.id
  const incomplete = await getCampaignAccess(user, campaign.id, {client: client(campaign)})
  t.true(incomplete.permissions.canManage)
  t.false(incomplete.permissions.canManageSharing)
  campaign.managers = [{userId: user.id, role: 'MANAGER'}]
  const complete = await getCampaignAccess(user, campaign.id, {client: client(campaign)})
  t.true(complete.permissions.canManageSharing)
})

test('archivage et modification tardive de la période d’exploitation interdisent la nouvelle saisie', t => {
  const campaign = campaignFixture()
  campaign.indexDates = ['2025-10-31', '2026-10-31']
  const target = campaign.targets[0]
  t.true(isCampaignTargetWritable(campaign, target))
  target.pointPrelevement.deletedAt = new Date()
  t.false(isCampaignTargetWritable(campaign, target))
  target.pointPrelevement.deletedAt = null
  target.preleveur = {user: {deletedAt: new Date()}}
  t.false(isCampaignTargetWritable(campaign, target))
  target.preleveur.user.deletedAt = null
  target.exploitation.endDate = '2026-09-01'
  t.false(isCampaignTargetWritable(campaign, target))
})

test('les cibles exportables utilisent le droit export actuel de chaque point, pas seulement sa campagne', async t => {
  const campaign = campaignFixture()
  campaign.targets[1].pointPrelevement.zones = [{zoneId: 'other'}]
  const database = client(campaign)
  database.instructorZone.findMany = async ({where}) => {
    if (where.permissions.some.permission === 'campaign.read') {
      return [{zoneId: 'zone'}, {zoneId: 'other'}]
    }

    return where.permissions.some.permission === 'campaign.export' ? [{zoneId: 'zone'}] : []
  }

  const access = await getCampaignAccess({id: 'instructor', role: 'INSTRUCTOR'}, 'campaign', {client: database})
  t.is(access.targets.length, 2)
  t.true(access.permissions.canExport)
  t.deepEqual(access.permissions.exportTargetIds, ['allowed'])
})
