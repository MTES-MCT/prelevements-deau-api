import test from 'ava'
import {randomUUID} from 'node:crypto'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {prisma} from '../../db/prisma.js'
import {requireDisposableDatabase} from '../../lib/util/test-helpers/disposable-database.js'
import {CAMPAIGN_READING_DATES} from '../../lib/services/campaign-readings.js'
import {applyCampaignPublications, previewCampaignPublications, verifyCampaignPublications,
  snapshotCampaignPublication, writePrivatePublicationReport} from '../lib/campaign-publication-recheck.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function fixture({linked = true, shared} = {}) {
  const admin = await prisma.user.create({data: {role: 'ADMIN'}})
  const farmer = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
  const collector = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {declarantRole: 'COLLECTEUR'}}}})
  const usage = await prisma.sandreWaterUse.findUnique({where: {code: '2'}})
  const point = await prisma.pointPrelevement.create({data: {name: `RECHECK-${randomUUID()}`,
    waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT', collectionMode: 'MANUAL'}})
  const exploitation = await prisma.declarantPointPrelevement.create({data: {pointPrelevementId: point.id,
    declarantUserId: farmer.id, usageId: usage.id, status: 'EN_ACTIVITE'}})
  const meter = shared?.meter ?? await prisma.compteur.create({data: {serialNumber: `RECHECK-${randomUUID()}`}})
  if (linked) await prisma.meterAllocation.create({data: {provider: 'synthetic-import', scope: 'fixture',
    sourceId: randomUUID(), compteurId: meter.id, exploitationId: exploitation.id}})
  const campaign = shared?.campaign ?? await prisma.collectionCampaign.create({data: {name: 'Reprise synthétique', status: 'OPEN',
    createdByUserId: admin.id, collecteurUserId: collector.id, opensOn: new Date('2026-09-01Z'), closesOn: new Date('2026-12-31Z')}})
  const responseId = randomUUID()
  const declaration = await prisma.declaration.create({data: {code: randomUUID().slice(0, 6).toUpperCase(),
    type: 'quick-declaration', declarantUserId: farmer.id, createdByDeclarantUserId: farmer.id,
    waterWithdrawalType: 'unknown', dataSourceType: 'MANUAL', processingStatus: 'COMPLETED',
    source: {create: {type: 'DECLARATION', status: 'COMPLETED', globalInstructionStatus: 'VALIDATED',
      metadata: {manualQuickDeclaration: true, collectionCampaignId: campaign.id, collectionResponseId: responseId},
      chunks: {create: CAMPAIGN_READING_DATES.map((date, index) => ({compteurId: meter.id, exploitationId: exploitation.id,
        pointPrelevementId: point.id, preleveurUserId: farmer.id, submittedByDeclarantUserId: farmer.id,
        usageId: usage.id, flowType: 'PRELEVEMENT', instructionStatus: 'VALIDATED', autoCalculateVolumes: false,
        minDate: new Date(`${date}T00:00:00Z`), maxDate: new Date(`${date}T00:00:00Z`),
        metadata: {collectionCampaignId: campaign.id, collectionResponseId: responseId, readingDate: date, physicalMeterRequired: true},
        chunkValues: {create: {metricTypeCode: 'index', value: [100, 150, 250][index], valueKind: 'DECLARED',
          periodStart: new Date(`${date}T00:00:00Z`), periodEnd: new Date(`${date}T00:00:01Z`), unit: 'm³', frequency: 'instant'}}
      }))}}}
  }})
  const submittedData = {meters: [{compteurId: meter.id, serialNumber: meter.serialNumber,
    offSeason: {indexStart: '100', indexEnd: '150', usageId: usage.id}, season: {indexEnd: '250', usageId: usage.id}}],
  needs: {season: {volume: '20000', flow: '35'}, offSeason: {volume: '0', flow: '0'}}, comment: 'Synthetic sent comment'}
  const response = await prisma.collectionResponse.create({data: {id: responseId, campaignId: campaign.id,
    exploitationId: exploitation.id, preleveurUserId: farmer.id, declarationId: declaration.id,
    firstSubmittedAt: new Date('2026-10-06Z'), lastSubmittedAt: new Date('2026-10-06Z'), revision: 3,
    submittedData, submittedHash: 'a'.repeat(64), draftData: {...submittedData, comment: 'Unsent draft retained'},
    publicationStatus: 'PENDING_REVIEW', publicationIssues: [{code: 'METER_PUBLICATION', compteurId: meter.id, message: 'Old broad guard'}]}})
  return {response, meter, campaign, options: {target: 'disposable', campaignId: campaign.id, responseIds: [responseId]}}
}

integration('preview is read-only; backup precedes changes; verify and original-preview replay preserve the submitted response', async t => {
  const f = await fixture()
  const before = await snapshotCampaignPublication(prisma, f.response.id)
  const preview = await previewCampaignPublications(prisma, f.options)
  t.is(preview.entries[0].publicationStatus, 'PUBLISHED')
  t.is((await snapshotCampaignPublication(prisma, f.response.id)).inputHash, before.inputHash)
  const options = {...f.options, expectedReport: preview, expectedReportHash: preview.reportHash}
  await t.throwsAsync(applyCampaignPublications(prisma, {...options,
    onBeforeApply: async () => { throw new Error('Backup storage unavailable') }}), {message: 'Backup storage unavailable'})
  t.is((await snapshotCampaignPublication(prisma, f.response.id)).inputHash, before.inputHash)
  const directory = await mkdtemp(path.join(os.tmpdir(), 'campaign-recheck-integration-'))
  t.teardown(() => rm(directory, {recursive: true, force: true}))
  const onBeforeApply = async backup => {
    t.is(backup.before.response.publicationStatus, 'PENDING_REVIEW')
    return writePrivatePublicationReport(path.join(directory, `${randomUUID()}.json`), backup)
  }
  const applied = await applyCampaignPublications(prisma, {...options, onBeforeApply})
  t.is(applied.counts.changed, 1)
  t.is(applied.counts.published, 1)
  const after = await snapshotCampaignPublication(prisma, f.response.id)
  t.is(after.protectedHash, before.protectedHash)
  t.true(after.snapshot.chunks.flatMap(chunk => chunk.chunkValues).some(value => value.valueKind === 'COMPUTED'))
  const verified = await verifyCampaignPublications(prisma, {...f.options, expectedReport: applied, expectedReportHash: applied.reportHash})
  t.true(verified.complete)
  const replay = await applyCampaignPublications(prisma, {...options, onBeforeApply: async () => { t.fail('Published replay must not need a new backup') }})
  t.is(replay.counts.changed, 0)
  t.is((await snapshotCampaignPublication(prisma, f.response.id)).inputHash, after.inputHash)
})

integration('a draft edited after preview aborts before backup or mutation; the production identity guard cannot be bypassed', async t => {
  const f = await fixture()
  const preview = await previewCampaignPublications(prisma, f.options)
  await prisma.collectionResponse.update({where: {id: f.response.id}, data: {draftData: {comment: 'Concurrent draft'}}})
  const before = await snapshotCampaignPublication(prisma, f.response.id)
  await t.throwsAsync(applyCampaignPublications(prisma, {...f.options, expectedReport: preview, expectedReportHash: preview.reportHash,
    onBeforeApply: async () => { t.fail('No backup needed for rejected stale input') }}), {message: /données protégées ont changé/})
  t.is((await snapshotCampaignPublication(prisma, f.response.id)).inputHash, before.inputHash)
  await t.throwsAsync(previewCampaignPublications(prisma, {...f.options, target: 'prod'}), {message: /identité PostgreSQL/})
})

integration('an unresolved attachment stays pending and a fresh-preview replay makes zero changes', async t => {
  const f = await fixture({linked: false})
  const preview = await previewCampaignPublications(prisma, f.options)
  t.is(preview.entries[0].publicationStatus, 'PENDING_REVIEW')
  t.is(preview.entries[0].publicationIssues[0].code, 'ATTACHMENT_REVIEW')
  const onBeforeApply = async () => ({syntheticDurableBackup: true})
  const applied = await applyCampaignPublications(prisma, {...f.options, expectedReport: preview,
    expectedReportHash: preview.reportHash, onBeforeApply})
  t.is(applied.counts.pending, 1)
  t.is(await prisma.meterReading.count({where: {compteurId: f.meter.id}}), 0)
  const fresh = await previewCampaignPublications(prisma, f.options)
  const replay = await applyCampaignPublications(prisma, {...f.options, expectedReport: fresh,
    expectedReportHash: fresh.reportHash, onBeforeApply})
  t.is(replay.counts.changed, 0)
  t.true((await verifyCampaignPublications(prisma, {...f.options, expectedReport: replay,
    expectedReportHash: replay.reportHash})).complete)
})

integration('a shared-meter batch refuses before writes; sequential fresh previews and verification remain idempotent', async t => {
  const first = await fixture({linked: false})
  const second = await fixture({linked: false, shared: first})
  const options = {...first.options, responseIds: [first.response.id, second.response.id]}
  const preview = await previewCampaignPublications(prisma, options)
  await t.throwsAsync(applyCampaignPublications(prisma, {...options, expectedReport: preview, expectedReportHash: preview.reportHash,
    onBeforeApply: async () => { t.fail('No writes or backup for a shared batch') }}), {message: /séparément/})
  const reports = []
  for (const f of [first, second]) {
    const fresh = await previewCampaignPublications(prisma, f.options)
    const applied = await applyCampaignPublications(prisma, {...f.options, expectedReport: fresh, expectedReportHash: fresh.reportHash,
      onBeforeApply: async () => ({syntheticDurableBackup: true})})
    t.is(applied.counts.pending, 1)
    reports.push({f, applied})
  }
  for (const {f, applied} of reports) {
    t.true((await verifyCampaignPublications(prisma, {...f.options, expectedReport: applied,
      expectedReportHash: applied.reportHash})).complete)
    const fresh = await previewCampaignPublications(prisma, f.options)
    t.is((await applyCampaignPublications(prisma, {...f.options, expectedReport: fresh, expectedReportHash: fresh.reportHash,
      onBeforeApply: async () => ({syntheticDurableBackup: true})})).counts.changed, 0)
  }
})
