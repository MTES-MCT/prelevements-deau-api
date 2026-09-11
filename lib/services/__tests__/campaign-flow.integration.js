import process from 'node:process'
import {randomUUID} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import {runInNewContext} from 'node:vm'
import test from 'ava'
import ExcelJS from 'exceljs'
import express from 'express'
import {prisma} from '../../../db/prisma.js'
import {updateChunkInstructionHandler} from '../../handlers/chunks.js'
import * as campaignHandlers from '../../handlers/campaigns.js'
import * as deliveryHandlers from '../../handlers/campaign-delivery.js'
import {handleToken, ensureAuthenticated} from '../../auth/middleware.js'
import {createSessionToken} from '../../models/session-token.js'
import errorHandler from '../../util/error-handler.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {changeCampaignStatus, createCampaign, getCampaignContext, getCampaignDetail, getCampaignOptions, updateCampaignManagers, manageCampaignMeter, reopenCampaignResponse, saveCampaignResponse, submitCampaignResponse} from '../campaigns.js'
import {createCampaignExport, getCampaignExport, processCampaignExport, processCampaignNotification, scheduleCampaignReminders} from '../campaign-delivery.js'
import {reconstructVolumesFromIndexForPoint} from '../volumes-from-index.js'

const enabled = process.env.CAMPAIGN_INTEGRATION_TESTS === '1'
if (enabled) {
  requireDisposableDatabase()
}

const integration = enabled ? test.serial : test.skip
const frontHttpIntegration = enabled && process.env.CAMPAIGN_FRONT_ACTIONS_FILE ? test.serial : test.skip
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

function exportCell(sheet, header, row = 2) {
  const column = sheet.getRow(1).values.indexOf(header)
  if (column < 1) {
    throw new Error(`Colonne d’export absente : ${header}`)
  }

  return sheet.getCell(row, column)
}

async function meterResponseFixture({registered = true} = {}) {
  const data = await fixture()
  let {campaign} = await createCampaign(data.owner, {
    name: `Remplacement ${data.suffix}`, year: 2026, ownerCollecteurUserId: data.owner.id, zoneId: data.zoneId,
    opensAt: new Date(Date.now() - 60_000).toISOString(), closesAt: new Date(Date.now() + (30 * 86_400_000)).toISOString(),
    indexDates: ['2026-01-01', '2026-07-01'],
    periods: [
      {kind: 'INDEX', position: 0, label: 'Premier semestre', startDate: '2026-01-01', endDate: '2026-07-01', startReadingDate: '2026-01-01', endReadingDate: '2026-07-01'},
      {kind: 'NEEDS', position: 0, label: 'Besoins', startDate: '2027-01-01', endDate: '2028-01-01'}
    ], targets: [{exploitationId: data.exploitations[0].id, eligibilityConfirmed: true}]
  })
  if (registered) {
    ({campaign} = await manageCampaignMeter(data.owner, campaign.id, campaign.targets[0].id, undefined, {expectedVersion: campaign.version, identifier: `old-${data.suffix}`, startDate: '2020-01-01'}))
  }

  ({campaign} = await changeCampaignStatus(data.owner, campaign.id, 'OPEN', {expectedVersion: campaign.version}))
  const target = campaign.targets[0]
  const event = {targetId: target.id, type: 'REPLACEMENT', at: '2026-02-01', previousCompteurId: target.meters[0]?.compteurId ?? null,
    nextMeter: {serialNumber: `new-${data.suffix}`}, previousIndex: '200', nextIndex: '0', reason: 'Ancien compteur défectueux'}
  const readings = [{targetId: target.id, compteurId: target.meters[0]?.compteurId ?? null, readingDate: '2026-01-01', value: '100'}]
  return {...data, campaign, target, event, readings}
}

integration('une campagne suivante ne demande plus les index du compteur remplacé dans une réponse transmise', async t => {
  const {owner, farmer, campaign, target, event, readings, zoneId, exploitations, suffix} = await meterResponseFixture()
  const save = (expectedVersion, data) => saveCampaignResponse(farmer, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion, data})
  const first = await save(0, {readings, meterEvents: [event]})
  const nextId = first.targets[0].meters.find(meter => meter.pending).compteurId
  const complete = await save(first.response.version, {...first.response.draft, readings: [...readings, {targetId: target.id, compteurId: nextId, readingDate: '2026-07-01', value: '50'}]})
  const transmitted = await submitCampaignResponse(farmer, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: complete.response.version, idempotencyKey: randomUUID()})
  // Un brouillon de correction ne doit pas effacer le dernier historique transmis.
  await save(transmitted.response.version, {...transmitted.response.draft, comment: 'Précision en cours'})
  let {campaign: following} = await createCampaign(owner, {
    name: `Suite ${suffix}`, year: 2026, ownerCollecteurUserId: owner.id, zoneId,
    opensAt: new Date(Date.now() - 60_000).toISOString(), closesAt: new Date(Date.now() + (30 * 86_400_000)).toISOString(),
    indexDates: ['2026-08-01', '2026-09-01'],
    periods: [
      {kind: 'INDEX', position: 0, label: 'Été', startDate: '2026-08-01', endDate: '2026-09-01', startReadingDate: '2026-08-01', endReadingDate: '2026-09-01'},
      {kind: 'NEEDS', position: 0, label: 'Besoins', startDate: '2027-01-01', endDate: '2028-01-01'}
    ], targets: [{exploitationId: exploitations[0].id, eligibilityConfirmed: true}]
  })
  const oldInPreview = following.targets[0].meters.find(meter => meter.compteurId === event.previousCompteurId)
  t.is(oldInPreview.endDate, event.at)
  const opened = await changeCampaignStatus(owner, following.id, 'OPEN', {expectedVersion: following.version})
  following = opened.campaign
  t.deepEqual(following.targets[0].meters.map(meter => meter.compteurId), [nextId])
  const subsequent = await saveCampaignResponse(farmer, following.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: 0, data: {meterEvents: [], readings: [
    {targetId: following.targets[0].id, compteurId: nextId, readingDate: '2026-08-01', value: '60'},
    {targetId: following.targets[0].id, compteurId: nextId, readingDate: '2026-09-01', value: '80'}
  ]}})
  t.true(subsequent.calculation.canSubmit)
  t.is(subsequent.calculation.totals[0].value, '20')
  const original = await getCampaignContext(farmer, campaign.id, farmer.id)
  t.is(original.calculation.totals[0].value, '150')
  const oldBinding = await prisma.compteurPointPrelevement.findUnique({where: {id: target.meters[0].associationId}})
  t.is(oldBinding.endDate, null)
})

