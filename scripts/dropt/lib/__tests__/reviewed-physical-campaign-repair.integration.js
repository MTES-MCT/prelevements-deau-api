import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import {prisma} from '../../../../db/prisma.js'
import {requireDisposableDatabase} from '../../../../lib/util/test-helpers/disposable-database.js'
import {getAuthorizedCampaignResponseContext} from '../../../../lib/services/collection-campaigns.js'
import {digest} from '../epidropt.js'
import {reviewedPhysicalCampaignRepair, verifyReviewedPhysicalCampaignRepair} from '../repair-campaign-meters.js'

const enabled = process.env.DROPT_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function fixture({alreadyAllocated = false, anonymous = false} = {}) {
  const admin = await prisma.user.create({data: {role: 'ADMIN'}})
  const farmer = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
  const collector = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {declarantRole: 'COLLECTEUR'}}}})
  const usage = await prisma.sandreWaterUse.findUnique({where: {code: '2'}})
  const point = await prisma.pointPrelevement.create({data: {name: `PHYSICAL-${randomUUID()}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'}})
  const exploitation = await prisma.declarantPointPrelevement.create({data: {pointPrelevementId: point.id,
    declarantUserId: farmer.id, sourceId: `dropt-epidropt:exploitation:${randomUUID()}`, usageId: usage.id,
    excludeFromQuickDeclaration: true, collecteurs: {create: {collecteurUserId: collector.id}}}})
  const campaign = await prisma.collectionCampaign.create({data: {name: 'Revue physique synthétique', status: 'OPEN',
    createdByUserId: admin.id, collecteurUserId: collector.id, opensOn: new Date('2026-09-01Z'), closesOn: new Date('2027-12-31Z')}})
  const response = await prisma.collectionResponse.create({data: {campaignId: campaign.id, exploitationId: exploitation.id,
    preleveurUserId: farmer.id, prefillData: {meters: [{compteurId: null, serialNumber: null, offSeason: {indexStart: '100'}, season: {}}],
      needs: {season: {volume: '70'}, offSeason: {}}, comment: ''}, prefillMetadata: {sourceSha256: 'a'.repeat(64), rows: [2, 3]}}})
  const physical = []
  for (let index = 0; index < (anonymous ? 1 : 2); index++) {
    const meter = await prisma.compteur.create({data: {serialNumber: `SYNTHETIC-${randomUUID()}`}})
    physical.push(meter)
    if (alreadyAllocated) await prisma.meterAllocation.create({data: {sourceId: randomUUID(), provider: 'synthetic', scope: 'test',
      compteurId: meter.id, exploitationId: exploitation.id, versions: {create: {version: 1, enabled: false, percentage: null}}}})
  }
  const entry = {responseId: response.id, exploitationId: exploitation.id, pointPrelevementId: point.id,
    preleveurUserId: farmer.id, expectedPrefillHash: digest({prefillData: response.prefillData, prefillMetadata: response.prefillMetadata}),
    meters: physical.map(meter => ({compteurId: meter.id, expectedSerialNumber: meter.serialNumber, indexStart: anonymous ? null : '100'}))}
  if (anonymous) entry.meters.push({anonymousKey: 'confirmed-second-meter', indexStart: null})
  const plan = {version: 1, campaignId: campaign.id, evidence: [{fileName: 'synthetic.xlsx', sha256: 'b'.repeat(64), sheet: 'Proof', rows: [2, 3]}], entries: [entry]}
  return {admin, farmer, collector, point, exploitation, response, physical, plan, options: {target: 'local', actorUserId: admin.id}}
}

for (const anonymous of [false, true]) integration(`reviewed ${anonymous ? 'anonymous second' : 'existing two'} meters remain inactive, visible and idempotent`, async t => {
  const f = await fixture({alreadyAllocated: !anonymous, anonymous})
  const counts = async () => ({readings: await prisma.meterReading.count(), chunks: await prisma.chunk.count(),
    publications: await prisma.meterPublication.count(), versions: await prisma.meterAllocationVersion.count()})
  const before = await counts()
  const simulation = await reviewedPhysicalCampaignRepair(prisma, f.plan, f.options)
  t.is(simulation.counts.REPAIR, 1)
  let backedUp = false
  const application = await reviewedPhysicalCampaignRepair(prisma, f.plan, {...f.options, apply: true, expectedReport: simulation,
    onBeforeApply: async backup => { backedUp = backup.before.responses[0].id === f.response.id }})
  t.true(backedUp)
  t.deepEqual(await counts(), before)
  t.true((await verifyReviewedPhysicalCampaignRepair(prisma, f.plan, {...f.options, expectedReport: application})).complete)
  const saved = await prisma.collectionResponse.findUnique({where: {id: f.response.id}})
  t.deepEqual(saved.prefillData.needs, f.response.prefillData.needs)
  t.is(saved.prefillData.meters.length, 2)
  for (const user of [f.farmer, f.collector]) {
    const context = await getAuthorizedCampaignResponseContext(user, f.plan.campaignId, f.response.id)
    t.is(context.data.meters.length, 2)
    t.true(context.data.meters.every(meter => anonymous ? !meter.offSeason.indexStart : meter.offSeason.indexStart === '100'))
  }
  const replay = await reviewedPhysicalCampaignRepair(prisma, f.plan, f.options)
  t.is(replay.counts.REPAIR, 0)
  t.is(replay.counts.ALREADY_APPLIED, 1)
  await reviewedPhysicalCampaignRepair(prisma, f.plan, {...f.options, apply: true, expectedReport: replay, onBeforeApply: async () => {}})
  t.deepEqual(await prisma.collectionResponse.findUnique({where: {id: f.response.id}}), saved)
})

integration('a draft, changed reviewed proposal, external allocation or any meter stream blocks physical repair', async t => {
  for (const change of ['draft', 'prefill', 'allocation', 'stream']) {
    const f = await fixture({anonymous: true})
    if (change === 'draft') await prisma.collectionResponse.update({where: {id: f.response.id}, data: {draftData: {comment: 'Preserve'}, revision: 1}})
    if (change === 'prefill') await prisma.collectionResponse.update({where: {id: f.response.id}, data: {prefillMetadata: {manual: true}}})
    if (change === 'stream') await prisma.meterStream.create({data: {provider: 'test', scope: 'test', externalId: randomUUID(), compteurId: f.physical[0].id}})
    if (change === 'allocation') {
      const other = await fixture()
      await prisma.meterAllocation.create({data: {sourceId: randomUUID(), provider: 'test', scope: 'test', compteurId: f.physical[0].id,
        exploitationId: other.exploitation.id}})
    }
    await t.throwsAsync(reviewedPhysicalCampaignRepair(prisma, f.plan, f.options))
    t.is(await prisma.meterAllocation.count({where: {exploitationId: f.exploitation.id}}), 0)
  }
})

integration('backup failure preserves the old response and does not create the anonymous meter', async t => {
  const f = await fixture({anonymous: true})
  const simulation = await reviewedPhysicalCampaignRepair(prisma, f.plan, f.options)
  const count = await prisma.compteur.count()
  await t.throwsAsync(reviewedPhysicalCampaignRepair(prisma, f.plan, {...f.options, apply: true, expectedReport: simulation,
    onBeforeApply: async () => { throw new Error('Synthetic backup failure') }}), {message: 'Synthetic backup failure'})
  t.is(await prisma.compteur.count(), count)
  t.deepEqual(await prisma.collectionResponse.findUnique({where: {id: f.response.id}}), f.response)
})
