import test from 'ava'
import {campaignSubmissionHash, resolveCampaignMeters} from '../campaign-meters.js'

const response = {campaignId: 'campaign', exploitationId: 'exploitation', preleveurUserId: 'owner'}
const meter = {serialNumber: null, offSeason: {indexStart: '100', indexEnd: '200'}, season: {indexEnd: '260'}}

function client(records = [], allocationIds = []) {
  const counters = records.map(record => ({deletedAt: null, ...record}))
  const allocations = [...allocationIds]
  let lookups = 0
  return {
    counters, allocations, get lookups() { return lookups },
    $executeRaw: async () => 1,
    meterAllocation: {
      findMany: async () => allocations.map(compteurId => ({compteurId, compteur: counters.find(record => record.id === compteurId)})),
      create: async ({data}) => { allocations.push(data.compteurId); return data }
    },
    compteur: {
      findMany: async ({where}) => { lookups++; return counters.filter(record => record.serialNumber?.toUpperCase() === where.serialNumber.equals.toUpperCase()) },
      findUnique: async ({where}) => counters.find(record => record.id === where.id),
      create: async ({data}) => { const record = {id: `new-${counters.length}`, ...data}; counters.push(record); return record },
      updateMany: async ({where, data}) => { Object.assign(counters.find(record => record.id === where.id), data); return {count: 1} }
    }
  }
}

test('deux compteurs sans numéro restent distincts, sans recherche globale des numéros vides', async t => {
  const tx = client([{id: 'unrelated', serialNumber: null}])
  const result = await resolveCampaignMeters(tx, response, {meters: [meter, meter]})
  t.is(tx.lookups, 0)
  t.deepEqual(result.meters.map(row => row.serialNumber), [null, null])
  t.deepEqual(result.meters.map(row => row.compteurId), ['new-1', 'new-2'])
  t.deepEqual(tx.allocations, ['new-1', 'new-2'])
})

test('le compteur connu reste identifié par son UUID sans numéro fourni', async t => {
  const tx = client([{id: 'known', serialNumber: null}], ['known'])
  const result = await resolveCampaignMeters(tx, response, {meters: [{...meter, compteurId: 'known'}]})
  t.is(result.meters[0].compteurId, 'known')
  t.is(tx.counters.length, 1)
  t.is(tx.lookups, 0)
})

test('un compteur revendiqué dans la réponse précédente conserve son identité sans créer de rattachement', async t => {
  const tx = client([{id: 'claim', serialNumber: 'CLAIM'}])
  const previous = {...response, submittedData: {meters: [{...meter, compteurId: 'claim', serialNumber: 'CLAIM'}]}}
  const result = await resolveCampaignMeters(tx, previous, {meters: [{...meter, compteurId: 'claim'}]})
  t.is(result.meters[0].serialNumber, 'CLAIM')
  t.deepEqual(tx.allocations, [])
})

test('un UUID étranger ne peut pas contourner la résolution par numéro', async t => {
  const tx = client([{id: 'foreign', serialNumber: null}])
  const error = await t.throwsAsync(resolveCampaignMeters(tx, response, {meters: [{...meter, compteurId: 'foreign'}]}))
  t.is(error.status, 403)
  t.deepEqual(tx.allocations, [])
})

test('compléter le numéro conserve le compteur et refuse une collision insensible à la casse', async t => {
  const tx = client([{id: 'known', serialNumber: null}, {id: 'other', serialNumber: 'EXISTING'}], ['known'])
  const error = await t.throwsAsync(resolveCampaignMeters(tx, response, {meters: [{...meter, compteurId: 'known', serialNumber: 'existing'}]}))
  t.is(error.status, 409)
  t.is(tx.counters[0].serialNumber, null)
  const result = await resolveCampaignMeters(tx, response, {meters: [{...meter, compteurId: 'known', serialNumber: 'COMPLETED'}]})
  t.is(result.meters[0].compteurId, 'known')
  t.is(tx.counters[0].serialNumber, 'COMPLETED')
  t.is(tx.counters.length, 2)
})

test('un numéro existant est conservé s’il est omis et ne peut pas être remplacé', async t => {
  const tx = client([{id: 'known', serialNumber: 'KNOWN'}], ['known'])
  t.is((await resolveCampaignMeters(tx, response, {meters: [{...meter, compteurId: 'known'}]})).meters[0].serialNumber, 'KNOWN')
  t.is((await t.throwsAsync(resolveCampaignMeters(tx, response, {meters: [{...meter, compteurId: 'known', serialNumber: 'CHANGED'}]}))).status, 409)
  t.is(tx.counters[0].serialNumber, 'KNOWN')
})

test('une collision concurrente en base demande une correction plutôt qu’une erreur serveur', async t => {
  const tx = client([{id: 'known', serialNumber: null}], ['known'])
  tx.compteur.updateMany = async () => { throw Object.assign(new Error('synthetic collision'), {code: 'P2002'}) }
  t.is((await t.throwsAsync(resolveCampaignMeters(tx, response, {meters: [{...meter, compteurId: 'known', serialNumber: 'COLLISION'}]}))).status, 409)
})

test('les replays avec ou sans UUID serveur gardent la même empreinte, y compris sans numéro', t => {
  const request = {meters: [meter, {...meter, serialNumber: 'named'}]}
  const saved = {meters: [{...meter, compteurId: 'anonymous'}, {...meter, serialNumber: 'NAMED', compteurId: 'named'}]}
  t.is(campaignSubmissionHash(request, saved), campaignSubmissionHash(saved))
  t.is(campaignSubmissionHash(saved, saved), campaignSubmissionHash(saved))
  t.is(campaignSubmissionHash({meters: [saved.meters[0], {...saved.meters[1], serialNumber: null}]}, saved), campaignSubmissionHash(saved))
  t.not(campaignSubmissionHash({...saved, meters: saved.meters.map(row => ({...row, compteurId: 'foreign'}))}, saved), campaignSubmissionHash(saved))
  t.not(campaignSubmissionHash({...request, meters: [{...meter, season: {indexEnd: '280'}}, request.meters[1]]}, saved), campaignSubmissionHash(saved))
})