integration('éditer un remplacement conserve la chaîne et les relevés, accepte le snapshot en attente et refuse les déplacements ambigus', async t => {
  const {farmer, campaign, target, event, readings, suffix} = await meterResponseFixture({registered: false})
  const meterCount = await prisma.compteur.count()
  const associationCount = await prisma.compteurPointPrelevement.count()
  const save = (expectedVersion, data) => saveCampaignResponse(farmer, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion, data})
  const first = await save(0, {readings, meterEvents: [event]})
  const firstId = first.targets[0].meters.find(meter => meter.pending).compteurId
  const secondEvent = {...event, at: '2026-05-01', previousCompteurId: firstId, previousIndex: '100', nextMeter: {serialNumber: `Second compteur ${suffix}`}}
  const chain = await save(first.response.version, {readings, meterEvents: [event, secondEvent]})
  const secondId = chain.targets[0].meters.find(meter => meter.pending && meter.compteurId !== firstId).compteurId
  const lastReading = {targetId: target.id, compteurId: secondId, readingDate: '2026-07-01', value: '50'}
  const complete = await save(chain.response.version, {...chain.response.draft, readings: [...readings, lastReading]})
  t.true(complete.calculation.canSubmit)
  t.is(complete.calculation.totals[0].value, '250')

  const editedEvent = {...event, at: '2026-03-01', nextMeter: {serialNumber: `Premier compteur corrigé ${suffix}`}, previousIndex: '220', reason: 'Motif précisé',
    previousEvent: {at: event.at, previousCompteurId: null, nextMeter: event.nextMeter}}
  const incoming = {...complete.response.draft, meterEvents: [editedEvent, secondEvent]}
  const edited = await save(complete.response.version, incoming)
  t.true(edited.calculation.canSubmit)
  t.is(edited.calculation.totals[0].value, '270')
  t.is(edited.response.draft.meterEvents[0].reason, 'Motif précisé')
  t.false(Object.hasOwn(edited.response.draft.meterEvents[0], 'previousEvent'))
  const newFirstId = edited.response.draft.meterEvents[1].previousCompteurId
  const newSecondId = edited.response.draft.readings[1].compteurId
  t.not(newFirstId, firstId)
  t.not(newSecondId, secondId)
  t.deepEqual(edited.response.draft.readings.map(reading => reading.value), ['100', '50'])
  t.is(await prisma.compteur.count(), meterCount)
  t.is(await prisma.compteurPointPrelevement.count(), associationCount)

  const queued = {...incoming, readings: [...readings, {...lastReading, value: '60'}]}
  const replayed = await save(edited.response.version, queued)
  t.is(replayed.response.draft.readings[1].compteurId, newSecondId)
  t.is(replayed.response.draft.readings[1].value, '60')
  t.is(replayed.calculation.totals[0].value, '280')
  await rejectsWithStatus(t, () => save(complete.response.version, queued), 409)
  await rejectsWithStatus(t, () => save(replayed.response.version, {...queued, meterEvents: [{...editedEvent, nextMeter: {serialNumber: 'Édition obsolète'}}, secondEvent]}), 409)

  const savedSecond = replayed.response.draft.meterEvents[1]
  const crossing = {...replayed.response.draft, meterEvents: [replayed.response.draft.meterEvents[0], {
    ...savedSecond, at: '2026-07-01', previousEvent: {at: savedSecond.at, previousCompteurId: savedSecond.previousCompteurId, nextMeter: savedSecond.nextMeter}
  }]}
  const error = await t.throwsAsync(() => save(replayed.response.version, crossing))
  t.is(error.statusCode, 400)
  t.regex(error.message, /relevés déjà saisis/)
  const restored = await getCampaignContext(farmer, campaign.id, farmer.id)
  t.is(restored.responses.INDEX.version, replayed.response.version)
  t.deepEqual(restored.responses.INDEX.draft, replayed.response.draft)
  t.is(await prisma.compteur.count(), meterCount)

  const submitted = await submitCampaignResponse(farmer, campaign.id, 'INDEX', {
    preleveurUserId: farmer.id, expectedVersion: replayed.response.version, idempotencyKey: randomUUID()
  })
  t.is(submitted.response.latestSubmission.publication.totals[0].value, '280')
  t.is(await prisma.compteur.count(), meterCount + 2)
  t.is(await prisma.compteurPointPrelevement.count(), associationCount + 2)
  t.false(submitted.response.latestSubmission.snapshot.meterEvents.some(item => Object.hasOwn(item, 'previousEvent')))
})

integration('ancien compteur non référencé : brouillon, restauration, retrait, rollback et transmission sans faux compteur', async t => {
  const {farmer, campaign, target, event, readings} = await meterResponseFixture({registered: false})
  const meterCount = await prisma.compteur.count()
  const associationCount = await prisma.compteurPointPrelevement.count()
  const save = (expectedVersion, data) => saveCampaignResponse(farmer, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion, data})
  const initial = await save(0, {readings, meterEvents: [event]})
  const pending = initial.targets[0].meters.find(meter => meter.pending)
  t.truthy(pending)
  t.true(initial.targets[0].meterlessInitial)
  t.is(initial.targets[0].meterlessEndDate, null)
  t.is(initial.response.draft.readings[0].compteurId, null)
  t.is(await prisma.compteur.count(), meterCount)
  t.is(await prisma.compteurPointPrelevement.count(), associationCount)

  const restored = await getCampaignContext(farmer, campaign.id, farmer.id)
  t.true(restored.targets[0].meterlessInitial)
  t.is(restored.targets[0].meters[0].compteurId, pending.compteurId)
  const removed = await save(initial.response.version, {readings, meterEvents: []})
  t.is(removed.targets[0].meters.length, 0)
  t.is(await prisma.compteur.count(), meterCount)
  const saved = await save(removed.response.version, {readings, meterEvents: [event]})

  await rejectsWithStatus(t, () => submitCampaignResponse(farmer, campaign.id, 'INDEX', {
    preleveurUserId: farmer.id, expectedVersion: saved.response.version, idempotencyKey: randomUUID()
  }), 409)
  t.is(await prisma.compteur.count(), meterCount)
  t.is(await prisma.compteurPointPrelevement.count(), associationCount)
  t.is(await prisma.campaignSubmission.count({where: {responseId: saved.response.id}}), 0)

  const complete = await save(saved.response.version, {
    ...saved.response.draft,
    readings: [...readings, {targetId: target.id, compteurId: pending.compteurId, readingDate: '2026-07-01', value: '50'}]
  })
  t.true(complete.calculation.canSubmit)
  t.is(complete.calculation.totals[0].value, '150')
  const request = {preleveurUserId: farmer.id, expectedVersion: complete.response.version, idempotencyKey: randomUUID()}
  const transmitted = await submitCampaignResponse(farmer, campaign.id, 'INDEX', request)
  await submitCampaignResponse(farmer, campaign.id, 'INDEX', request)
  t.is(await prisma.compteur.count(), meterCount + 1)
  t.is(await prisma.compteurPointPrelevement.count(), associationCount + 1)
  t.is(await prisma.campaignSubmission.count({where: {responseId: complete.response.id}}), 1)
  t.is(transmitted.response.latestSubmission.publication.totals[0].value, '150')
  t.is(transmitted.response.draft.meterEvents[0].previousCompteurId, null)
  t.true(transmitted.targets[0].meterlessInitial)
  t.is(transmitted.targets[0].meterlessEndDate, event.at)
  t.is(transmitted.targets[0].meters.length, 1)
  const reloaded = await getCampaignContext(farmer, campaign.id, farmer.id)
  t.true(reloaded.calculation.canSubmit)
  t.is(reloaded.calculation.totals[0].value, '150')
  const indexCount = await prisma.chunkValue.count({where: {metricTypeCode: 'index', chunk: {pointPrelevementId: target.pointPrelevementId}}})
  const corrected = await save(transmitted.response.version, {...transmitted.response.draft, comment: 'Précision du commentaire'})
  const retransmitted = await submitCampaignResponse(farmer, campaign.id, 'INDEX', {
    preleveurUserId: farmer.id, expectedVersion: corrected.response.version, idempotencyKey: randomUUID()
  })
  t.is(retransmitted.response.latestSubmission.publication.totals[0].value, '150')
  t.is(await prisma.compteur.count(), meterCount + 1)
  t.is(await prisma.chunkValue.count({where: {metricTypeCode: 'index', chunk: {pointPrelevementId: target.pointPrelevementId}}}), indexCount)
})

