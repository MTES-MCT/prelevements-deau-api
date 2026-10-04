import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import {prisma} from '../../../../db/prisma.js'
import {requireDisposableDatabase} from '../../../../lib/util/test-helpers/disposable-database.js'
import {repairCampaignCountings, verifyCampaignCountingRepair} from '../repair-campaign-countings.js'
import {CAMPAIGN_PREFILL_HEADERS, parseCampaignPrefillRows} from '../campaign-prefill-source.js'
import {getAuthorizedCampaignResponseContext} from '../../../../lib/services/collection-campaigns.js'

const enabled = process.env.DROPT_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function fixture() {
  const admin = await prisma.user.create({data: {role: 'ADMIN'}})
  const farmer = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {
    declarantRole: 'PRELEVEUR', preleveurType: 'IRRIGANT', siret: '00000000000001'}}}})
  const collector = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {declarantRole: 'COLLECTEUR'}}}})
  const stranger = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {declarantRole: 'COLLECTEUR'}}}})
  const usage = await prisma.sandreWaterUse.findUnique({where: {code: '2'}})
  const secondary = await prisma.sandreWaterUse.findUnique({where: {code: '12'}})
  const point = await prisma.pointPrelevement.create({data: {name: `COUNTING-${randomUUID()}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'}})
  const exploitation = await prisma.declarantPointPrelevement.create({data: {pointPrelevementId: point.id,
    declarantUserId: farmer.id, sourceId: `dropt-epidropt:exploitation:${randomUUID()}`, usageId: usage.id,
    status: 'EN_ACTIVITE', excludeFromQuickDeclaration: true,
    collecteurs: {create: {collecteurUserId: collector.id}}, secondaryUsageLinks: {create: {usageId: secondary.id}}}})
  const campaign = await prisma.collectionCampaign.create({data: {name: 'Comptages synthétiques', status: 'OPEN',
    createdByUserId: admin.id, collecteurUserId: collector.id, opensOn: new Date('2026-09-01Z'), closesOn: new Date('2027-12-31Z')}})
  const response = await prisma.collectionResponse.create({data: {campaignId: campaign.id,
    exploitationId: exploitation.id, preleveurUserId: farmer.id}})
  const row = code => {
    const cells = Array(25).fill(null)
    Object.assign(cells, {1: point.name, 2: '00000000000001', 3: 500, 4: 10, 5: 2, 7: 3, 8: 20,
      11: 100, 13: 200, 16: 0, 17: code, 18: `AE-${code}`, 21: 123, 22: 'Irrigation', 23: 'Irrigation'})
    return cells
  }
  const source = {...parseCampaignPrefillRows([CAMPAIGN_PREFILL_HEADERS, row('COUNT-1'), row('COUNT-2')]), source: {sha256: 'a'.repeat(64)}}
  return {admin, farmer, collector, stranger, point, exploitation, campaign, response, source,
    options: {campaignId: campaign.id, actorUserId: admin.id, target: 'local', allowCountingSplit: true}}
}

integration('reviewed repair preserves access and exclusions, writes no physical data and is idempotent', async t => {
  const f = await fixture()
  const original = await prisma.collectionResponse.findUnique({where: {id: f.response.id}})
  const countPhysical = async () => ({meters: await prisma.compteur.count(), readings: await prisma.chunkValue.count(), sources: await prisma.source.count()})
  const before = await countPhysical()
  const simulation = await repairCampaignCountings(prisma, f.source, f.options)
  t.is(simulation.counts.SPLIT, 1)
  t.deepEqual(await prisma.collectionResponse.findUnique({where: {id: f.response.id}}), original)
  let backup
  const onBeforeApply = async value => {
    backup = value
    t.is(await prisma.collectionResponse.count({where: {campaignId: f.campaign.id}}), 1)
  }
  const applied = await repairCampaignCountings(prisma, f.source, {...f.options, apply: true, expectedReport: simulation, onBeforeApply})
  t.is(backup.before.responses[0].exploitation.countingCode, null)
  t.deepEqual(await countPhysical(), before)
  t.true((await verifyCampaignCountingRepair(prisma, f.source, {...f.options, allowCountingSplit: false, expectedReport: applied})).complete)
  const saved = await prisma.collectionResponse.findMany({where: {campaignId: f.campaign.id}, orderBy: {id: 'asc'}, include: {exploitation: true}})
  t.is(saved.length, 2)
  for (const response of saved) {
    t.true(response.exploitation.excludeFromQuickDeclaration)
    t.is(response.revision, 0)
    t.deepEqual(response.prefillData.needs, {season: {}, offSeason: {}})
    for (const user of [f.farmer, f.collector]) {
      const context = await getAuthorizedCampaignResponseContext(user, f.campaign.id, response.id)
      t.is(context.data.meters.length, 1)
      t.deepEqual(context.data.meters[0].offSeason, {})
    }
    await t.throwsAsync(getAuthorizedCampaignResponseContext(f.stranger, f.campaign.id, response.id))
  }
  const replay = await repairCampaignCountings(prisma, f.source, f.options)
  t.is(replay.counts.SPLIT, 0)
  t.is(replay.counts.ALREADY_APPLIED, 1)
  await repairCampaignCountings(prisma, f.source, {...f.options, apply: true, expectedReport: replay, onBeforeApply: async () => {}})
  t.deepEqual(await prisma.collectionResponse.findMany({where: {campaignId: f.campaign.id}, orderBy: {id: 'asc'}, include: {exploitation: true}}), saved)
})

integration('a draft saved after simulation invalidates the whole plan and is preserved', async t => {
  const f = await fixture()
  const simulation = await repairCampaignCountings(prisma, f.source, f.options)
  await prisma.collectionResponse.update({where: {id: f.response.id}, data: {draftData: {comment: 'Saisie à conserver'}, revision: 1}})
  await t.throwsAsync(repairCampaignCountings(prisma, f.source, {...f.options, apply: true, expectedReport: simulation,
    onBeforeApply: async () => t.fail('No backup or writes when the plan has changed')}), {message: /État modifié/})
  t.is((await prisma.collectionResponse.findUnique({where: {id: f.response.id}})).draftData.comment, 'Saisie à conserver')
  t.is(await prisma.declarantPointPrelevement.count({where: {pointPrelevementId: f.point.id}}), 1)
})

integration('a new physical allocation blocks repair even when its meter has no observations', async t => {
  const f = await fixture()
  const simulation = await repairCampaignCountings(prisma, f.source, f.options)
  const meter = await prisma.compteur.create({data: {serialNumber: `SYNTHETIC-${randomUUID()}`}})
  await prisma.meterAllocation.create({data: {sourceId: randomUUID(), provider: 'test', scope: 'test',
    compteurId: meter.id, exploitationId: f.exploitation.id}})
  await t.throwsAsync(repairCampaignCountings(prisma, f.source, {...f.options, apply: true, expectedReport: simulation,
    onBeforeApply: async () => {}}), {message: /État modifié/})
  const current = await repairCampaignCountings(prisma, f.source, f.options)
  t.is(current.entries[0].reason, 'EXISTING_DEPENDENCIES_OR_HISTORY')
})

integration('failing durable backup aborts before the first mutation', async t => {
  const f = await fixture()
  const simulation = await repairCampaignCountings(prisma, f.source, f.options)
  await t.throwsAsync(repairCampaignCountings(prisma, f.source, {...f.options, apply: true, expectedReport: simulation,
    onBeforeApply: async () => { throw new Error('Synthetic disk failure') }}), {message: 'Synthetic disk failure'})
  t.is((await prisma.declarantPointPrelevement.findUnique({where: {id: f.exploitation.id}})).countingCode, null)
  t.is(await prisma.collectionResponse.count({where: {campaignId: f.campaign.id}}), 1)
})
