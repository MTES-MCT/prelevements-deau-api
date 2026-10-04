import test from 'ava'
import {campaignMeterReadings, campaignMeterFingerprint, campaignIndexFingerprint, campaignMeterIndicesDecrease} from '../campaign-readings.js'

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