integration('remise à zéro non référencée : transmission réelle sans créer de compteur ni d’affectation', async t => {
  const {farmer, campaign, target, event: replacement, readings} = await meterResponseFixture({registered: false})
  const {nextMeter: _nextMeter, ...event} = replacement
  const meterCount = await prisma.compteur.count()
  const associationCount = await prisma.compteurPointPrelevement.count()
  const saved = await saveCampaignResponse(farmer, campaign.id, 'INDEX', {
    preleveurUserId: farmer.id, expectedVersion: 0,
    data: {
      readings: [...readings, {targetId: target.id, compteurId: null, readingDate: '2026-07-01', value: '50'}],
      meterEvents: [{...event, type: 'RESET', nextCompteurId: null, reason: 'Remise à zéro pendant la maintenance'}]
    }
  })
  t.true(saved.calculation.canSubmit)
  t.is(saved.calculation.totals[0].value, '150')
  const result = await submitCampaignResponse(farmer, campaign.id, 'INDEX', {
    preleveurUserId: farmer.id, expectedVersion: saved.response.version, idempotencyKey: randomUUID()
  })
  t.is(result.response.latestSubmission.publication.totals[0].value, '150')
  t.is(result.response.latestSubmission.snapshot.meterEvents[0].previousCompteurId, null)
  t.is(result.response.latestSubmission.snapshot.meterEvents[0].nextCompteurId, null)
  t.is(await prisma.compteur.count(), meterCount)
  t.is(await prisma.compteurPointPrelevement.count(), associationCount)
})

integration('un compteur déjà référencé ne peut pas être contourné avec un événement anonyme', async t => {
  const {farmer, campaign, event, readings} = await meterResponseFixture()
  const meterCount = await prisma.compteur.count()
  await rejectsWithStatus(t, () => saveCampaignResponse(farmer, campaign.id, 'INDEX', {
    preleveurUserId: farmer.id, expectedVersion: 0, data: {readings, meterEvents: [{...event, previousCompteurId: null}]}
  }), 403)
  t.is(await prisma.compteur.count(), meterCount)
  t.is(await prisma.campaignResponse.count({where: {campaignId: campaign.id}}), 0)
})

integration('relevés déjà saisis : rattachement confirmé au nouveau compteur, valeurs conservées et annulation possible', async t => {
  const {farmer, campaign, target, event, readings} = await meterResponseFixture({registered: false})
  const meterCount = await prisma.compteur.count()
  const save = (expectedVersion, data) => saveCampaignResponse(farmer, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion, data})
  const prefilled = {
    readings: [...readings, {targetId: target.id, compteurId: null, readingDate: '2026-07-01', value: '50.0123'}], meterEvents: []
  }
  const initial = await save(0, prefilled)
  await rejectsWithStatus(t, () => save(initial.response.version, {...prefilled, meterEvents: [event]}), 400)
  const unchanged = await getCampaignContext(farmer, campaign.id, farmer.id)
  t.deepEqual(unchanged.responses.INDEX.draft, initial.response.draft)
  const confirmed = {...event, reassignFollowingReadings: true}
  const moved = await save(initial.response.version, {...prefilled, meterEvents: [confirmed]})
  const pending = moved.targets[0].meters.find(meter => meter.pending)
  t.is(moved.response.draft.readings[0].compteurId, null)
  t.is(moved.response.draft.readings[1].compteurId, pending.compteurId)
  t.is(moved.response.draft.readings[1].value, '50.0123')
  t.deepEqual(moved.response.draft.meterEvents[0].nextMeter, event.nextMeter)
  t.true(moved.calculation.canSubmit)
  t.is(moved.calculation.totals[0].value, '150.0123')
  t.is(await prisma.compteur.count(), meterCount)
  const reloaded = await getCampaignContext(farmer, campaign.id, farmer.id)
  t.is(reloaded.responses.INDEX.draft.readings[1].compteurId, pending.compteurId)
  const cancelled = await save(moved.response.version, {
    readings: moved.response.draft.readings.map(reading => ({...reading, compteurId: null})), meterEvents: []
  })
  t.is(cancelled.targets[0].meters.length, 0)
  t.is(cancelled.response.draft.readings[1].value, '50.0123')
  t.is(await prisma.compteur.count(), meterCount)
  const restored = await save(cancelled.response.version, {...cancelled.response.draft, meterEvents: [confirmed]})
  const submitted = await submitCampaignResponse(farmer, campaign.id, 'INDEX', {
    preleveurUserId: farmer.id, expectedVersion: restored.response.version, idempotencyKey: randomUUID()
  })
  t.is(submitted.response.latestSubmission.publication.totals[0].value, '150.0123')
  t.is(await prisma.compteur.count(), meterCount + 1)
})

