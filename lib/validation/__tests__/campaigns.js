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

test('un remplacement accepte une identité de compteur en attente, sans identifiant arbitraire', t => {
  const event = {targetId, type: 'REPLACEMENT', at: '2026-02-01', previousCompteurId: compteurId, nextMeter: {serialNumber: ' Nouveau '}, previousIndex: '200', nextIndex: '0', reason: 'Compteur cassé'}
  const draft = validateCampaignDraft('INDEX', {meterEvents: [event]}, context())
  t.deepEqual(draft.meterEvents[0].nextMeter, {serialNumber: 'Nouveau'})
  for (const changes of [
    {nextMeter: {}},
    {nextMeter: {serialNumber: ''}},
    {nextMeter: {serialNumber: 'x'.repeat(201)}},
    {nextCompteurId: compteurId},
    {type: 'RESET'},
    {at: '2025-10-30'},
    {at: '2026-11-01'},
    {nextMeter: undefined},
    {nextMeter: undefined, nextCompteurId: compteurId}
  ]) {
    t.is(t.throws(() => validateCampaignDraft('INDEX', {meterEvents: [{...event, ...changes}]}, context())).statusCode, 400)
  }

  t.is(t.throws(() => validateCampaignDraft('INDEX', {meterEvents: [event, event]}, context())).statusCode, 400)
  t.notThrows(() => validateCampaignDraft('INDEX', {meterEvents: [{...event, previousIndex: null, nextIndex: null}]}, context()))
})

test('un changement reste dans la période d’affectation du compteur et une remise à zéro garde ce compteur', t => {
  const scoped = {...context(), targets: [{...target, meters: [{compteurId, startDate: '2026-01-01', endDate: '2026-06-01'}]}]}
  const event = {targetId, type: 'RESET', at: '2026-02-01', previousCompteurId: compteurId, previousIndex: '200', nextIndex: '0', reason: 'Remise à zéro'}
  t.notThrows(() => validateCampaignDraft('INDEX', {meterEvents: [event]}, scoped))
  for (const at of ['2025-12-31', '2026-06-02']) {
    t.is(t.throws(() => validateCampaignDraft('INDEX', {meterEvents: [{...event, at}]}, scoped)).statusCode, 400)
  }
})

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

test('les relevés sont strictement chronologiques et les périodes référencent des relevés successifs', t => {
  const reversed = config()
  reversed.indexDates = [...reversed.indexDates].reverse()
  t.is(t.throws(() => validateCampaignConfig(reversed, {create: true})).statusCode, 400)
  const skipped = config()
  skipped.periods[0].endReadingDate = skipped.indexDates.at(-1)
  t.is(t.throws(() => validateCampaignConfig(skipped, {create: true})).statusCode, 400)
})

test('les périodes d’index se suivent sans trou, en conservant leurs bornes civiles historiques', t => {
  const input = config()
  input.periods.push({...input.periods[0], position: 1, startDate: '2026-06-01', endDate: '2026-11-01', startReadingDate: '2026-06-01', endReadingDate: '2026-10-31'})
  t.notThrows(() => validateCampaignConfig(input, {create: true}))
  input.periods[2].startDate = '2026-06-02'
  t.is(t.throws(() => validateCampaignConfig(input, {create: true})).statusCode, 400)
  input.periods[2].startDate = '2026-06-01'
  input.indexDates.splice(2, 0, '2026-09-01')
  input.periods[2].startReadingDate = '2026-09-01'
  t.is(t.throws(() => validateCampaignConfig(input, {create: true})).statusCode, 400)
})

test('la clôture permet de répondre le dernier jour de relevé dans le fuseau de la campagne', t => {
  const input = {...config(), timezone: 'Europe/Paris', closesAt: '2026-10-30T23:00:00.000Z'}
  // Minuit le 31 octobre exclut la totalité du dernier jour demandé.
  t.is(t.throws(() => validateCampaignConfig(input, {create: true})).statusCode, 400)
  input.closesAt = '2026-10-31T23:00:00.000Z'
  t.notThrows(() => validateCampaignConfig(input, {create: true}))
  input.closesAt = '2026-10-31T12:00:00.000Z'
  t.notThrows(() => validateCampaignConfig(input, {create: true}))
  input.closesAt = '2026-10-31T01:00:00.000Z'
  input.timezone = 'America/New_York'
  t.is(t.throws(() => validateCampaignConfig(input, {create: true})).statusCode, 400)
})

test('les relances nécessitent une échéance et restent comprises entre ouverture et dernier jour de réponse', t => {
  const input = {...config(), reminderDays: [14, 3]}
  t.is(t.throws(() => validateCampaignConfig(input, {create: true})).statusCode, 400)
  input.closesAt = '2026-11-15T23:00:00.000Z'
  t.notThrows(() => validateCampaignConfig(input, {create: true}))
  input.opensAt = '2026-10-31T23:00:00.000Z'
  t.notThrows(() => validateCampaignConfig(input, {create: true}))
  input.reminderDays = [15]
  t.is(t.throws(() => validateCampaignConfig(input, {create: true})).statusCode, 400)
  input.reminderDays = [0]
  t.notThrows(() => validateCampaignConfig(input, {create: true}))
  input.opensAt = input.closesAt
  t.is(t.throws(() => validateCampaignConfig(input, {create: true})).statusCode, 400)
})

test('les périodes de besoins ne sont pas contraintes après les relevés ni à se suivre sans interruption', t => {
  const input = config()
  input.periods[1] = {...input.periods[1], startDate: '2026-01-01', endDate: '2026-03-01'}
  input.periods.push({...input.periods[1], position: 1, startDate: '2026-06-01', endDate: '2026-10-01'})
  t.notThrows(() => validateCampaignConfig(input, {create: true}))
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

test('les besoins se transmettent avec le volume seul sans inventer ni effacer un ancien débit', t => {
  const line = {targetId, periodId: needPeriodId, requestedVolume: '0'}
  const draft = validateCampaignDraft('NEEDS', {needs: [line]}, {...context(), complete: true})
  t.deepEqual(draft.needs[0], line)
  t.false(Object.hasOwn(draft.needs[0], 'requestedFlow'))
  const legacy = validateCampaignDraft('NEEDS', {needs: [need()]}, {...context(), complete: true})
  t.is(legacy.needs[0].requestedFlow, '12.5000')
  for (const requestedVolume of ['', undefined]) {
    const error = t.throws(() => validateCampaignDraft('NEEDS', {needs: [{...line, requestedVolume}]}, {...context(), complete: true}))
    t.is(error.statusCode, 400)
    t.false(error.message.includes('débit'))
  }
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
  t.notThrows(() => validateCampaignDraft('INDEX', {readings: [reading]}, {...meterlessContext, complete: true}))
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
