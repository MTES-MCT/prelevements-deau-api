import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {createCampaign, manageCampaignMeter, changeCampaignStatus, saveCampaignResponse, submitCampaignResponse} from '../campaigns.js'
import {buildCampaignWorkbook} from '../campaign-export-workbook.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'

const enabled = process.env.CAMPAIGN_INTEGRATION_TESTS === '1'
if (enabled) {
  requireDisposableDatabase()
}

const integration = enabled ? test.serial : test.skip
test.after.always(async () => {
  if (enabled) {
    await prisma.$disconnect()
    await globalThis.pgPool.end()
  }
})

async function fixture() {
  const suffix = randomUUID()
  const farmer = await prisma.user.create({data: {email: `reading-farmer-${suffix}@example.test`, role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
  const owner = await prisma.user.create({data: {email: `reading-owner-${suffix}@example.test`, role: 'DECLARANT', declarant: {create: {declarantRole: 'COLLECTEUR'}}}})
  const zoneId = randomUUID()
  await prisma.$executeRaw`
    INSERT INTO "Zone" (id, code, type, name, coordinates, "updatedAt")
    VALUES (${zoneId}::uuid, ${suffix}, 'SAGE', 'Test publication index', ST_GeomFromText('MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)))',4326), NOW())
  `
  const usage = await prisma.sandreWaterUse.create({data: {code: suffix.slice(0, 16), kind: 'USAGE', label: 'Usage de test'}})
  const point = await prisma.pointPrelevement.create({data: {
    name: `Test index ${suffix}`, flowType: 'PRELEVEMENT', waterBodyType: 'SUPERFICIELLE', collectionMode: 'MANUAL', zones: {create: {zoneId}}
  }})
  const exploitation = await prisma.declarantPointPrelevement.create({data: {
    declarantUserId: farmer.id, pointPrelevementId: point.id, usageId: usage.id, status: 'EN_ACTIVITE', startDate: new Date('2020-01-01'),
    collecteurs: {create: {collecteurUserId: owner.id}}
  }})
  const {campaign} = await createCampaign(owner, {
    name: `Publication index ${suffix}`, year: 2026, ownerCollecteurUserId: owner.id, zoneId,
    opensAt: new Date(Date.now() - 60_000).toISOString(), closesAt: new Date(Date.now() + (30 * 86_400_000)).toISOString(),
    indexDates: ['2026-01-01', '2026-07-01'],
    periods: [
      {kind: 'INDEX', position: 0, label: 'Semestre', startDate: '2026-01-01', endDate: '2026-07-01', startReadingDate: '2026-01-01', endReadingDate: '2026-07-01'},
      {kind: 'NEEDS', position: 0, label: 'Année suivante', startDate: '2027-01-01', endDate: '2028-01-01'}
    ], targets: [{exploitationId: exploitation.id, eligibilityConfirmed: true}]
  })
  const configured = await manageCampaignMeter(owner, campaign.id, campaign.targets[0].id, undefined, {
    expectedVersion: campaign.version, identifier: `old-${suffix}`, startDate: '2020-01-01'
  })
  const opened = await changeCampaignStatus(owner, campaign.id, 'OPEN', {expectedVersion: configured.campaign.version})
  return {farmer, campaign: opened.campaign, suffix, point, target: opened.campaign.targets[0]}
}

integration('un relevé masqué par remplacement reste au brouillon, jamais dans les index canoniques ni le snapshot et l’export officiels', async t => {
  const {farmer, campaign, target, point, suffix} = await fixture()
  const oldId = target.meters[0].compteurId
  const save = (expectedVersion, data) => saveCampaignResponse(farmer, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion, data})
  const inactive = {targetId: target.id, compteurId: oldId, readingDate: '2026-07-01', value: '9999'}
  const initial = await save(0, {readings: [
    {targetId: target.id, compteurId: oldId, readingDate: '2026-01-01', value: '100'}, inactive
  ], meterEvents: []})
  const replaced = await save(initial.response.version, {...initial.response.draft, meterEvents: [{
    targetId: target.id, type: 'REPLACEMENT', at: '2026-03-01', previousCompteurId: oldId,
    nextMeter: {serialNumber: `new-${suffix}`}, previousIndex: '150', nextIndex: '0', reason: 'Remplacement'
  }]})
  const pendingId = replaced.targets[0].meters.find(meter => meter.pending).compteurId
  const complete = await save(replaced.response.version, {...replaced.response.draft, readings: [
    ...replaced.response.draft.readings, {targetId: target.id, compteurId: pendingId, readingDate: '2026-07-01', value: '50'}
  ]})
  t.true(complete.calculation.canSubmit)
  t.is(complete.calculation.totals[0].value, '100')
  t.is(complete.calculation.ignoredReadings[0].value, '9999')

  const request = {preleveurUserId: farmer.id, expectedVersion: complete.response.version, idempotencyKey: randomUUID()}
  const submitted = await submitCampaignResponse(farmer, campaign.id, 'INDEX', request)
  t.is(submitted.response.status, 'SUBMITTED')
  t.is(submitted.submission.publication.totals[0].value, '100')
  t.false(submitted.submission.snapshot.readings.some(reading => reading.value === '9999'))
  t.true(submitted.response.draft.readings.some(reading => reading.compteurId === oldId && reading.value === '9999'))
  t.false(Object.hasOwn(submitted.submission.publication, 'ignoredReadings'))
  const firstOfficial = await prisma.campaignSubmission.findUniqueOrThrow({where: {id: submitted.submission.id}})
  t.deepEqual(firstOfficial.snapshot, submitted.submission.snapshot)
  const canonical = () => prisma.chunkValue.findMany({where: {
    metricTypeCode: 'index', chunk: {pointPrelevementId: point.id, source: {status: 'COMPLETED'}}
  }, select: {value: true, readingDate: true, chunk: {select: {compteurId: true}}}})
  const firstReadings = await canonical()
  t.is(firstReadings.length, 4)
  t.false(firstReadings.some(reading => reading.chunk.compteurId === oldId && reading.readingDate.toISOString().startsWith('2026-07-01')))
  const replay = await submitCampaignResponse(farmer, campaign.id, 'INDEX', request)
  t.is(replay.submission.id, firstOfficial.id)
  const afterReplay = await canonical()
  t.is(afterReplay.length, 4)

  const revised = await save(submitted.response.version, {...submitted.response.draft, comment: 'Précision sans changer les valeurs'})
  const retransmitted = await submitCampaignResponse(farmer, campaign.id, 'INDEX', {
    preleveurUserId: farmer.id, expectedVersion: revised.response.version, idempotencyKey: randomUUID()
  })
  t.is(retransmitted.submission.publication.totals[0].value, '100')
  t.false(retransmitted.submission.snapshot.readings.some(reading => reading.value === '9999'))
  t.true(retransmitted.response.draft.readings.some(reading => reading.value === '9999'))
  const afterRevision = await canonical()
  t.is(afterRevision.length, 4)
  const originalSubmission = await prisma.campaignSubmission.findUniqueOrThrow({where: {id: firstOfficial.id}})
  t.deepEqual(originalSubmission.snapshot, firstOfficial.snapshot)

  const workbook = buildCampaignWorkbook({campaign, targets: retransmitted.targets, responses: [{
    preleveurUserId: farmer.id, kind: 'INDEX', latestSubmission: retransmitted.submission
  }]})
  const sheet = workbook.getWorksheet('Relevés de compteurs')
  const valueColumn = sheet.getRow(1).values.indexOf('Index (m³)')
  t.true(valueColumn > 0)
  t.is(sheet.rowCount, 3)
  t.deepEqual([sheet.getCell(2, valueColumn).value, sheet.getCell(3, valueColumn).value], ['100', '50'])
})
