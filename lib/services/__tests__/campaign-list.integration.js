import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {listCampaigns, getCampaignDetail} from '../campaigns.js'

const enabled = process.env.CAMPAIGN_INTEGRATION_TESTS === '1'
if (enabled) {
  const url = new URL(process.env.DATABASE_URL)
  if (url.hostname !== '127.0.0.1' || url.port !== '55439' || url.pathname !== '/campaign_tests') {
    throw new Error('Ce test exige la base PostgreSQL jetable campaign_tests sur 127.0.0.1:55439.')
  }
}

const integration = enabled ? test.serial : test.skip
test.after.always(async () => {
  if (enabled) {
    await prisma.$disconnect()
    await globalThis.pgPool.end()
  }
})

async function fixture(client) {
  const suffix = randomUUID()
  const [owner, reader, farmer, otherFarmer, departmentAgent, sageAgent, admin] = await Promise.all([
    ['owner', 'DECLARANT', 'COLLECTEUR'],
    ['reader', 'DECLARANT', 'COLLECTEUR'],
    ['farmer', 'DECLARANT', 'PRELEVEUR'],
    ['other', 'DECLARANT', 'PRELEVEUR'],
    ['department', 'INSTRUCTOR'],
    ['sage', 'INSTRUCTOR'],
    ['admin', 'ADMIN']
  ].map(([label, role, declarantRole]) => client.user.create({data: {
    email: `campaign-list-${label}-${suffix}@example.test`, role,
    ...(role === 'DECLARANT' ? {declarant: {create: {declarantRole, socialReason: `Liste ${label}`, ...(declarantRole === 'PRELEVEUR' ? {preleveurType: 'IRRIGANT'} : {})}}} : {}),
    ...(role === 'INSTRUCTOR' ? {instructor: {create: {}}} : {})
  }})))
  const sageId = randomUUID()
  const departmentId = randomUUID()
  await client.$executeRaw`
    INSERT INTO "Zone" (id, code, type, name, coordinates, "updatedAt") VALUES
    (${sageId}::uuid, ${`sage-${suffix}`}, 'SAGE', 'SAGE de test liste', ST_GeomFromText('MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)))',4326), NOW()),
    (${departmentId}::uuid, ${`department-${suffix}`}, 'DEPARTEMENT', 'Département de test liste', ST_GeomFromText('MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)))',4326), NOW())
  `
  await Promise.all([[departmentAgent, departmentId], [sageAgent, sageId]].map(([agent, zoneId]) => client.instructorZone.create({data: {
    instructorUserId: agent.id, zoneId, startDate: new Date('2020-01-01'),
    permissions: {create: {permission: 'campaign.read'}}
  }})))
  const usage = await client.sandreWaterUse.create({data: {code: suffix.slice(0, 16), kind: 'USAGE', label: 'Usage de test liste'}})
  const points = await Promise.all([0, 1].map(index => client.pointPrelevement.create({data: {
    name: `Liste ${suffix} ${index}`, flowType: 'PRELEVEMENT', waterBodyType: 'SUPERFICIELLE',
    zones: {create: [{zoneId: sageId}, ...(index === 0 ? [{zoneId: departmentId}] : [])]}
  }})))
  const exploitations = await Promise.all([farmer, otherFarmer].map((preleveur, index) => client.declarantPointPrelevement.create({data: {
    declarantUserId: preleveur.id, usageId: usage.id, status: 'EN_ACTIVITE', startDate: new Date('2020-01-01'),
    pointPrelevementId: points[index].id,
    collecteurs: {create: {collecteurUserId: owner.id}}
  }})))
  const [open, draft] = await Promise.all(['OPEN', 'DRAFT'].map(status => client.campaign.create({data: {
    name: `Liste ${status} ${suffix}`, year: 2026, status, ownerCollecteurUserId: owner.id, createdByUserId: owner.id, zoneId: sageId,
    indexDates: ['2026-01-01', '2026-07-01'], managers: {create: {userId: reader.id, role: 'READER'}},
    periods: {create: [
      {kind: 'INDEX', position: 0, label: 'Relevés', startDate: new Date('2026-01-01'), endDate: new Date('2026-07-01'),
        startReadingDate: new Date('2026-01-01'), endReadingDate: new Date('2026-07-01')},
      {kind: 'NEEDS', position: 0, label: 'Besoins', startDate: new Date('2027-01-01'), endDate: new Date('2028-01-01')}
    ]},
    targets: {create: exploitations.map(exploitation => ({exploitationId: exploitation.id, pointPrelevementId: exploitation.pointPrelevementId,
      preleveurUserId: exploitation.declarantUserId, eligibilityConfirmed: true}))}
  }})))
  await Promise.all([[farmer, 'INDEX', 'DRAFT'], [otherFarmer, 'NEEDS', 'SUBMITTED']].map(async ([user, kind, status]) => {
    const response = await client.campaignResponse.create({data: {campaignId: open.id, preleveurUserId: user.id, kind, status, draft: {comment: 'Non transmis'}}})
    const submission = await client.campaignSubmission.create({data: {responseId: response.id, version: 1, idempotencyKey: randomUUID(), createdByUserId: user.id, snapshot: {comment: 'Officiel'}}})
    await client.campaignResponse.update({where: {id: response.id}, data: {latestSubmissionId: submission.id}})
  }))
  return {owner, reader, farmer, departmentAgent, sageAgent, admin, open, draft}
}

