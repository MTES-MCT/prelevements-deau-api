import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {getAuthorizedCampaignResponseContext, saveCollectionResponseDraft} from '../collection-campaigns.js'
import {submitCampaignResponse} from '../campaign-submission.js'
import {resolveCampaignMeters} from '../campaign-meters.js'
import {recheckCampaignResponsePublicationInTransaction} from '../campaign-auto-publication.js'
import {invalidateCampaignMeterPublication} from '../campaign-meter-publication.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function fixture(run) {
  const rollback = new Error('ROLLBACK_SYNTHETIC_CAMPAIGN_FORM')
  try {
    await prisma.$transaction(async tx => {
      const owner = await tx.user.create({data: {role: 'DECLARANT', declarant: {create: {declarantRole: 'PRELEVEUR', preleveurType: 'IRRIGANT', quickDeclarationEnabled: true}}}})
      const collector = await tx.user.create({data: {role: 'DECLARANT', declarant: {create: {declarantRole: 'COLLECTEUR'}}}})
      const point = await tx.pointPrelevement.create({data: {name: `Synthetic campaign meter ${randomUUID()}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT', collectionMode: 'MANUAL'}})
      const usage = await tx.sandreWaterUse.findFirstOrThrow({where: {code: '2', kind: 'USAGE'}})
      const exploitation = await tx.declarantPointPrelevement.create({data: {declarantUserId: owner.id, pointPrelevementId: point.id, usageId: usage.id, status: 'EN_ACTIVITE'}})
      await tx.declarantCollecteurExploitation.create({data: {collecteurUserId: collector.id, exploitationId: exploitation.id}})
      const campaign = await tx.collectionCampaign.create({data: {name: 'Synthetic campaign meter form', status: 'OPEN',
        opensOn: new Date('2000-01-01'), closesOn: new Date('2100-01-01'), collecteurUserId: collector.id, createdByUserId: collector.id}})
      const response = await tx.collectionResponse.create({data: {campaignId: campaign.id, exploitationId: exploitation.id, preleveurUserId: owner.id}})
      const meter = await tx.compteur.create({data: {serialNumber: null, updatedAt: new Date('2000-01-01')}})
      const client = new Proxy(tx, {get: (target, key) => key === '$transaction' ? callback => callback(client) : target[key]})
      await run({tx, client, owner, collector, point, usage, exploitation, campaign, response, meter})
      throw rollback
    }, {isolationLevel: 'Serializable', timeout: 20_000})
  } catch (error) {
    if (error !== rollback) throw error
  }
}

async function referenceLink(tx, exploitation, meter) {
  return tx.meterAllocation.create({data: {sourceId: randomUUID(), provider: 'collector-form', scope: exploitation.id,
    compteurId: meter.id, exploitationId: exploitation.id, versions: {create: {version: 1, enabled: false}}}})
}

integration('SQL: a typed serial survives draft save/reload; a later physical clear takes precedence without rewriting the draft', async t => {
  await fixture(async f => {
    await referenceLink(f.tx, f.exploitation, f.meter)
    const options = {client: f.client}
    const initial = await getAuthorizedCampaignResponseContext(f.owner, f.campaign.id, f.response.id, options)
    t.is(initial.data.meters[0].expectedSerialNumber, null)
    initial.data.meters[0].serialNumber = 'SYNTHETIC-DRAFT-123'
    initial.data.meters[0].offSeason.indexStart = '42'
    const saved = await saveCollectionResponseDraft(f.owner, f.campaign.id, f.response.id, {revision: 0, data: initial.data}, options)
    t.is(saved.data.meters[0].serialNumber, 'SYNTHETIC-DRAFT-123')
    const reloaded = await getAuthorizedCampaignResponseContext(f.collector, f.campaign.id, f.response.id, options)
    t.is(reloaded.data.meters[0].serialNumber, 'SYNTHETIC-DRAFT-123')
    t.is(reloaded.data.meters[0].offSeason.indexStart, '42')
    const stored = await f.tx.collectionResponse.findUniqueOrThrow({where: {id: f.response.id}})
    t.false(Object.hasOwn(stored.draftData.meters[0], 'expectedSerialNumber'))
    t.is((await f.tx.compteur.findUniqueOrThrow({where: {id: f.meter.id}})).serialNumber, null)
    await f.tx.compteur.update({where: {id: f.meter.id}, data: {serialNumber: 'CORRECTED', updatedAt: new Date(stored.updatedAt.getTime() + 1)}})
    const corrected = await getAuthorizedCampaignResponseContext(f.owner, f.campaign.id, f.response.id, options)
    t.is(corrected.data.meters[0].serialNumber, 'CORRECTED')
    await f.tx.compteur.update({where: {id: f.meter.id}, data: {serialNumber: null, updatedAt: new Date(stored.updatedAt.getTime() + 2)}})
    const cleared = await getAuthorizedCampaignResponseContext(f.owner, f.campaign.id, f.response.id, options)
    t.is(cleared.data.meters[0].serialNumber, null)
    t.is(cleared.data.meters[0].offSeason.indexStart, '42')
    t.deepEqual(await f.tx.collectionResponse.findUniqueOrThrow({where: {id: f.response.id}}), stored)
    const error = await t.throwsAsync(saveCollectionResponseDraft(f.owner, f.campaign.id, f.response.id,
      {revision: stored.revision, data: corrected.data}, options))
    t.is(error.status, 409)
    t.is(await f.tx.meterReading.count({where: {compteurId: f.meter.id}}), 0)
  })
})

integration('SQL: claimed legacy meter identities refresh only with an exact exploitation chunk and reject stale replay', async t => {
  await fixture(async f => {
    const number = `LEGACY-${randomUUID()}`
    await f.tx.compteur.update({where: {id: f.meter.id}, data: {serialNumber: number}})
    const extra = await f.tx.compteur.create({data: {serialNumber: `UNCLAIMED-${randomUUID()}`}})
    const foreign = await f.tx.compteur.create({data: {serialNumber: `FOREIGN-${randomUUID()}`}})
    const source = await f.tx.source.create({data: {type: 'BATCH', status: 'COMPLETED'}})
    await f.tx.chunk.createMany({data: [f.meter, extra].map(meter => ({sourceId: source.id, compteurId: meter.id,
      pointPrelevementId: f.point.id, exploitationId: f.exploitation.id, preleveurUserId: f.owner.id,
      usageId: f.usage.id, minDate: new Date('2025-01-01'), maxDate: new Date('2025-12-31')}))})
    const storedData = {meters: [{compteurId: f.meter.id, serialNumber: 'OLD', offSeason: {indexStart: '42'}, season: {}}]}
    await f.tx.collectionResponse.update({where: {id: f.response.id}, data: {submittedData: storedData, draftData: storedData, firstSubmittedAt: new Date()}})
    const before = await f.tx.collectionResponse.findUniqueOrThrow({where: {id: f.response.id}})
    const options = {client: f.client}
    const context = await getAuthorizedCampaignResponseContext(f.collector, f.campaign.id, f.response.id, options)
    t.deepEqual(context.meters.map(meter => meter.compteurId), [f.meter.id])
    t.is(context.data.meters[0].serialNumber, number)
    t.is(context.data.meters[0].offSeason.indexStart, '42')
    t.deepEqual(context.response.submittedData, storedData)
    const stale = await t.throwsAsync(submitCampaignResponse({user: f.owner, campaignId: f.campaign.id, responseId: f.response.id,
      body: {revision: 0, data: storedData}}, options))
    t.is(stale.status, 409)
    // A draft-only claim is allowed by actual ownership, not by the UUID alone.
    const draftResponse = {...f.response, draftData: context.data}
    t.is((await resolveCampaignMeters(f.tx, draftResponse, context.data)).meters[0].compteurId, f.meter.id)
    const foreignData = {meters: [{compteurId: foreign.id, serialNumber: foreign.serialNumber}]}
    t.is((await t.throwsAsync(resolveCampaignMeters(f.tx, {...f.response, draftData: foreignData}, foreignData))).status, 403)
    t.is(await f.tx.meterAllocation.count({where: {exploitationId: f.exploitation.id}}), 0)
    t.deepEqual(await f.tx.collectionResponse.findUniqueOrThrow({where: {id: f.response.id}}), before)
  })
})

integration('SQL: publication-only updates cannot resurrect a divergent draft serial after a physical clear', async t => {
  await fixture(async f => {
    await referenceLink(f.tx, f.exploitation, f.meter)
    const declaration = await f.tx.declaration.create({data: {code: randomUUID().slice(0, 6), declarantUserId: f.owner.id,
      type: 'quick-declaration', waterWithdrawalType: 'unknown', dataSourceType: 'MANUAL'}})
    const submittedData = {meters: [{compteurId: f.meter.id, serialNumber: 'SUBMITTED-OLD', meterChanged: true,
      meterChangeReason: 'Synthetic reason', offSeason: {indexStart: '42', indexEnd: '52'}, season: {indexEnd: '62'}}]}
    const draftData = structuredClone(submittedData)
    draftData.meters[0].serialNumber = 'DIVERGENT-DRAFT'
    const savedAt = new Date('2025-01-01T10:00:00Z')
    const response = await f.tx.collectionResponse.update({where: {id: f.response.id}, data: {
      draftData, submittedData, firstSubmittedAt: savedAt, declarationId: declaration.id, updatedAt: savedAt}})
    await f.tx.compteur.update({where: {id: f.meter.id}, data: {serialNumber: null, updatedAt: new Date('2025-01-02')}})
    const result = await recheckCampaignResponsePublicationInTransaction(f.tx, f.response.id)
    t.true(result.changed)
    t.is(result.publicationStatus, 'PENDING_REVIEW')
    await invalidateCampaignMeterPublication(f.tx, f.campaign.id, f.meter.id, {reported: true})
    const after = await f.tx.collectionResponse.findUniqueOrThrow({where: {id: f.response.id}})
    t.deepEqual(after.updatedAt, savedAt)
    t.deepEqual(after.draftData, response.draftData)
    t.deepEqual(after.submittedData, response.submittedData)
    t.is(after.revision, response.revision)
    const context = await getAuthorizedCampaignResponseContext(f.owner, f.campaign.id, f.response.id, {client: f.client})
    t.is(context.data.meters[0].serialNumber, null)
    t.is(context.data.meters[0].offSeason.indexStart, '42')
    t.is(context.response.draftData.meters[0].serialNumber, 'DIVERGENT-DRAFT')
    t.is(await f.tx.meterReading.count({where: {compteurId: f.meter.id}}), 0)
  })
})