integration('remplacement déclarant : brouillon réversible, création atomique à transmission, rollback et rejeu sans doublon', async t => {
  const {farmer, owner, campaign, target, event, readings, points} = await meterResponseFixture()
  const meterCount = await prisma.compteur.count()
  const associationCount = await prisma.compteurPointPrelevement.count()
  const initial = await saveCampaignResponse(farmer, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: 0, data: {comment: 'Commentaire conservé', readings, meterEvents: [event]}})
  const pending = initial.targets[0].meters.find(meter => meter.pending)
  t.truthy(pending)
  t.deepEqual(initial.response.draft.meterEvents[0].nextMeter, event.nextMeter)
  t.is(await prisma.compteur.count(), meterCount)
  t.is(await prisma.compteurPointPrelevement.count(), associationCount)
  const restored = await getCampaignContext(farmer, campaign.id, farmer.id)
  t.is(restored.targets[0].meters.find(meter => meter.pending).compteurId, pending.compteurId)
  const removed = await saveCampaignResponse(farmer, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: initial.response.version, data: {readings, meterEvents: []}})
  t.is(removed.targets[0].meters.length, 1)
  t.is(await prisma.compteur.count(), meterCount)
  const saved = await saveCampaignResponse(farmer, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: removed.response.version, data: {comment: 'Commentaire conservé', readings, meterEvents: [event]}})
  await rejectsWithStatus(t, () => submitCampaignResponse(farmer, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: saved.response.version, idempotencyKey: randomUUID()}), 409)
  // Le calcul incomplet échoue après préparation : la transaction annule aussi
  // la fiche compteur, son affectation et la soumission en préparation.
  t.is(await prisma.compteur.count(), meterCount)
  t.is(await prisma.compteurPointPrelevement.count(), associationCount)
  t.is(await prisma.campaignSubmission.count({where: {responseId: saved.response.id}}), 0)
  const completeData = {...saved.response.draft, readings: [...readings, {targetId: target.id, compteurId: pending.compteurId, readingDate: '2026-07-01', value: '50'}]}
  const complete = await saveCampaignResponse(farmer, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: saved.response.version, data: completeData})
  t.true(complete.calculation.canSubmit)
  await rejectsWithStatus(t, () => saveCampaignResponse(farmer, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: saved.response.version, data: completeData}), 409)
  const request = {preleveurUserId: farmer.id, expectedVersion: complete.response.version, idempotencyKey: randomUUID()}
  const transmitted = await submitCampaignResponse(farmer, campaign.id, 'INDEX', request)
  await submitCampaignResponse(farmer, campaign.id, 'INDEX', request)
  t.is(await prisma.compteur.count(), meterCount + 1)
  t.is(await prisma.compteurPointPrelevement.count(), associationCount + 1)
  t.is(await prisma.campaignSubmission.count({where: {responseId: transmitted.response.id}}), 1)
  t.is(transmitted.response.draft.meterEvents[0].nextCompteurId, pending.compteurId)
  t.false(Object.hasOwn(transmitted.response.draft.meterEvents[0], 'nextMeter'))
  t.false(transmitted.targets[0].meters.some(meter => meter.pending))
  t.is(transmitted.response.latestSubmission.publication.totals[0].value, '150')
  t.is(transmitted.response.draft.comment, 'Commentaire conservé')
  const newAssociation = await prisma.compteurPointPrelevement.findFirst({where: {compteurId: pending.compteurId}})
  t.is(newAssociation.pointPrelevementId, points[0].id)
  t.is(newAssociation.startDate.toISOString(), '2026-02-01T00:00:00.000Z')
  const oldAssociation = await prisma.compteurPointPrelevement.findFirst({where: {compteurId: event.previousCompteurId}})
  t.is(oldAssociation.endDate, null)
  const {snapshot} = transmitted.response.latestSubmission
  await saveCampaignResponse(owner, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: transmitted.response.version, data: {...transmitted.response.draft, comment: 'Correction du commentaire'}})
  const historic = await prisma.campaignSubmission.findUnique({where: {id: transmitted.response.latestSubmission.id}})
  t.deepEqual(historic.snapshot, snapshot)
  t.is(await prisma.compteur.count(), meterCount + 1)
})

integration('remplacement déclarant : identifiant externe refusé sans fuite ni rattachement, droits et coordonnées strictement bornés', async t => {
  const {farmer, campaign, target, event, readings, points} = await meterResponseFixture()
  const external = await prisma.compteur.create({data: {serialNumber: event.nextMeter.serialNumber, points: {create: {pointPrelevementId: points[1].id}}}})
  const count = await prisma.compteur.count()
  const outsider = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
  const admin = await prisma.user.create({data: {role: 'ADMIN'}})
  for (const user of [outsider, admin]) {
    // eslint-disable-next-line no-await-in-loop
    await rejectsWithStatus(t, () => saveCampaignResponse(user, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: 0, data: {readings, meterEvents: [event]}}), 403)
  }

  await prisma.$executeRaw`UPDATE "PointPrelevement" SET coordinates = ST_SetSRID(ST_MakePoint(2, 46), 4326) WHERE id = ${points[0].id}::uuid`
  await prisma.$executeRaw`UPDATE "PointPrelevement" SET coordinates = ST_SetSRID(ST_MakePoint(8, 48), 4326) WHERE id = ${points[1].id}::uuid`
  const initial = await saveCampaignResponse(farmer, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: 0, data: {readings, meterEvents: [event]}})
  t.deepEqual(initial.targets.map(item => item.pointPrelevement.coordinates), [{type: 'Point', coordinates: [2, 46]}])
  const pending = initial.targets[0].meters.find(meter => meter.pending)
  const saved = await saveCampaignResponse(farmer, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: initial.response.version, data: {...initial.response.draft, readings: [...readings, {targetId: target.id, compteurId: pending.compteurId, readingDate: '2026-07-01', value: '50'}]}})
  const error = await t.throwsAsync(() => submitCampaignResponse(farmer, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: saved.response.version, idempotencyKey: randomUUID()}))
  t.is(error.statusCode, 409)
  t.false(error.message.includes(external.id))
  t.false(error.message.includes(points[1].id))
  t.is(await prisma.compteur.count(), count)
  t.is(await prisma.compteurPointPrelevement.count({where: {compteurId: external.id, pointPrelevementId: points[0].id}}), 0)
  t.is(await prisma.campaignSubmission.count({where: {responseId: saved.response.id}}), 0)
  const unchanged = await prisma.campaignResponse.findUnique({where: {id: saved.response.id}})
  t.is(unchanged.version, saved.response.version)
})

integration('remplacement déclarant : réutiliser un compteur du même point normalise les relevés sans doublonner les affectations', async t => {
  const {farmer, campaign, target, event, readings, points} = await meterResponseFixture()
  const existing = await prisma.compteur.create({data: {
    serialNumber: event.nextMeter.serialNumber,
    points: {create: {pointPrelevementId: points[0].id, startDate: new Date(`${event.at}T00:00:00.000Z`)}}
  }})
  const count = await prisma.compteur.count()
  const initial = await saveCampaignResponse(farmer, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: 0, data: {readings, meterEvents: [event]}})
  const pending = initial.targets[0].meters.find(meter => meter.pending)
  const saved = await saveCampaignResponse(farmer, campaign.id, 'INDEX', {
    preleveurUserId: farmer.id, expectedVersion: initial.response.version,
    data: {...initial.response.draft, readings: [...readings, {targetId: target.id, compteurId: pending.compteurId, readingDate: '2026-07-01', value: '50'}]}
  })
  const transmitted = await submitCampaignResponse(farmer, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: saved.response.version, idempotencyKey: randomUUID()})
  t.is(await prisma.compteur.count(), count)
  t.is(await prisma.compteurPointPrelevement.count({where: {compteurId: existing.id}}), 1)
  t.is(transmitted.response.draft.meterEvents[0].nextCompteurId, existing.id)
  t.true(transmitted.response.draft.readings.some(reading => reading.compteurId === existing.id && reading.value === '50'))
  t.false(transmitted.response.draft.readings.some(reading => reading.compteurId === pending.compteurId))
  t.is(transmitted.response.latestSubmission.publication.totals[0].value, '150')
})

