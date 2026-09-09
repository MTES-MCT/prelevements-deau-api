import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import ExcelJS from 'exceljs'
import {prisma} from '../../../db/prisma.js'
import {updateChunkInstructionHandler} from '../../handlers/chunks.js'
import {changeCampaignStatus, createCampaign, getCampaignContext, getCampaignDetail, getCampaignOptions, updateCampaignManagers, manageCampaignMeter, reopenCampaignResponse, saveCampaignResponse, submitCampaignResponse} from '../campaigns.js'
import {createCampaignExport, getCampaignExport, processCampaignExport, processCampaignNotification} from '../campaign-delivery.js'
import {reconstructVolumesFromIndexForPoint} from '../volumes-from-index.js'

const enabled = process.env.CAMPAIGN_INTEGRATION_TESTS === '1'
if (enabled) {
  const url = new URL(process.env.DATABASE_URL)
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/campaign_tests' || url.port !== '55439') {
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

async function fixture({firstPointCollectionMode = 'MANUAL'} = {}) {
  const suffix = randomUUID()
  const farmer = await prisma.user.create({data: {email: `farmer-${suffix}@example.test`, role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
  const owner = await prisma.user.create({data: {email: `collector-${suffix}@example.test`, role: 'DECLARANT', declarant: {create: {declarantRole: 'COLLECTEUR'}}}})
  const partial = await prisma.user.create({data: {email: `partial-${suffix}@example.test`, role: 'DECLARANT', declarant: {create: {declarantRole: 'COLLECTEUR'}}}})
  const zoneId = randomUUID()
  await prisma.$executeRaw`
    INSERT INTO "Zone" ("id", "code", "type", "name", "coordinates", "updatedAt")
    VALUES (${zoneId}::uuid, ${suffix}, 'SAGE', 'Zone de test campagne', ST_GeomFromText('MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)))',4326), NOW())
  `
  const usage = await prisma.sandreWaterUse.create({data: {code: suffix.slice(0, 16), kind: 'USAGE', label: 'Usage de test'}})
  const points = await Promise.all([0, 1].map(index => prisma.pointPrelevement.create({data: {
    name: `Campagne ${suffix} ${index}`, flowType: 'PRELEVEMENT', waterBodyType: 'SUPERFICIELLE', collectionMode: index === 0 ? firstPointCollectionMode : 'EXTERNAL',
    zones: {create: {zoneId}}
  }})))
  const exploitations = await Promise.all(points.map((point, index) => prisma.declarantPointPrelevement.create({data: {
    declarantUserId: farmer.id, pointPrelevementId: point.id, usageId: usage.id, status: 'EN_ACTIVITE', startDate: new Date('2020-01-01'),
    collecteurs: {create: [{collecteurUserId: owner.id}, ...(index === 0 ? [{collecteurUserId: partial.id}] : [])]}
  }})))
  return {owner, farmer, partial, zoneId, points, exploitations, suffix, usage}
}

async function rejectsWithStatus(t, action, status) {
  const error = await t.throwsAsync(action)
  t.is(error.status, status)
}

integration('sans mode ni inventaire : ouverture, saisie par point, confirmation, publication et export sans faux compteur', async t => {
  const {owner, farmer, zoneId, points, exploitations, suffix} = await fixture({firstPointCollectionMode: null})
  const meterCount = await prisma.compteur.count()
  let {campaign} = await createCampaign(owner, {
    name: `Collecte ${suffix}`, year: 2026, ownerCollecteurUserId: owner.id, zoneId,
    opensAt: new Date(Date.now() - 60_000).toISOString(), closesAt: new Date(Date.now() + 86_400_000).toISOString(),
    indexDates: ['2025-10-31', '2026-06-01', '2026-10-31'],
    periods: [
      {kind: 'INDEX', position: 0, label: 'Première période', startDate: '2025-11-01', endDate: '2026-06-01', startReadingDate: '2025-10-31', endReadingDate: '2026-06-01'},
      {kind: 'INDEX', position: 1, label: 'Deuxième période', startDate: '2026-06-01', endDate: '2026-11-01', startReadingDate: '2026-06-01', endReadingDate: '2026-10-31'},
      {kind: 'NEEDS', position: 0, label: 'Besoins à venir', startDate: '2027-01-01', endDate: '2028-01-01'}
    ], targets: [{exploitationId: exploitations[0].id, eligibilityConfirmed: true}]
  });
  ({campaign} = await changeCampaignStatus(owner, campaign.id, 'OPEN', {expectedVersion: campaign.version}))
  const [target] = campaign.targets
  t.deepEqual(target.meters, [])
  t.is(target.pointPrelevement.collectionMode, null)
  t.is(await prisma.compteur.count(), meterCount)
  t.is(await prisma.campaignTargetMeter.count({where: {targetId: target.id}}), 0)
  await rejectsWithStatus(t, () => manageCampaignMeter(owner, campaign.id, target.id, undefined, {expectedVersion: campaign.version, identifier: 'Ne pas créer', startDate: '2026-01-01'}), 409)
  const readings = campaign.indexDates.map((readingDate, index) => ({targetId: target.id, compteurId: null, readingDate, value: ['0', '100', '300'][index]}))
  await rejectsWithStatus(t, () => saveCampaignResponse(owner, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: 0, data: {readings: [{...readings[0], targetId: randomUUID()}]}}), 403)
  const unconfirmed = await saveCampaignResponse(owner, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: 0, data: {readings}})
  t.false(unconfirmed.calculation.canSubmit)
  await rejectsWithStatus(t, () => submitCampaignResponse(owner, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: unconfirmed.response.version, idempotencyKey: randomUUID()}), 409)
  t.is(await prisma.chunk.count({where: {pointPrelevementId: points[0].id}}), 0)
  const confirmed = await saveCampaignResponse(farmer, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: unconfirmed.response.version, data: {readings: readings.map(reading => ({...reading, meterConfirmed: true}))}})
  t.true(confirmed.calculation.canSubmit)
  const submitRequest = {preleveurUserId: farmer.id, expectedVersion: confirmed.response.version, idempotencyKey: randomUUID()}
  await prisma.pointPrelevement.update({where: {id: points[0].id}, data: {collectionMode: 'EXTERNAL'}})
  await rejectsWithStatus(t, () => saveCampaignResponse(farmer, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: confirmed.response.version, data: {readings}}), 403)
  await rejectsWithStatus(t, () => submitCampaignResponse(farmer, campaign.id, 'INDEX', submitRequest), 403)
  await prisma.pointPrelevement.update({where: {id: points[0].id}, data: {collectionMode: null}})
  const transmitted = await submitCampaignResponse(farmer, campaign.id, 'INDEX', submitRequest)
  await submitCampaignResponse(farmer, campaign.id, 'INDEX', submitRequest)
  t.is(await prisma.campaignSubmission.count({where: {responseId: transmitted.response.id}}), 1)
  t.deepEqual(transmitted.response.latestSubmission.publication.totals.map(total => total.value), ['100', '200'])
  const indexWhere = {chunk: {pointPrelevementId: points[0].id}, metricTypeCode: 'index'}
  const indices = await prisma.chunkValue.findMany({where: indexWhere, include: {chunk: true}})
  t.is(indices.length, 3)
  t.true(indices.every(index => index.chunk.compteurId === null && index.chunk.calculationStrategy === 'CAMPAIGN'))
  const revised = await saveCampaignResponse(owner, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: transmitted.response.version, data: {...transmitted.response.draft, comment: 'Commentaire complémentaire'}})
  await submitCampaignResponse(owner, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: revised.response.version, idempotencyKey: randomUUID()})
  t.is(await prisma.chunkValue.count({where: indexWhere}), 3)
  t.is(await prisma.compteur.count(), meterCount)
  const needs = campaign.periods.filter(period => period.kind === 'NEEDS').map(period => ({targetId: target.id, periodId: period.id, requestedFlow: '5', requestedVolume: '1000'}))
  const needsDraft = await saveCampaignResponse(farmer, campaign.id, 'NEEDS', {preleveurUserId: farmer.id, expectedVersion: 0, data: {needs}})
  const needsSubmission = await submitCampaignResponse(farmer, campaign.id, 'NEEDS', {preleveurUserId: farmer.id, expectedVersion: needsDraft.response.version, idempotencyKey: randomUUID()})
  t.is(needsSubmission.response.latestSubmission.snapshot.needs[0].requestedVolume, '1000')
  const point = await prisma.pointPrelevement.findUnique({where: {id: points[0].id}, select: {collectionMode: true}})
  t.is(point.collectionMode, null)
  let uploadedBuffer
  const storageFactory = () => ({async uploadObject(_key, buffer) {
    uploadedBuffer = buffer
  }})
  const exported = await createCampaignExport(owner, campaign.id)
  t.deepEqual(await processCampaignExport(exported.id, {storageFactory}), {completed: true})
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(uploadedBuffer)
  t.is(workbook.getWorksheet('Index').rowCount, 4)
  t.is(workbook.getWorksheet('Index').getCell('E2').value, 'Non renseigné')
  t.is(workbook.getWorksheet('Index').getCell('Q2').value, 'Oui')
})