integration('la vraie requête de liste filtre les brouillons, résout les zones des points et conserve les jauges du seul périmètre autorisé', async t => {
  const rollback = new Error('Annulation des seules fixtures de liste.')
  await t.throwsAsync(prisma.$transaction(async client => {
    const data = await fixture(client)
    const onlyFixtureItems = result => result.items.filter(item => [data.open.id, data.draft.id].includes(item.campaign.id))
    const departmentItems = onlyFixtureItems(await listCampaigns(data.departmentAgent, {client}))
    t.deepEqual(departmentItems.map(item => item.campaign.id), [data.open.id])
    t.deepEqual(departmentItems[0].counts, {pointCount: 1, preleveurCount: 1})
    t.is(departmentItems[0].progress.receivedCount, 1)
    t.is(departmentItems[0].progress.correctionCount, 1)
    t.false(departmentItems[0].progress.scopeComplete)
    const detail = await getCampaignDetail(data.departmentAgent, data.open.id, {client})
    t.is(detail.targets.length, departmentItems[0].counts.pointCount)
    t.deepEqual({...detail.permissions, exportTargetIds: undefined}, {...departmentItems[0].permissions, exportTargetIds: undefined})
    const forbidden = await t.throwsAsync(() => getCampaignDetail(data.departmentAgent, data.draft.id, {client}))
    t.is(forbidden.statusCode, 403)

    const sageItems = onlyFixtureItems(await listCampaigns(data.sageAgent, {client}))
    t.deepEqual(sageItems.map(item => item.campaign.id), [data.open.id])
    t.deepEqual(sageItems[0].counts, {pointCount: 2, preleveurCount: 2})
    t.is(sageItems[0].progress.receivedCount, 2)
    const shared = onlyFixtureItems(await listCampaigns(data.reader, {client}))
    t.deepEqual(shared.map(item => item.campaign.id), [data.open.id])
    t.true(shared[0].permissions.canExport)
    t.false(shared[0].permissions.canManage)
    const own = onlyFixtureItems(await listCampaigns(data.owner, {client}))
    const administered = onlyFixtureItems(await listCampaigns(data.admin, {client}))
    t.deepEqual(own.map(item => item.campaign.id).sort(), [data.open.id, data.draft.id].sort())
    t.deepEqual(administered.map(item => item.campaign.id).sort(), [data.open.id, data.draft.id].sort())
    t.true(own.every(item => item.permissions.canManage))
    t.is(own.find(item => item.campaign.id === data.draft.id).progress, null)
    t.true(own.every(item => !Object.hasOwn(item, 'targets') && !Object.hasOwn(item.campaign, 'targets') && !Object.hasOwn(item, 'managerOptions')))
    const farmerItems = onlyFixtureItems(await listCampaigns(data.farmer, {client}))
    t.is(farmerItems.length, 1)
    t.deepEqual(farmerItems[0].counts, {pointCount: 1, preleveurCount: 1})
    t.is(farmerItems[0].progress, null)
    // Ne laisser aucune fixture persistante et ne toucher à aucun compteur :
    // les autres scénarios d’intégration peuvent tourner dans cette base jetable.
    throw rollback
  }, {timeout: 30_000}), {is: rollback})
})