integration('territoires proposés : zones occupées uniquement, comptes actifs et droits de chaque rôle', async t => {
  const active = await fixture()
  const unknownStatus = await fixture()
  await prisma.declarantPointPrelevement.updateMany({where: {id: {in: unknownStatus.exploitations.map(item => item.id)}}, data: {status: 'NON_RENSEIGNE'}})
  const excluded = await Promise.all(['TERMINEE', 'ABANDONNEE', 'POINT_DELETED', 'FARMER_DELETED', 'COLLECTORS_DELETED', 'NO_COLLECTOR'].map(async reason => {
    const data = await fixture()
    switch (reason) {
      case 'TERMINEE':
      case 'ABANDONNEE': {
        await prisma.declarantPointPrelevement.updateMany({where: {id: {in: data.exploitations.map(item => item.id)}}, data: {status: reason}})
        break
      }

      case 'POINT_DELETED': {
        await prisma.pointPrelevement.updateMany({where: {id: {in: data.points.map(item => item.id)}}, data: {deletedAt: new Date()}})
        break
      }

      case 'FARMER_DELETED': {
        await prisma.user.update({where: {id: data.farmer.id}, data: {deletedAt: new Date()}})
        break
      }

      case 'COLLECTORS_DELETED': {
        await prisma.user.updateMany({where: {id: {in: [data.owner.id, data.partial.id]}}, data: {deletedAt: new Date()}})
        break
      }

      default: {
        await prisma.declarantCollecteurExploitation.deleteMany({where: {exploitationId: {in: data.exploitations.map(item => item.id)}}})
      }
    }

    return data
  }))
  const emptyZoneId = randomUUID()
  await prisma.$executeRaw`
    INSERT INTO "Zone" ("id", "code", "type", "name", "coordinates", "updatedAt")
    VALUES (${emptyZoneId}::uuid, ${emptyZoneId}, 'SAGE', 'Zone vide', ST_GeomFromText('MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)))',4326), NOW())
  `
  const admin = await prisma.user.create({data: {role: 'ADMIN'}})
  const instructor = await prisma.user.create({data: {role: 'INSTRUCTOR', instructor: {create: {instructorZones: {create: [active.zoneId, emptyZoneId].map(zoneId => ({
    zoneId, startDate: new Date('2020-01-01'), permissions: {create: {permission: 'campaign.manage'}}
  }))}}}}})
  const adminOptions = await getCampaignOptions(admin, {zoneId: active.zoneId})
  t.true(adminOptions.zones.some(zone => zone.id === active.zoneId))
  t.true(adminOptions.zones.some(zone => zone.id === unknownStatus.zoneId))
  const hiddenZones = new Set([emptyZoneId, ...excluded.map(item => item.zoneId)])
  t.false(adminOptions.zones.some(zone => hiddenZones.has(zone.id)))
  const collectorOptions = await getCampaignOptions(active.owner)
  t.deepEqual(collectorOptions.zones.map(zone => zone.id), [active.zoneId])
  t.deepEqual(collectorOptions.collecteurs.map(collecteur => collecteur.userId), [active.owner.id])
  const instructorOptions = await getCampaignOptions(instructor)
  t.deepEqual(instructorOptions.zones.map(zone => zone.id), [active.zoneId])
  await rejectsWithStatus(t, () => getCampaignOptions(instructor, {zoneId: unknownStatus.zoneId}), 403)
  await rejectsWithStatus(t, () => getCampaignOptions(active.owner, {zoneId: unknownStatus.zoneId}), 403)
  await rejectsWithStatus(t, () => getCampaignOptions(admin, {zoneId: emptyZoneId}), 403)
  await prisma.instructorZonePermission.deleteMany({where: {instructorZone: {instructorUserId: instructor.id}}})
  await rejectsWithStatus(t, () => getCampaignOptions(instructor), 403)
})

integration('sans mode ni inventaire : saisie, publication et export sans confirmation ni faux compteur', async t => {
  const {owner, farmer, zoneId, points, exploitations, suffix} = await fixture({firstPointCollectionMode: null})
  const meterCount = await prisma.compteur.count()
  let {campaign} = await createCampaign(owner, {
    name: `Collecte ${suffix}`, year: 2026, ownerCollecteurUserId: owner.id, zoneId,
    opensAt: new Date(Date.now() - 60_000).toISOString(), closesAt: new Date(Math.max(Date.now() + (30 * 86_400_000), Date.parse('2026-11-30'))).toISOString(),
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
  const saved = await saveCampaignResponse(owner, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: 0, data: {readings}})
  t.true(saved.calculation.canSubmit)
  t.true(saved.response.draft.readings.every(reading => !Object.hasOwn(reading, 'meterConfirmed')))
  t.is(await prisma.chunk.count({where: {pointPrelevementId: points[0].id}}), 0)
  const submitRequest = {preleveurUserId: farmer.id, expectedVersion: saved.response.version, idempotencyKey: randomUUID()}
  await prisma.pointPrelevement.update({where: {id: points[0].id}, data: {collectionMode: 'EXTERNAL'}})
  await rejectsWithStatus(t, () => saveCampaignResponse(farmer, campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: saved.response.version, data: {readings}}), 403)
  await rejectsWithStatus(t, () => submitCampaignResponse(farmer, campaign.id, 'INDEX', submitRequest), 403)
  await prisma.pointPrelevement.update({where: {id: points[0].id}, data: {collectionMode: null}})
  const transmitted = await submitCampaignResponse(farmer, campaign.id, 'INDEX', submitRequest)
  await submitCampaignResponse(farmer, campaign.id, 'INDEX', submitRequest)
  t.is(await prisma.campaignSubmission.count({where: {responseId: transmitted.response.id}}), 1)
  t.deepEqual(transmitted.response.latestSubmission.publication.totals.map(total => total.value), ['100', '200'])
  t.true(transmitted.response.latestSubmission.snapshot.readings.every(reading => !Object.hasOwn(reading, 'meterConfirmed')))
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
  let latestNeeds = needsSubmission.response
  for (const requestedFlow of ['', '0']) {
    // eslint-disable-next-line no-await-in-loop
    const revised = await saveCampaignResponse(farmer, campaign.id, 'NEEDS', {
      preleveurUserId: farmer.id, expectedVersion: latestNeeds.version, data: {needs: needs.map(need => ({...need, requestedFlow}))}
    })
    // eslint-disable-next-line no-await-in-loop
    const submitted = await submitCampaignResponse(farmer, campaign.id, 'NEEDS', {
      preleveurUserId: farmer.id, expectedVersion: revised.response.version, idempotencyKey: randomUUID()
    })
    latestNeeds = submitted.response
    // eslint-disable-next-line no-await-in-loop
    const stored = await prisma.campaignNeedLine.findFirst({where: {submissionId: latestNeeds.latestSubmission.id}})
    t.is(stored.requestedFlow?.toString() ?? null, requestedFlow === '' ? null : '0')
    t.is(stored.requestedVolume.toString(), '1000')
  }

  const originalNeed = await prisma.campaignNeedLine.findFirst({where: {submissionId: needsSubmission.response.latestSubmission.id}})
  t.is(originalNeed.requestedFlow.toString(), '5')
  const columns = await prisma.$queryRaw`
    SELECT column_name, is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'CampaignNeedLine'
      AND column_name IN ('requestedFlow', 'requestedVolume')
  `
  t.deepEqual(Object.fromEntries(columns.map(column => [column.column_name, column.is_nullable])), {requestedFlow: 'YES', requestedVolume: 'NO'})
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
  const readingsSheet = workbook.getWorksheet('Relevés de compteurs')
  t.is(readingsSheet.rowCount, 4)
  t.is(exportCell(readingsSheet, 'Compteur').value, 'Non renseigné')
  t.falsy(exportCell(readingsSheet, 'Continuité du compteur confirmée').value)
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
    opensAt: new Date(Date.now() - 60_000).toISOString(), closesAt: new Date(Math.max(Date.now() + (30 * 86_400_000), Date.parse('2026-11-30'))).toISOString(),
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
  await rejectsWithStatus(t, () => reopenCampaignResponse(owner, campaign.id, 'NEEDS', {preleveurUserId: farmer.id, expectedVersion: corrected.response.version, reason: 'Ancienne commande'}), 410)
  // Fixture historique exclusivement dans la base jetable gardée en tête de
  // fichier : le retrait de la commande ne supprime pas les anciens délais.
  const reopened = await prisma.campaignResponse.update({where: {id: corrected.response.id}, data: {
    status: 'DRAFT', version: {increment: 1}, reopenedAt: new Date(), reopenedByUserId: owner.id,
    reopenUntil: new Date(Date.now() + (7 * 86_400_000)), reopenReason: 'Fenêtre historique conservée'
  }})
  const closedContext = await getCampaignContext(owner, campaign.id, farmer.id)
  t.is(closedContext.campaign.status, 'CLOSED')
  t.false(closedContext.responses.NEEDS.permissions.canReopen)
  const lastDraft = await saveCampaignResponse(owner, campaign.id, 'NEEDS', {preleveurUserId: farmer.id, expectedVersion: reopened.version, data: {needs}})
  await submitCampaignResponse(owner, campaign.id, 'NEEDS', {preleveurUserId: farmer.id, expectedVersion: lastDraft.response.version, idempotencyKey: randomUUID()})
  t.is(await prisma.campaignSubmission.count({where: {responseId: first.response.id}}), 3)
  await prisma.declarantCollecteurExploitation.deleteMany({where: {collecteurUserId: owner.id, exploitationId: exploitations[1].id}})
  await rejectsWithStatus(t, () => getCampaignExport(owner, campaign.id, exported.id, {storageFactory}), 403)
})