integration('options et partage : filtres paginés, ambiguïtés et droits conservés après ouverture et clôture', async t => {
  const {owner, farmer, partial, zoneId, points, exploitations, suffix, usage} = await fixture()
  await prisma.user.update({where: {id: farmer.id}, data: {firstName: 'Jean', lastName: 'Dupont'}})
  const secondUsage = await prisma.sandreWaterUse.create({data: {code: randomUUID().slice(0, 16), kind: 'USAGE', label: 'Autre usage de test'}})
  await prisma.declarantPointPrelevement.create({data: {
    declarantUserId: farmer.id, pointPrelevementId: points[0].id, usageId: secondUsage.id, status: 'TERMINEE', startDate: new Date('2010-01-01'), endDate: new Date('2019-12-31'),
    collecteurs: {create: {collecteurUserId: owner.id}}
  }})
  const options = await getCampaignOptions(owner, {zoneId, ownerCollecteurUserId: owner.id, usageId: usage.id, q: 'Jean Dupont', limit: 1})
  t.is(options.pagination.total, 2)
  t.true(options.pagination.hasMore)
  t.true(options.exploitations[0].ambiguousPoint)
  t.is(options.exploitations[0].usage.name, usage.label)
  t.deepEqual(options.usages.map(item => item.id).sort(), [usage.id, secondUsage.id].sort())
  const next = await getCampaignOptions(owner, {zoneId, ownerCollecteurUserId: owner.id, usageId: usage.id, q: 'Jean Dupont', limit: 1, cursor: options.pagination.nextCursor})
  t.false(next.pagination.hasMore)
  t.not(next.exploitations[0].id, options.exploitations[0].id)
  t.is(next.exploitations[0].pointPrelevement.collectionMode, 'EXTERNAL')
  await rejectsWithStatus(t, () => getCampaignOptions(owner, {zoneId: randomUUID()}), 403)
  await rejectsWithStatus(t, () => getCampaignOptions(owner, {zoneId, ownerCollecteurUserId: partial.id}), 403)
  let detail = await createCampaign(owner, {
    name: `Suivi ${suffix}`, year: 2026, ownerCollecteurUserId: owner.id, zoneId,
    indexDates: ['2026-01-01', '2027-01-01'],
    periods: [
      {kind: 'INDEX', position: 0, label: 'Année écoulée', startDate: '2026-01-01', endDate: '2027-01-01', startReadingDate: '2026-01-01', endReadingDate: '2027-01-01'},
      {kind: 'NEEDS', position: 0, label: 'Année à venir', startDate: '2027-01-01', endDate: '2028-01-01'}
    ], targets: [{exploitationId: exploitations[0].id, eligibilityConfirmed: true}]
  })
  const delegate = await prisma.user.create({data: {email: `delegate-${suffix}@example.test`, role: 'DECLARANT', declarant: {create: {declarantRole: 'COLLECTEUR', socialReason: 'Organisme délégué'}}}})
  detail = await changeCampaignStatus(owner, detail.campaign.id, 'OPEN', {expectedVersion: detail.campaign.version})
  const unchanged = JSON.stringify({periods: detail.campaign.periods, targets: detail.campaign.targets, indexDates: detail.campaign.indexDates})
  const notifications = await prisma.campaignNotification.count({where: {campaignId: detail.campaign.id}})
  detail = await updateCampaignManagers(owner, detail.campaign.id, {expectedVersion: detail.campaign.version, managers: [{userId: delegate.id, role: 'READER'}]})
  t.true(detail.permissions.canManageSharing)
  t.is(detail.campaign.zone.name, 'Zone de test campagne')
  t.is(detail.campaign.targets[0].usage.name, usage.label)
  t.deepEqual(detail.campaign.managers, [{userId: delegate.id, role: 'READER', label: 'Organisme délégué'}])
  t.true(detail.managerOptions.some(option => option.userId === delegate.id && option.label === 'Organisme délégué'))
  t.is(JSON.stringify({periods: detail.campaign.periods, targets: detail.campaign.targets, indexDates: detail.campaign.indexDates}), unchanged)
  const reader = await getCampaignDetail(delegate, detail.campaign.id)
  t.false(reader.permissions.canManageSharing)
  t.false(Object.hasOwn(reader.campaign, 'managers'))
  t.deepEqual(reader.managerOptions, [])
  await rejectsWithStatus(t, () => updateCampaignManagers(delegate, detail.campaign.id, {expectedVersion: detail.campaign.version, managers: []}), 403)
  await rejectsWithStatus(t, () => updateCampaignManagers(owner, detail.campaign.id, {expectedVersion: detail.campaign.version - 1, managers: []}), 409)
  await rejectsWithStatus(t, () => updateCampaignManagers(owner, detail.campaign.id, {expectedVersion: detail.campaign.version, managers: [{userId: farmer.id, role: 'MANAGER'}]}), 400)
  const archived = await prisma.user.create({data: {role: 'DECLARANT', deletedAt: new Date(), declarant: {create: {declarantRole: 'COLLECTEUR'}}}})
  await rejectsWithStatus(t, () => updateCampaignManagers(owner, detail.campaign.id, {expectedVersion: detail.campaign.version, managers: [{userId: archived.id, role: 'READER'}]}), 400)
  detail = await changeCampaignStatus(owner, detail.campaign.id, 'CLOSED', {expectedVersion: detail.campaign.version})
  detail = await updateCampaignManagers(owner, detail.campaign.id, {expectedVersion: detail.campaign.version, managers: [{userId: delegate.id, role: 'MANAGER'}]})
  t.is(detail.campaign.status, 'CLOSED')
  t.is(await prisma.campaignNotification.count({where: {campaignId: detail.campaign.id}}), notifications)
  const relinquished = await updateCampaignManagers(delegate, detail.campaign.id, {expectedVersion: detail.campaign.version, managers: []})
  t.true(relinquished.accessRevoked)
  t.is(relinquished.campaign, null)
  t.is(await prisma.campaignManager.count({where: {campaignId: detail.campaign.id}}), 0)
  await prisma.declarantCollecteurExploitation.deleteMany({where: {collecteurUserId: owner.id, exploitationId: exploitations[0].id}})
  const limitedOwner = await getCampaignDetail(owner, detail.campaign.id)
  t.true(limitedOwner.permissions.canManage)
  t.false(limitedOwner.permissions.canManageSharing)
  await rejectsWithStatus(t, () => updateCampaignManagers(owner, detail.campaign.id, {expectedVersion: limitedOwner.campaign.version, managers: [{userId: delegate.id, role: 'READER'}]}), 403)
})

