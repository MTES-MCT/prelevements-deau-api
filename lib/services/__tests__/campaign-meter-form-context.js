import test from 'ava'
import {getAuthorizedCampaignResponseContext, saveCollectionResponseDraft} from '../collection-campaigns.js'
import {submitCampaignResponse} from '../campaign-submission.js'

const owner = {id: '10000000-0000-4000-8000-000000000001', role: 'DECLARANT'}
const collector = {id: '10000000-0000-4000-8000-000000000002', role: 'DECLARANT'}
const firstId = '10000000-0000-4000-8000-000000000003'
const secondId = '10000000-0000-4000-8000-000000000004'
const storedData = () => ({meters: [{compteurId: firstId, serialNumber: 'ORIGINAL', offSeason: {indexStart: '0', indexEnd: '10'}, season: {indexEnd: '30'}}],
  needs: {season: {volume: '150'}}, comment: 'Conserver'})

function fixture({submitted = false, serialNumber = 'CORRECTED', additionalMeter = true} = {}) {
  const campaign = {id: 'campaign', status: 'OPEN', opensOn: new Date('2000-01-01'), closesOn: new Date('2100-01-01'), collecteurUserId: collector.id}
  const response = {id: 'response', campaignId: campaign.id, exploitationId: 'exploitation', preleveurUserId: owner.id, revision: 0,
    draftData: submitted ? null : storedData(), submittedData: submitted ? storedData() : null,
    firstSubmittedAt: submitted ? new Date('2026-10-01') : null,
    exploitation: {id: 'exploitation', declarantUserId: owner.id, status: 'EN_ACTIVITE', collecteurs: [{collecteurUserId: collector.id}],
      declarant: {userId: owner.id, quickDeclarationEnabled: true, user: {id: owner.id, deletedAt: null}},
      pointPrelevement: {id: 'point', collectionMode: 'MANUAL', deletedAt: null}}}
  const meters = [{id: firstId, serialNumber}, ...(additionalMeter ? [{id: secondId, serialNumber: 'NEW'}] : [])]
  let writes = 0
  const client = {
    $transaction: async callback => callback(client), $executeRaw: async () => 1, $queryRaw: async () => [],
    collectionCampaign: {findFirst: async () => campaign},
    collectionResponse: {findFirst: async () => response, updateMany: async ({data}) => {
      writes++
      response.draftData = data.draftData
      response.revision++
      return {count: 1}
    }},
    meterAllocation: {findMany: async () => meters.map(meter => ({compteurId: meter.id,
      compteur: {...meter, deletedAt: null, meterAllocations: [{exploitationId: 'exploitation'}]}}))},
    sandreWaterUse: {findMany: async () => []}, chunkValue: {findMany: async () => []}
  }
  return {campaign, response, meters, client, writes: () => writes}
}

test('le rechargement conserve un numéro saisi sur compteur physique vide et applique un effacement ultérieur', async t => {
  const f = fixture({serialNumber: null, additionalMeter: false})
  f.meters[0].updatedAt = new Date('2026-10-01T10:00:00Z')
  f.response.updatedAt = new Date('2026-10-01T11:00:00Z')
  f.response.draftData.meters[0].serialNumber = 'DRAFT-123'
  const loaded = await getAuthorizedCampaignResponseContext(owner, f.campaign.id, f.response.id, f)
  t.is(loaded.data.meters[0].serialNumber, 'DRAFT-123')
  t.is(loaded.data.meters[0].expectedSerialNumber, null)
  t.is(loaded.data.meters[0].offSeason.indexEnd, '10')
  f.meters[0].updatedAt = new Date('2026-10-01T12:00:00Z')
  const cleared = await getAuthorizedCampaignResponseContext(owner, f.campaign.id, f.response.id, f)
  t.is(cleared.data.meters[0].serialNumber, null)
  t.is(cleared.response.draftData.meters[0].serialNumber, 'DRAFT-123')
  t.is(f.writes(), 0)
})

test('le chargement propriétaire et collecteur réconcilie les compteurs sans réécrire brouillon ni réponse soumise', async t => {
  await Promise.all([false, true].map(async submitted => {
    const f = fixture({submitted})
    const original = structuredClone(f.response)
    await Promise.all([owner, collector].map(async actor => {
      const context = await getAuthorizedCampaignResponseContext(actor, f.campaign.id, f.response.id, f)
      t.is(context.data.meters.length, 2)
      t.is(context.data.meters[0].serialNumber, 'CORRECTED')
      t.is(context.data.meters[0].expectedSerialNumber, 'CORRECTED')
      t.is(context.data.meters[0].offSeason.indexStart, '0')
      t.deepEqual(context.data.meters[1], {compteurId: secondId, serialNumber: 'NEW', expectedSerialNumber: 'NEW', offSeason: {}, season: {}})
      t.is(context.data.needs.season.volume, '150')
      t.deepEqual(context.response[submitted ? 'submittedData' : 'draftData'], storedData())
    }))
    t.deepEqual(f.response, original)
    t.is(f.writes(), 0)
  }))
})

test('un ancien brouillon avec numéro corrigé ou effacé est refusé avant écriture', async t => {
  await Promise.all(['CORRECTED', null].map(async serialNumber => {
    const f = fixture({serialNumber, additionalMeter: false})
    const error = await t.throwsAsync(saveCollectionResponseDraft(collector, f.campaign.id, f.response.id, {revision: 0, data: storedData()}, f))
    t.is(error.status, 409)
    t.is(f.writes(), 0)
    t.deepEqual(f.response.draftData, storedData())
  }))
})

test('le contrôle du numéro précède le raccourci de rejeu de la réponse soumise', async t => {
  await Promise.all(['CORRECTED', null].map(async serialNumber => {
    const f = fixture({submitted: true, serialNumber, additionalMeter: false})
    const error = await t.throwsAsync(submitCampaignResponse({user: owner, campaignId: f.campaign.id, responseId: f.response.id,
      body: {revision: 0, data: storedData()}}, f))
    t.is(error.status, 409)
    t.is(f.writes(), 0)
    t.deepEqual(f.response.submittedData, storedData())
  }))
})

test('un brouillon rechargé se sauvegarde sans jeton technique ni modification de la réponse soumise', async t => {
  const f = fixture({submitted: true})
  const context = await getAuthorizedCampaignResponseContext(collector, f.campaign.id, f.response.id, f)
  const result = await saveCollectionResponseDraft(collector, f.campaign.id, f.response.id, {revision: 0, data: context.data}, f)
  t.is(f.writes(), 1)
  t.is(result.response.revision, 1)
  t.true(f.response.draftData.meters.every(meter => !Object.hasOwn(meter, 'expectedSerialNumber')))
  t.deepEqual(f.response.submittedData, storedData())
  t.is(result.data.meters[0].expectedSerialNumber, 'CORRECTED')
})

test('le rejeu inchangé reste sans écriture après retrait du jeton de concurrence', async t => {
  const f = fixture({submitted: true, serialNumber: 'ORIGINAL', additionalMeter: false})
  const context = await getAuthorizedCampaignResponseContext(owner, f.campaign.id, f.response.id, f)
  const result = await submitCampaignResponse({user: owner, campaignId: f.campaign.id, responseId: f.response.id,
    body: {revision: 0, data: context.data}}, f)
  t.is(f.writes(), 0)
  t.deepEqual(result.response.submittedData, storedData())
})