async function campaignHttpServer(t) {
  const app = express()
  app.use(express.json())
  app.use(handleToken, ensureAuthenticated)
  const routes = [
    ['get', '/campaigns', 'listCampaignsHandler'],
    ['post', '/campaigns', 'createCampaignHandler'],
    ['get', '/campaigns/options', 'getCampaignOptionsHandler'],
    ['get', '/campaigns/:campaignId', 'getCampaignHandler'],
    ['patch', '/campaigns/:campaignId', 'updateCampaignHandler'],
    ['patch', '/campaigns/:campaignId/managers', 'updateCampaignManagersHandler'],
    ['post', '/campaigns/:campaignId/open', 'openCampaignHandler'],
    ['post', '/campaigns/:campaignId/close', 'closeCampaignHandler'],
    ['get', '/campaigns/:campaignId/context', 'getCampaignContextHandler'],
    ['get', '/campaigns/:campaignId/responses', 'listCampaignResponsesHandler'],
    ['get', '/campaigns/:campaignId/responses/:kind/history', 'getCampaignResponseHistoryHandler'],
    ['patch', '/campaigns/:campaignId/responses/:kind', 'saveCampaignResponseHandler'],
    ['post', '/campaigns/:campaignId/responses/:kind/submit', 'submitCampaignResponseHandler'],
    ['post', '/campaigns/:campaignId/exports', 'createCampaignExportHandler'],
    ['get', '/campaigns/:campaignId/exports', 'listCampaignExportsHandler'],
    ['get', '/campaigns/:campaignId/exports/:exportId', 'getCampaignExportHandler'],
    ['get', '/campaigns/:campaignId/notifications', 'listCampaignNotificationsHandler'],
    ['post', '/campaigns/:campaignId/notifications/remind', 'remindCampaignHandler']
  ]
  const realRoutes = readFileSync(new URL('../../routes.js', import.meta.url), 'utf8')
  for (const [method, path, handler] of routes) {
    t.true(realRoutes.includes(`app.${method}('${path}', ensureAuthenticated, ${handler})`), `Route réelle ${method} ${path}`)
    app[method](`/api${path}`, campaignHandlers[handler] || deliveryHandlers[handler])
  }

  app.use(errorHandler)
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  t.teardown(() => new Promise(resolve => {
    server.close(resolve)
  }))
  return `http://127.0.0.1:${server.address().port}/`
}

// Exercise the actual front server-action paths and payloads. Only its NextAuth
// transport adapter is replaced, using real disposable DB-backed API sessions.
function campaignFrontActions(t, baseUrl, currentToken) {
  const source = readFileSync(process.env.CAMPAIGN_FRONT_ACTIONS_FILE, 'utf8')
  const dependency = 'import {fetchJSON, withErrorHandling} from \'@/server/api-wrapper.js\''
  t.true(source.includes(dependency))
  const names = [...source.matchAll(/export async function (\w+)/g)].map(([, name]) => name)
  const body = source.replace(dependency, '').replaceAll('export async function ', 'async function ')
  const compile = runInNewContext(`(function(fetchJSON, withErrorHandling) {${body}\nreturn {${names.join(',')}}})`, {URLSearchParams})
  const fetchJSON = async (path, {method = 'GET', body} = {}) => {
    const url = new URL(path, baseUrl)
    t.is(url.origin, new URL(baseUrl).origin)
    const token = currentToken()
    const response = await fetch(url, {
      method,
      headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})},
      ...(body ? {body: JSON.stringify(body)} : {})
    })
    const data = await response.json()
    if (!response.ok) {
      throw Object.assign(new Error(data.message), {code: response.status, data})
    }

    return data
  }

  return compile(fetchJSON, async (operation, options) => {
    t.false(options.forbiddenOnAccessDenied)
    t.false(options.redirectOnUnauthorized)
    try {
      return {success: true, data: await operation()}
    } catch (error) {
      return {success: false, code: error.code, error: error.message}
    }
  })
}