integration('campagne réelle : migration, deux volets, mandats, corrections, calcul exact, anti-doublon et export privé', async t => {
  const {owner, farmer, partial, zoneId, points, exploitations, suffix, usage} = await fixture()
  let {campaign} = await createCampaign(owner, {
    name: `Campagne test ${suffix}`, year: 2026, ownerCollecteurUserId: owner.id, zoneId,
    opensAt: new Date(Date.now() - 60_000).toISOString(), closesAt: new Date(Date.now() + 86_400_000).toISOString(),
    indexDates: ['2025-10-31', '2026-06-01', '2026-10-31'], reminderDays: [14, 3],
    periods: [
      {kind: 'INDEX', position: 0, label: 'Hors étiage', startDate: '2025-11-01', endDate: '2026-06-01', startReadingDate: '2025-10-31', endReadingDate: '2026-06-01'},
      {kind: 'INDEX', position: 1, label: 'Étiage', startDate: '2026-06-01', endDate: '2026-11-01', startReadingDate: '2026-06-01', endReadingDate: '2026-10-31'},
      {kind: 'NEEDS', position: 0, label: 'Besoins étiage', startDate: '2027-06-01', endDate: '2027-11-01'},
      {kind: 'NEEDS', position: 1, label: 'Besoins hors étiage', startDate: '2027-11-01', endDate: '2028-06-01'}
    ], targets: exploitations.map(exploitation => ({exploitationId: exploitation.id, eligibilityConfirmed: true}))
  })
  for (const target of campaign.targets) {
    // Each meter configuration increments the campaign version.
    // eslint-disable-next-line no-await-in-loop
    ({campaign} = await manageCampaignMeter(owner, campaign.id, target.id, undefined, {expectedVersion: campaign.version, identifier: `meter-${target.id}`, startDate: '2020-01-01', endDate: null}))
  }

  await rejectsWithStatus(t, () => changeCampaignStatus(owner, campaign.id, 'OPEN', {expectedVersion: campaign.version}), 409)
  await prisma.pointPrelevement.update({where: {id: points[1].id}, data: {collectionMode: 'MANUAL'}});
  ({campaign} = await changeCampaignStatus(owner, campaign.id, 'OPEN', {expectedVersion: campaign.version}))
  const context = await getCampaignContext(owner, campaign.id, farmer.id)
  t.true(context.permissions.canSubmit)
  const limited = await getCampaignContext(partial, campaign.id, farmer.id)
  t.is(limited.targets.length, 1)
  t.false(limited.permissions.canSubmit)
  const needs = context.targets.flatMap(target => campaign.periods.filter(period => period.kind === 'NEEDS').map(period => ({targetId: target.id, periodId: period.id, requestedFlow: '0', requestedVolume: '0'})))
  const firstDraft = await saveCampaignResponse(owner, campaign.id, 'NEEDS', {preleveurUserId: farmer.id, expectedVersion: 0, data: {needs, comment: 'Transmission initiale'}})
  const firstSubmitRequest = {preleveurUserId: farmer.id, expectedVersion: firstDraft.response.version, idempotencyKey: randomUUID()}
  const first = await submitCampaignResponse(owner, campaign.id, 'NEEDS', firstSubmitRequest)
  await submitCampaignResponse(owner, campaign.id, 'NEEDS', firstSubmitRequest)
  t.is(await prisma.campaignSubmission.count({where: {responseId: first.response.id}}), 1)
  t.is(await prisma.chunk.count({where: {pointPrelevementId: {in: points.map(point => point.id)}}}), 0)
  const correctedNeeds = needs.map(line => ({...line, requestedVolume: '125.5'}))
  const correction = await saveCampaignResponse(owner, campaign.id, 'NEEDS', {preleveurUserId: farmer.id, expectedVersion: first.response.version, data: {needs: correctedNeeds}})
  t.is(correction.response.latestSubmission.id, first.response.latestSubmission.id)
  t.is(correction.response.latestSubmission.snapshot.needs[0].requestedVolume, '0')
  await rejectsWithStatus(t, () => saveCampaignResponse(owner, campaign.id, 'NEEDS', {preleveurUserId: farmer.id, expectedVersion: first.response.version, data: {needs}}), 409)
  const corrected = await submitCampaignResponse(owner, campaign.id, 'NEEDS', {preleveurUserId: farmer.id, expectedVersion: correction.response.version, idempotencyKey: randomUUID()})
  t.is(corrected.response.latestSubmission.snapshot.needs[0].requestedVolume, '125.5')
  const limitedSubmitted = await getCampaignContext(partial, campaign.id, farmer.id)
  t.is(limitedSubmitted.responses.NEEDS.latestSubmission.snapshot.needs.length, 2)
  t.false(Object.hasOwn(limitedSubmitted.responses.NEEDS.latestSubmission.snapshot, 'comment'))
  await t.throwsAsync(() => prisma.campaignSubmission.update({where: {id: first.response.latestSubmission.id}, data: {snapshot: {needs: []}}}))

  const createLegacySource = (status, instructionStatus) => prisma.source.create({data: {
    type: 'BATCH', status, chunks: {create: {
      pointPrelevementId: points[0].id, preleveurUserId: farmer.id, usageId: usage.id, instructionStatus,
      minDate: new Date('2026-06-01'), maxDate: new Date('2026-11-01'),
      chunkValues: {create: {metricTypeCode: 'volume', unit: 'm³', frequency: 'month', valueKind: 'DECLARED', value: '20', periodStart: new Date('2026-06-01'), periodEnd: new Date('2026-11-01')}}
    }}
  }, include: {chunks: true}})
  const pendingSource = await createLegacySource('PROCESSING', 'VALIDATED')
  const rejectedSource = await createLegacySource('COMPLETED', 'REJECTED')

  const readings = context.targets.flatMap(target => campaign.indexDates.map((readingDate, index) => ({targetId: target.id, compteurId: target.meters[0].compteurId, readingDate, value: ['0', '100', '300'][index]})))
  const draft = await saveCampaignResponse(owner, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: 0, data: {readings}})
  const transmitted = await submitCampaignResponse(owner, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: draft.response.version, idempotencyKey: randomUUID()})
  const {totals} = transmitted.response.latestSubmission.publication
  t.deepEqual(totals.map(total => total.value).sort(), ['100', '100', '200', '200'])
  t.true(totals.every(total => total.status === 'COMPLETE'))
  t.is(totals.find(total => total.value === '100').periodEnd, '2026-06-01T00:00:00.000Z')
  const activeVolumeWhere = {chunk: {pointPrelevementId: {in: points.map(point => point.id)}, instructionStatus: {not: 'REJECTED'}, source: {status: 'COMPLETED'}}, metricTypeCode: 'volume'}
  const volumeCount = await prisma.chunkValue.count({where: activeVolumeWhere})
  t.is(volumeCount, 4)
  await reconstructVolumesFromIndexForPoint(points[0].id)
  t.is(await prisma.chunkValue.count({where: activeVolumeWhere}), volumeCount)

  const campaignChunk = await prisma.chunk.findFirst({where: {pointPrelevementId: points[0].id, calculationStrategy: 'CAMPAIGN'}})
  const admin = await prisma.user.create({data: {role: 'ADMIN'}})
  let instructionError
  const instructionResponse = {
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    }
  }
  await updateChunkInstructionHandler({user: admin, params: {chunkId: campaignChunk.id}, body: {instructionStatus: 'REJECTED'}}, instructionResponse, error => {
    instructionError = error
  })
  t.is(instructionError?.status ?? instructionResponse.statusCode, 409)
  await t.throwsAsync(() => createLegacySource('COMPLETED', 'VALIDATED'))
  t.is(await prisma.chunkValue.count({where: {chunk: {sourceId: pendingSource.id}}}), 0)
  await t.notThrowsAsync(() => prisma.source.update({where: {id: pendingSource.id}, data: {status: 'COMPLETED'}}))
  await t.throwsAsync(() => prisma.chunk.update({where: {id: rejectedSource.chunks[0].id}, data: {instructionStatus: 'VALIDATED'}}))
  await t.notThrowsAsync(() => prisma.source.update({where: {id: pendingSource.id}, data: {metadata: {diagnostic: 'metadata remains writable'}}}))

  const indexCount = await prisma.chunkValue.count({where: {chunk: {pointPrelevementId: {in: points.map(point => point.id)}}, metricTypeCode: 'index'}})
  const revisedIndexDraft = await saveCampaignResponse(owner, campaign.id, 'INDEX', {
    preleveurUserId: farmer.id, expectedVersion: transmitted.response.version,
    data: {...transmitted.response.draft, comment: 'Commentaire corrigé, index inchangés'}
  })
  await submitCampaignResponse(owner, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: revisedIndexDraft.response.version, idempotencyKey: randomUUID()})
  t.is(await prisma.chunkValue.count({where: {chunk: {pointPrelevementId: {in: points.map(point => point.id)}}, metricTypeCode: 'index'}}), indexCount)
  t.is(await prisma.chunkValue.count({where: activeVolumeWhere}), volumeCount)

  let uploadedBuffer
  const storageFactory = () => ({
    async uploadObject(_key, buffer) {
      uploadedBuffer = buffer
    },
    async getPresignedUrl(_key, options) {
      t.is(options.expiresIn, 300)
      return 'https://example.test/private-export'
    }
  })
  const exported = await createCampaignExport(owner, campaign.id)
  t.deepEqual(await processCampaignExport(exported.id, {storageFactory}), {completed: true})
  t.true(uploadedBuffer.byteLength > 100)
  const download = await getCampaignExport(owner, campaign.id, exported.id, {storageFactory})
  t.is(download.downloadUrl, 'https://example.test/private-export')
  await rejectsWithStatus(t, () => getCampaignExport(partial, campaign.id, exported.id, {storageFactory}), 404)
  const receipt = await prisma.campaignNotification.findFirst({where: {submissionId: transmitted.response.latestSubmission.id}})
  t.deepEqual(await processCampaignNotification(receipt.id, {frontUrl: 'https://example.test', async mailer(to) {
    t.is(to, farmer.email)
  }}), {sent: true});
  ({campaign} = await changeCampaignStatus(owner, campaign.id, 'CLOSED', {expectedVersion: campaign.version}))
  await rejectsWithStatus(t, () => saveCampaignResponse(owner, campaign.id, 'NEEDS', {preleveurUserId: farmer.id, expectedVersion: corrected.response.version, data: {needs}}), 409)
  const reopened = await reopenCampaignResponse(owner, campaign.id, 'NEEDS', {preleveurUserId: farmer.id, expectedVersion: corrected.response.version, reason: 'Correction documentée du besoin'})
  const closedContext = await getCampaignContext(owner, campaign.id, farmer.id)
  t.is(closedContext.campaign.status, 'CLOSED')
  const lastDraft = await saveCampaignResponse(owner, campaign.id, 'NEEDS', {preleveurUserId: farmer.id, expectedVersion: reopened.response.version, data: {needs}})
  await submitCampaignResponse(owner, campaign.id, 'NEEDS', {preleveurUserId: farmer.id, expectedVersion: lastDraft.response.version, idempotencyKey: randomUUID()})
  t.is(await prisma.campaignSubmission.count({where: {responseId: first.response.id}}), 3)
  await prisma.declarantCollecteurExploitation.deleteMany({where: {collecteurUserId: owner.id, exploitationId: exploitations[1].id}})
  await rejectsWithStatus(t, () => getCampaignExport(owner, campaign.id, exported.id, {storageFactory}), 403)
})
