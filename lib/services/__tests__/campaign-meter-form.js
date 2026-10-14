import test from 'ava'
import {reconcileCampaignMeterForm, validateCampaignMeterForm} from '../campaign-meter-form.js'
import {validateCollectionResponseData} from '../../validation/collection-campaigns.js'

const first = {compteurId: '10000000-0000-4000-8000-000000000001', serialNumber: 'ACTUAL-1'}
const second = {compteurId: '10000000-0000-4000-8000-000000000002', serialNumber: 'ACTUAL-2'}

test('le formulaire actualise les identités autorisées et conserve toutes les valeurs sans modifier la réponse stockée', t => {
  const stored = {meters: [{compteurId: first.compteurId, serialNumber: 'OLD-1', meterChanged: true, meterChangeReason: 'Motif conservé',
    offSeason: {indexStart: '0', indexEnd: '5', surface: '3', crops: ['Blé']}, season: {indexEnd: '8'}}],
  needs: {season: {volume: '125'}}, comment: 'Commentaire conservé'}
  const original = structuredClone(stored)
  const result = reconcileCampaignMeterForm(stored, [first, second])
  t.deepEqual(stored, original)
  t.is(result.meters.length, 2)
  t.deepEqual(result.meters[0], {...stored.meters[0], serialNumber: first.serialNumber, expectedSerialNumber: first.serialNumber})
  t.deepEqual(result.meters[1], {...second, expectedSerialNumber: second.serialNumber, offSeason: {}, season: {}})
  t.deepEqual(result.needs, stored.needs)
  t.is(result.comment, stored.comment)
  result.meters[0].offSeason.crops.push('Maïs')
  t.deepEqual(stored.meters[0].offSeason.crops, ['Blé'])
})

test('un numéro effacé reste vide dans le formulaire sans changer le numéro historique', t => {
  const stored = {meters: [{...first, offSeason: {indexStart: '42'}}]}
  const result = reconcileCampaignMeterForm(stored, [{...first, serialNumber: null}])
  t.is(result.meters[0].serialNumber, null)
  t.is(result.meters[0].expectedSerialNumber, null)
  t.is(stored.meters[0].serialNumber, first.serialNumber)
  t.is(result.meters[0].offSeason.indexStart, '42')
})

test('un numéro saisi sur compteur vide reste dans le brouillon tant que le compteur ne change pas', t => {
  const stored = {meters: [{...first, serialNumber: 'DRAFT-123', offSeason: {indexStart: '42'}}]}
  const current = {...first, serialNumber: null, updatedAt: '2026-10-01T10:00:00.000Z'}
  const options = {draftUpdatedAt: '2026-10-01T11:00:00.000Z'}
  const result = reconcileCampaignMeterForm(stored, [current], options)
  t.is(result.meters[0].serialNumber, 'DRAFT-123')
  t.is(result.meters[0].expectedSerialNumber, null)
  t.is(result.meters[0].offSeason.indexStart, '42')
  t.is(reconcileCampaignMeterForm(stored, [{...current, updatedAt: '2026-10-01T12:00:00.000Z'}], options).meters[0].serialNumber, null)
  t.is(reconcileCampaignMeterForm(stored, [{...current, serialNumber: 'CORRECTED'}], options).meters[0].serialNumber, 'CORRECTED')
  t.is(stored.meters[0].serialNumber, 'DRAFT-123')
})

test('une ligne sans UUID est rapprochée seulement par numéro unique autorisé, sans double ajout', t => {
  const stored = {meters: [{serialNumber: ' actual-1 ', offSeason: {indexEnd: '125'}}]}
  const result = reconcileCampaignMeterForm(stored, [first, second, second])
  t.is(result.meters.length, 2)
  t.deepEqual(result.meters[0], {...stored.meters[0], ...first, expectedSerialNumber: first.serialNumber})
  t.is(result.meters[1].compteurId, second.compteurId)
})