frontHttpIntegration('HTTP authentifié et actions front : configuration, droits, outbox, deux réponses, relances et export', async t => {
  const {owner, farmer, partial, zoneId, points, exploitations, suffix} = await fixture()
  await prisma.pointPrelevement.update({where: {id: points[1].id}, data: {collectionMode: 'MANUAL'}})
  const reader = await prisma.user.create({data: {email: `reader-${suffix}@example.test`, role: 'DECLARANT', declarant: {create: {declarantRole: 'COLLECTEUR'}}}})
  const tokens = new Map(await Promise.all([owner, farmer, partial, reader].map(async user => {
    const session = await createSessionToken(user.id, user.role, 3600, {authVersion: user.authVersion})
    return [user.id, session.token]
  })))
  let token = tokens.get(owner.id)
  const apiUrl = await campaignHttpServer(t)
  const actions = campaignFrontActions(t, apiUrl, () => token)
  const data = result => {
    t.true(result.success, result.error || 'La requête HTTP a abouti')
    return result.data.data
  }

  const expectStatus = async (result, status) => {
    const response = await result
    t.is(response.code, status)
  }

  const as = user => {
    token = user ? tokens.get(user.id) : undefined
  }

  as(null)
  await expectStatus(actions.listCampaignsAction(), 401)
  token = randomUUID()
  await expectStatus(actions.listCampaignsAction(), 401)
  as(owner)
  const options = data(await actions.getCampaignOptionsAction({zoneId, limit: 1}))
  t.is(options.pagination.total, 2)
  t.true(options.pagination.hasMore)
  const next = data(await actions.getCampaignOptionsAction({zoneId, limit: 1, cursor: options.pagination.nextCursor}))
  t.not(next.exploitations[0].id, options.exploitations[0].id)

  const {initialCampaignConfiguration, campaignConfigurationPayload} = await import(new URL('../../lib/campaign-configuration.js', pathToFileURL(process.env.CAMPAIGN_FRONT_ACTIONS_FILE)))
  const closesAt = new Date(Date.now() + (30 * 86_400_000)).toISOString().slice(0, 10)
  const form = {
    ...initialCampaignConfiguration(undefined, {}, 2026), name: `Campagne HTTP ${suffix}`, zoneId, ownerCollecteurUserId: owner.id,
    timezone: 'UTC', opensAt: new Date(Date.now() + 86_400_000).toISOString().slice(0, 16), closesAt: `${closesAt}T00:00`, reminderDays: [7],
    indexDates: ['2025-01-01', '2026-01-01'], periods: [{kind: 'NEEDS', position: 0, label: 'Besoins annuels', startDate: '2027-01-01', endDate: '2028-01-01'}],
    targets: exploitations.map(exploitation => ({exploitationId: exploitation.id, eligibilityConfirmed: false}))
  }
  const config = campaignConfigurationPayload(form)
  let {campaign} = data(await actions.saveCampaignAction(null, config))
  t.is(campaign.status, 'DRAFT')
  t.true(campaign.targets.every(target => target.eligibilityConfirmed))
  const revision = campaign.version
  const changed = {...config, name: `${form.name} corrigée`, expectedVersion: revision};
  ({campaign} = data(await actions.saveCampaignAction(campaign.id, changed)))
  t.is(campaign.version, revision + 1)
  await expectStatus(actions.saveCampaignAction(campaign.id, changed), 409)
  await expectStatus(actions.setCampaignOpenAction(campaign.id, true, campaign.version), 409)
  t.is(data(await actions.getCampaignAction(campaign.id)).campaign.status, 'DRAFT')
  t.is(await prisma.campaignNotification.count({where: {campaignId: campaign.id}}), 0)
  const expired = {
    ...config, expectedVersion: campaign.version, reminderDays: [],
    opensAt: new Date(Date.now() - (5 * 86_400_000)).toISOString(), closesAt: new Date(Date.now() - 86_400_000).toISOString()
  };
  ({campaign} = data(await actions.saveCampaignAction(campaign.id, expired)))
  await expectStatus(actions.setCampaignOpenAction(campaign.id, true, campaign.version), 409)
  t.is(data(await actions.getCampaignAction(campaign.id)).campaign.status, 'DRAFT')
  t.is(await prisma.campaignNotification.count({where: {campaignId: campaign.id}}), 0);
  ({campaign} = data(await actions.saveCampaignAction(campaign.id, {...config, expectedVersion: campaign.version, opensAt: new Date(Date.now() - 60_000).toISOString()})));
  ({campaign} = data(await actions.saveCampaignManagersAction(campaign.id, {expectedVersion: campaign.version, managers: [{userId: reader.id, role: 'READER'}]})))
  as(reader)
  await expectStatus(actions.getCampaignAction(campaign.id), 403)
  await expectStatus(actions.setCampaignOpenAction(campaign.id, true, campaign.version), 403)
  as(owner);
  ({campaign} = data(await actions.setCampaignOpenAction(campaign.id, true, campaign.version)))
  t.is(campaign.status, 'OPEN')
  const queuedOpening = await prisma.campaignNotification.findMany({where: {campaignId: campaign.id, kind: 'OPENING'}})
  t.is(queuedOpening.length, 1)
  t.is(queuedOpening[0].status, 'PENDING')
  const mails = []
  const delivery = {frontUrl: 'http://127.0.0.1:39999', async mailer(to, subject, html) {
    t.true(to.endsWith('@example.test'))
    mails.push({to, subject, html})
  }}
  t.deepEqual(await processCampaignNotification(queuedOpening[0].id, delivery), {sent: true})
  t.deepEqual(await processCampaignNotification(queuedOpening[0].id, delivery), {claimed: false})
  t.is(mails.length, 1)
  t.is(mails[0].to, farmer.email)
  t.true(mails[0].html.includes(campaign.id))
  const openingStatus = await prisma.campaignNotification.findUnique({where: {id: queuedOpening[0].id}})
  t.is(openingStatus.status, 'SENT')

  const scheduledAt = new Date(new Date(campaign.closesAt).getTime() - (8 * 86_400_000) + (9 * 3_600_000))
  const beforeScheduled = await prisma.campaignNotification.count({where: {campaignId: campaign.id, kind: 'REMINDER'}})
  await scheduleCampaignReminders({now: scheduledAt})
  t.is(await prisma.campaignNotification.count({where: {campaignId: campaign.id, kind: 'REMINDER'}}), beforeScheduled + 1)
  await scheduleCampaignReminders({now: scheduledAt})
  t.is(await prisma.campaignNotification.count({where: {campaignId: campaign.id, kind: 'REMINDER'}}), beforeScheduled + 1)
  const pendingReminder = await prisma.campaignNotification.findFirst({where: {campaignId: campaign.id, kind: 'REMINDER'}})
  t.is(data(await actions.remindCampaignAction(campaign.id)).queuedCount, 1)
  t.is(data(await actions.remindCampaignAction(campaign.id)).queuedCount, 0)

  as(partial)
  const limited = data(await actions.getCampaignContextAction(campaign.id, farmer.id))
  t.is(limited.targets.length, 1)
  t.false(limited.permissions.canSubmit)
  const ownTarget = limited.targets[0]
  const needsPeriod = campaign.periods.find(period => period.kind === 'NEEDS')
  const ownNeed = {targetId: ownTarget.id, periodId: needsPeriod.id, requestedVolume: '120'}
  const partialDraft = data(await actions.saveCampaignResponseAction(campaign.id, 'NEEDS', {preleveurUserId: farmer.id, expectedVersion: 0, data: {needs: [ownNeed]}}))
  await expectStatus(actions.submitCampaignResponseAction(campaign.id, 'NEEDS', {
    preleveurUserId: farmer.id, expectedVersion: partialDraft.response.version, idempotencyKey: randomUUID()
  }), 403)
  const otherTarget = campaign.targets.find(target => target.id !== ownTarget.id)
  await expectStatus(actions.saveCampaignResponseAction(campaign.id, 'NEEDS', {
    preleveurUserId: farmer.id, expectedVersion: partialDraft.response.version, data: {needs: [{...ownNeed, targetId: otherTarget.id}]}
  }), 403)
  as(reader)
  const readOnly = data(await actions.getCampaignContextAction(campaign.id, farmer.id))
  t.false(readOnly.permissions.canEdit)
  await expectStatus(actions.saveCampaignResponseAction(campaign.id, 'NEEDS', {
    preleveurUserId: farmer.id, expectedVersion: partialDraft.response.version, data: {needs: [ownNeed]}
  }), 403)

  as(farmer)
  const context = data(await actions.getCampaignContextAction(campaign.id))
  t.is(context.preleveurUserId, farmer.id)
  const readings = campaign.targets.flatMap(target => campaign.indexDates.map((readingDate, index) => ({
    targetId: target.id, compteurId: null, readingDate, value: index ? '123.5' : '0'
  })))
  const indexDraft = data(await actions.saveCampaignResponseAction(campaign.id, 'INDEX', {preleveurUserId: farmer.id, expectedVersion: 0, data: {readings}}))
  const indexRequest = {preleveurUserId: farmer.id, expectedVersion: indexDraft.response.version, idempotencyKey: randomUUID()}
  const indexSubmission = data(await actions.submitCampaignResponseAction(campaign.id, 'INDEX', indexRequest))
  data(await actions.submitCampaignResponseAction(campaign.id, 'INDEX', indexRequest))
  t.deepEqual(indexSubmission.response.latestSubmission.publication.totals.map(total => total.value), ['123.5', '123.5'])
  const manualReminder = await prisma.campaignNotification.findFirst({where: {campaignId: campaign.id, kind: 'REMINDER', id: {not: pendingReminder.id}}})
  t.deepEqual(await processCampaignNotification(manualReminder.id, delivery), {sent: true})
  t.true(mails.at(-1).html.includes(`/mes-besoins/${campaign.id}`))
  const needs = campaign.targets.map(target => ({targetId: target.id, periodId: needsPeriod.id, requestedVolume: '1500.25'}))
  const needsDraft = data(await actions.saveCampaignResponseAction(campaign.id, 'NEEDS', {preleveurUserId: farmer.id, expectedVersion: partialDraft.response.version, data: {needs}}))
  const needsRequest = {preleveurUserId: farmer.id, expectedVersion: needsDraft.response.version, idempotencyKey: randomUUID()}
  const needsSubmission = data(await actions.submitCampaignResponseAction(campaign.id, 'NEEDS', needsRequest))
  data(await actions.submitCampaignResponseAction(campaign.id, 'NEEDS', needsRequest))
  t.is(await prisma.campaignSubmission.count({where: {response: {campaignId: campaign.id}}}), 2)
  t.true(needsSubmission.response.latestSubmission.snapshot.needs.every(need => need.requestedVolume === '1500.25' && !Object.hasOwn(need, 'requestedFlow')))
  const storedNeeds = await prisma.campaignNeedLine.findMany({where: {submissionId: needsSubmission.response.latestSubmission.id}})
  t.is(storedNeeds.length, 2)
  t.true(storedNeeds.every(need => need.requestedFlow === null && need.requestedVolume.toString() === '1500.25'))
  const history = data(await actions.getCampaignHistoryAction(campaign.id, 'NEEDS', farmer.id))
  t.is(history.items.length, 1)
  const receipts = await prisma.campaignNotification.findMany({where: {campaignId: campaign.id, kind: 'RECEIPT'}})
  t.is(receipts.length, 2)
  for (const receipt of receipts) {
    // eslint-disable-next-line no-await-in-loop
    t.deepEqual(await processCampaignNotification(receipt.id, delivery), {sent: true})
  }

  t.is(mails.length, 4)
  t.true(mails.some(mail => mail.html.includes(`/mes-besoins/${campaign.id}`)))
  t.deepEqual(await processCampaignNotification(pendingReminder.id, {...delivery, now: scheduledAt}), {skipped: true})
  const skippedReminder = await prisma.campaignNotification.findUnique({where: {id: pendingReminder.id}})
  t.is(skippedReminder.error, 'REPONSES_DEJA_TRANSMISES')
  t.is(mails.length, 4)
  as(owner)
  t.is(data(await actions.remindCampaignAction(campaign.id)).queuedCount, 0)
  const remainingNotifications = await prisma.campaignNotification.count({where: {campaignId: campaign.id, kind: 'REMINDER'}})
  await scheduleCampaignReminders({now: scheduledAt})
  t.is(await prisma.campaignNotification.count({where: {campaignId: campaign.id, kind: 'REMINDER'}}), remainingNotifications)
  const exported = data(await actions.createCampaignExportAction(campaign.id))
  t.is(data(await actions.getCampaignExportAction(campaign.id, exported.id)).status, 'PENDING')
  let uploaded
  const storageFactory = () => ({async uploadObject(key, buffer) {
    uploaded = {key, buffer}
  }, async getPresignedUrl() {
    return 'http://127.0.0.1:39999/export-capture.xlsx'
  }})
  t.deepEqual(await processCampaignExport(exported.id, {storageFactory}), {completed: true})
  t.true(uploaded.buffer.byteLength > 100)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(uploaded.buffer)
  const needsSheet = workbook.getWorksheet('Besoins en eau')
  t.notRegex(needsSheet.getRow(1).values.join(' '), /débit/i)
  t.is(exportCell(needsSheet, 'Volume demandé (m³)').value, '1500.25')
  const download = await getCampaignExport(owner, campaign.id, exported.id, {storageFactory})
  t.is(download.downloadUrl, 'http://127.0.0.1:39999/export-capture.xlsx')
  as(partial)
  await expectStatus(actions.getCampaignExportAction(campaign.id, exported.id), 404)
  as(owner);
  ({campaign} = data(await actions.setCampaignOpenAction(campaign.id, false, campaign.version)))
  t.is(campaign.status, 'CLOSED')
  await expectStatus(actions.remindCampaignAction(campaign.id), 409)
  as(farmer)
  await expectStatus(actions.saveCampaignResponseAction(campaign.id, 'NEEDS', {
    preleveurUserId: farmer.id, expectedVersion: needsSubmission.response.version, data: {needs}
  }), 409)
  const closed = data(await actions.getCampaignContextAction(campaign.id))
  t.false(closed.permissions.canEdit)
  await prisma.user.update({where: {id: farmer.id}, data: {authVersion: {increment: 1}}})
  await expectStatus(actions.getCampaignContextAction(campaign.id), 401)
})
