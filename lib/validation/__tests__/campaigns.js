import test from 'ava'
import {validateCampaignConfig, validateCampaignDraft, validateCampaignValue, campaignManagersSchema} from '../campaigns.js'

const ids = Array.from({length: 6}, (_, index) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`)
const [owner, zone, targetId, compteurId, indexPeriodId, needPeriodId] = ids
function config() {
  return {
    name: 'Collecte annuelle', year: 2026, ownerCollecteurUserId: owner, zoneId: zone,
    indexDates: ['2025-10-31', '2026-06-01', '2026-10-31'],
    periods: [
      {id: indexPeriodId, kind: 'INDEX', position: 0, label: 'Hors étiage', startDate: '2025-11-01', endDate: '2026-06-01', startReadingDate: '2025-10-31', endReadingDate: '2026-06-01'},
      {id: needPeriodId, kind: 'NEEDS', position: 0, label: 'Besoins à venir', startDate: '2026-11-01', endDate: '2027-06-01'}
    ], targets: [{exploitationId: targetId, eligibilityConfirmed: true}]
  }
}

const target = {id: targetId, meters: [{compteurId}]}
const context = () => ({campaign: config(), targets: [target]})
const need = () => ({targetId, periodId: needPeriodId, requestedFlow: '12.5000', requestedVolume: '9999999999999999.9999'})

test('campagne générique : périodes exclusives, bornes index distinctes et décimaux exacts', t => {
  const value = validateCampaignConfig(config(), {create: true})
  t.is(value.periods[0].startReadingDate, '2025-10-31')
  t.is(value.periods[0].startDate, '2025-11-01')
  t.is(value.expectedVersion, 0)
  const draft = validateCampaignDraft('NEEDS', {needs: [need()]}, {...context(), complete: true})
  t.is(draft.needs[0].requestedVolume, '9999999999999999.9999')
})

test('le partage exige une version et une liste explicite, sans modifier le calendrier ou les points', t => {
  t.deepEqual(validateCampaignValue(campaignManagersSchema, {expectedVersion: 2, managers: []}), {expectedVersion: 2, managers: []})
  const config = {expectedVersion: 2, managers: [{userId: owner, role: 'READER'}]}
  t.notThrows(() => validateCampaignValue(campaignManagersSchema, config))
  for (const value of [{managers: []}, {expectedVersion: 0}, {...config, indexDates: []}, {...config, targets: []}, {...config, managers: [...config.managers, ...config.managers]}, {...config, managers: [{userId: owner, role: 'ADMIN'}]}]) {
    t.is(t.throws(() => validateCampaignValue(campaignManagersSchema, value)).statusCode, 400)
  }
})

for (const invalid of ['2026-02-30', '2026-2-01', 'not-a-date']) {
  test(`les dates civiles invalides sont refusées : ${invalid}`, t => {
    const input = config()
    input.indexDates[0] = invalid
    t.is(t.throws(() => validateCampaignConfig(input, {create: true})).statusCode, 400)
  })
}

test('les périodes adjacentes sont valides mais le chevauchement et la longueur nulle sont refusés', t => {
  const input = config()
  input.periods.push({...input.periods[0], position: 1, startDate: '2026-06-01', endDate: '2026-11-01', startReadingDate: '2026-06-01', endReadingDate: '2026-10-31'})
  t.notThrows(() => validateCampaignConfig(input, {create: true}))
  input.periods[2].startDate = '2026-05-31'
  t.is(t.throws(() => validateCampaignConfig(input, {create: true})).statusCode, 400)
  input.periods[2].startDate = input.periods[2].endDate
  t.is(t.throws(() => validateCampaignConfig(input, {create: true})).statusCode, 400)
})

test('une date de relevé hors calendrier, une période dupliquée et un volet absent sont refusés', t => {
  const first = config()
  first.periods[0].endReadingDate = '2026-06-02'
  t.is(t.throws(() => validateCampaignConfig(first, {create: true})).statusCode, 400)
  const second = config()
  second.periods.push(second.periods[0])
  t.is(t.throws(() => validateCampaignConfig(second, {create: true})).statusCode, 400)
  const third = config()
  third.periods = [third.periods[0], {...third.periods[0], position: 1}]
  t.is(t.throws(() => validateCampaignConfig(third, {create: true})).statusCode, 400)
})

for (const value of ['-1', '1e3', '0.00001', 'Infinity', '10000000000000000', 10, ' 2 ']) {
  test(`la saisie décimale conserve la précision et refuse ${JSON.stringify(value)}`, t => {
    t.is(t.throws(() => validateCampaignDraft('NEEDS', {needs: [{...need(), requestedFlow: value}]}, context())).statusCode, 400)
  })
}

test('un brouillon incomplet est accepté, sa transmission ne l’est pas', t => {
  t.notThrows(() => validateCampaignDraft('NEEDS', {needs: []}, context()))
  t.is(t.throws(() => validateCampaignDraft('NEEDS', {needs: []}, {...context(), complete: true})).statusCode, 400)
  t.notThrows(() => validateCampaignDraft('NEEDS', {needs: [{...need(), requestedFlow: '0', requestedVolume: '0'}]}, {...context(), complete: true}))
})

test('les doublons et les cibles hors délégation sont refusés au niveau des lignes', t => {
  t.is(t.throws(() => validateCampaignDraft('NEEDS', {needs: [need(), need()]}, context())).statusCode, 400)
  t.is(t.throws(() => validateCampaignDraft('NEEDS', {needs: [{...need(), targetId: owner}]}, context())).statusCode, 403)
  t.is(t.throws(() => validateCampaignDraft('NEEDS', {needs: [{...need(), periodId: indexPeriodId}]}, context())).statusCode, 400)
})

test('un relevé exige un compteur explicite autorisé et une date attendue', t => {
  const reading = {targetId, compteurId, readingDate: '2026-06-01', value: '200'}
  t.notThrows(() => validateCampaignDraft('INDEX', {readings: [reading]}, context()))
  t.is(t.throws(() => validateCampaignDraft('INDEX', {readings: [{...reading, compteurId: owner}]}, context())).statusCode, 400)
  t.is(t.throws(() => validateCampaignDraft('INDEX', {readings: [{...reading, readingDate: '2026-06-02'}]}, context())).statusCode, 400)
})

test('sans inventaire, un relevé par point est accepté sans créer de compteur', t => {
  const meterlessContext = {...context(), targets: [{id: targetId, meters: []}]}
  const reading = {targetId, compteurId: null, readingDate: '2026-06-01', value: '200'}
  const draft = validateCampaignDraft('INDEX', {readings: [reading]}, meterlessContext)
  t.is(draft.readings[0].compteurId, null)
  t.is(draft.readings[0].meterConfirmed, undefined)
  t.notThrows(() => validateCampaignDraft('INDEX', {readings: [{...reading, meterConfirmed: true}]}, {...meterlessContext, complete: true}))
  t.is(t.throws(() => validateCampaignDraft('INDEX', {readings: [reading, reading]}, meterlessContext)).statusCode, 400)
  t.is(t.throws(() => validateCampaignDraft('INDEX', {readings: [{...reading, targetId: owner}]}, meterlessContext)).statusCode, 403)
  t.is(t.throws(() => validateCampaignDraft('INDEX', {readings: [{...reading, compteurId}]}, meterlessContext)).statusCode, 400)
  t.is(t.throws(() => validateCampaignDraft('INDEX', {readings: [reading]}, context())).statusCode, 400)
})

test('la réutilisation historique est versionnée et la correction explicitement motivée', t => {
  const reading = {targetId, compteurId, readingDate: '2026-06-01', value: '200', sourceChunkValueId: zone}
  t.is(t.throws(() => validateCampaignDraft('INDEX', {readings: [reading]}, context())).statusCode, 400)
  reading.sourceValueUpdatedAt = '2026-09-08T12:00:00.000Z'
  t.notThrows(() => validateCampaignDraft('INDEX', {readings: [reading]}, context()))
  t.is(t.throws(() => validateCampaignDraft('INDEX', {readings: [{...reading, correctionOfChunkValueId: zone, correctionReason: 'Erreur de saisie'}]}, context())).statusCode, 400)
  delete reading.sourceChunkValueId
  reading.correctionOfChunkValueId = zone
  t.is(t.throws(() => validateCampaignDraft('INDEX', {readings: [reading]}, context())).statusCode, 400)
  reading.correctionReason = 'Erreur de saisie'
  t.notThrows(() => validateCampaignDraft('INDEX', {readings: [reading]}, context()))
})

test('les champs inconnus et les compteurs inventés dans un événement sont refusés', t => {
  t.is(t.throws(() => validateCampaignDraft('NEEDS', {needs: [], status: 'SUBMITTED'}, context())).statusCode, 400)
  t.is(t.throws(() => validateCampaignDraft('INDEX', {meterEvents: [{targetId, type: 'RESET', at: '2026-01-01', previousCompteurId: zone, previousIndex: '200', nextIndex: '0', reason: 'Compteur remis à zéro'}]}, context())).statusCode, 403)
})
