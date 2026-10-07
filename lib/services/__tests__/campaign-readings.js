import test from 'ava'
import {campaignMeterReadings, campaignMeterFingerprint, campaignIndexFingerprint, campaignMeterIndicesDecrease,
  campaignDeclaredVolumeUnits, campaignVolumeNumbers, sumCampaignDeclaredVolumes} from '../campaign-readings.js'

const meter = {
  compteurId: 'synthetic-meter',
  offSeason: {indexStart: '100', indexEnd: '200', usageId: 'off-season'},
  season: {indexEnd: '260', usageId: 'season'}
}

test('les relevés conservent leurs dates et l’usage de chaque période', t => {
  t.deepEqual(campaignMeterReadings(meter), [
    {date: '2025-11-01', value: '100', usageId: 'off-season'},
    {date: '2026-05-31', value: '200', usageId: 'off-season'},
    {date: '2026-10-31', value: '260', usageId: 'season'}
  ])
})

test('un format décimal équivalent ne contredit pas un index déjà validé', t => {
  const formatted = {...meter, offSeason: {...meter.offSeason, indexStart: '100.000', indexEnd: 200}, season: {...meter.season, indexEnd: '260.0'}}
  t.is(campaignIndexFingerprint(formatted), campaignIndexFingerprint(meter))
  t.is(campaignMeterFingerprint(formatted), campaignMeterFingerprint(meter))
})

test('les usages sont propres au bénéficiaire mais font partie de sa validation', t => {
  const changed = {...meter, season: {...meter.season, usageId: 'another-usage'}}
  t.is(campaignIndexFingerprint(changed), campaignIndexFingerprint(meter))
  t.not(campaignMeterFingerprint(changed), campaignMeterFingerprint(meter))
})

test('un compteur à l’arrêt reste valide, une baisse est signalée', t => {
  t.false(campaignMeterIndicesDecrease(meter))
  t.false(campaignMeterIndicesDecrease({...meter, season: {...meter.season, indexEnd: '200'}}))
  t.true(campaignMeterIndicesDecrease({...meter, season: {...meter.season, indexEnd: '199.999'}}))
})

test('le signalement et son motif invalident la publication sans changer les observations physiques', t => {
  const reported = {...meter, meterChanged: true, meterChangeReason: 'Remplacement'}
  t.not(campaignMeterFingerprint(reported), campaignMeterFingerprint(meter))
  t.not(campaignMeterFingerprint({...reported, meterChangeReason: 'Motif corrigé'}), campaignMeterFingerprint(reported))
  t.is(campaignIndexFingerprint(reported), campaignIndexFingerprint(meter))
  t.is(campaignMeterFingerprint({...meter, meterChanged: false, meterChangeReason: ''}), campaignMeterFingerprint(meter))
})

const volumes = meters => campaignVolumeNumbers(campaignDeclaredVolumeUnits({meters}))

test('les volumes du formulaire calculent les écarts soumis même avec changement de compteur', t => {
  t.deepEqual(volumes([{...meter, meterChanged: true, meterChangeReason: 'Remplacement'}]), {
    offSeason: 100, season: 60, total: 160, partial: false
  })
  t.deepEqual(volumes([{offSeason: {indexStart: 0, indexEnd: '0.0000'}, season: {indexEnd: 0}}]), {
    offSeason: 0, season: 0, total: 0, partial: false
  })
})

test('les différences et les sommes de plusieurs compteurs restent exactes à quatre décimales', t => {
  const meters = [
    {offSeason: {indexStart: '9999999999999999.0000', indexEnd: '9999999999999999.0001'}, season: {indexEnd: '9999999999999999.0003'}},
    {offSeason: {indexStart: '0', indexEnd: '0.1'}, season: {indexEnd: '0.3'}}
  ]
  t.deepEqual(volumes(meters), {offSeason: 0.1001, season: 0.2002, total: 0.3003, partial: false})
  t.deepEqual(sumCampaignDeclaredVolumes([
    {meters: [{offSeason: {indexStart: 0, indexEnd: '0.1'}, season: {indexEnd: '0.1'}}]},
    {meters: [{offSeason: {indexStart: 0, indexEnd: '0.2'}, season: {indexEnd: '0.2'}}]}
  ]), {offSeason: 0.3, season: 0, total: 0.3, partial: false})
})

test('une période manquante, invalide ou décroissante reste absente et ne masque pas une autre période calculable', t => {
  for (const indexStart of [undefined, null, '', 'incorrect', '-1', '1.00001', {}, false]) {
    t.deepEqual(volumes([{offSeason: {indexStart, indexEnd: '20'}, season: {indexEnd: '50'}}]), {
      offSeason: null, season: 30, total: 30, partial: true
    })
  }
  t.deepEqual(volumes([{offSeason: {indexStart: '100', indexEnd: '20'}, season: {indexEnd: '50'}, meterChanged: true}]), {
    offSeason: null, season: 30, total: 30, partial: true
  })
  t.deepEqual(volumes([{offSeason: {indexStart: 0, indexEnd: 20}, season: {indexEnd: 10}}]), {
    offSeason: 20, season: null, total: 20, partial: true
  })
  t.deepEqual(volumes([meter, {offSeason: {indexEnd: 0}, season: {indexEnd: 0}}]), {
    offSeason: null, season: 60, total: 60, partial: true
  })
  for (const data of [null, {}, {meters: []}, {meters: 'malformed'}]) {
    t.deepEqual(campaignVolumeNumbers(campaignDeclaredVolumeUnits(data)), {offSeason: null, season: null, total: null, partial: true})
  }
})