test('une série vide, ambiguë ou un UUID étranger ne permettent aucun rapprochement implicite', t => {
  for (const [rows, known] of [
    [[{serialNumber: null, offSeason: {indexStart: '1'}}], [{...first, serialNumber: null}]],
    [[{serialNumber: first.serialNumber, offSeason: {indexStart: '1'}}], [first, {...second, serialNumber: first.serialNumber}]],
    [[{compteurId: 'foreign', serialNumber: first.serialNumber}], [first]],
    [[{serialNumber: first.serialNumber}, {serialNumber: first.serialNumber}], [first]]
  ]) {
    const result = reconcileCampaignMeterForm({meters: rows}, known)
    t.deepEqual(result.meters.slice(0, rows.length), rows)
    t.is(new Set(result.meters.slice(rows.length).map(row => row.compteurId)).size, known.length)
  }
})

test('un compteur déjà représenté par UUID ne fusionne pas une autre ligne saisie', t => {
  const rows = [{...first, offSeason: {indexStart: '10'}}, {serialNumber: first.serialNumber, offSeason: {indexStart: '20'}}]
  const result = reconcileCampaignMeterForm({meters: rows}, [first])
  t.is(result.meters.length, 2)
  t.is(result.meters[1].compteurId, undefined)
  t.is(result.meters[1].offSeason.indexStart, '20')
})

test('sans compteurs autorisés les anciennes réponses restent identiques', t => {
  const stored = {needs: {season: {volume: '12'}}}
  t.deepEqual(reconcileCampaignMeterForm(stored, []), stored)
  t.deepEqual(validateCampaignMeterForm(stored, []), stored)
})

test('le jeton de numéro est validé par Joi et retiré avant persistance ou calcul du hash', t => {
  const source = {meters: [{...first, expectedSerialNumber: first.serialNumber, offSeason: {indexStart: '0'}}]}
  const validated = validateCollectionResponseData(source)
  const result = validateCampaignMeterForm(validated, [first])
  t.false(Object.hasOwn(result.meters[0], 'expectedSerialNumber'))
  t.is(validated.meters[0].expectedSerialNumber, first.serialNumber)
  t.is(result.meters[0].offSeason.indexStart, '0')
  t.throws(() => validateCollectionResponseData({meters: [{expectedSerialNumber: {unexpected: true}}]}))
})

test('après rechargement un numéro initialement vide peut toujours être complété', t => {
  const current = {...first, serialNumber: null}
  const loaded = reconcileCampaignMeterForm({meters: []}, [current])
  loaded.meters[0].serialNumber = 'COMPLETED'
  const result = validateCampaignMeterForm(validateCollectionResponseData(loaded), [current])
  t.is(result.meters[0].serialNumber, 'COMPLETED')
  t.false(Object.hasOwn(result.meters[0], 'expectedSerialNumber'))
})

test('une ancienne page ne peut réintroduire un numéro corrigé ou effacé', t => {
  for (const [row, current] of [
    [{...first}, {...first, serialNumber: 'CORRECTED'}],
    [{...first, expectedSerialNumber: first.serialNumber}, {...first, serialNumber: 'CORRECTED'}],
    [{...first}, {...first, serialNumber: null}],
    [{...first, expectedSerialNumber: first.serialNumber}, {...first, serialNumber: null}],
    [{...first, serialNumber: 'DIFFERENT', expectedSerialNumber: first.serialNumber}, first]
  ]) t.is(t.throws(() => validateCampaignMeterForm({meters: [row]}, [current])).status, 409)
})

test('les anciens clients au numéro actuel et les nouveaux compteurs sans UUID restent compatibles', t => {
  const current = {meters: [{...first, serialNumber: ' actual-1 '}]}
  t.deepEqual(validateCampaignMeterForm(current, [first]), current)
  const newMeter = {meters: [{serialNumber: 'NEW', offSeason: {indexStart: '0'}}]}
  t.deepEqual(validateCampaignMeterForm(newMeter, []), newMeter)
  t.deepEqual(validateCampaignMeterForm({meters: [{...first, serialNumber: null}]}, [{...first, serialNumber: null}]), {meters: [{...first, serialNumber: null}]})
})

test('un ancien formulaire incomplet après ajout de compteur doit être rechargé', t => {
  t.is(t.throws(() => validateCampaignMeterForm({meters: [first]}, [first, second])).status, 409)
  t.is(t.throws(() => validateCampaignMeterForm({meters: []}, [first])).status, 409)
  const loaded = reconcileCampaignMeterForm({meters: [first]}, [first, second])
  t.notThrows(() => validateCampaignMeterForm(loaded, [first, second]))
})
