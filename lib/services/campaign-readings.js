import {meterHash, scaledDecimal, decimalString} from './meter-core.js'

export const CAMPAIGN_READING_DATES = ['2025-11-01', '2026-05-31', '2026-10-31']
export const CAMPAIGN_MANUAL_PROVIDER = 'manual-collection'
export const METER_CHANGE_REPORTED = 'METER_CHANGE_REPORTED'

export function normalizedCampaignMeterChange(meter) {
  return {meterChanged: meter.meterChanged === true, meterChangeReason: meter.meterChangeReason?.trim() || ''}
}

function indexDifference(start, end) {
  try {
    if (!['string', 'number'].includes(typeof start) || !['string', 'number'].includes(typeof end)) return null
    const difference = scaledDecimal(end) - scaledDecimal(start)
    return difference < 0n ? null : difference
  } catch {
    return null
  }
}

const sumKnown = values => values.some(value => value !== null)
  ? values.reduce((sum, value) => sum + (value ?? 0n), 0n) : null

// Campaign results describe the submitted questionnaire. They do not allocate
// or publish physical consumption and never depend on provider observations.
export function campaignDeclaredVolumeUnits(data) {
  const meters = Array.isArray(data?.meters) ? data.meters : []
  const periods = meters.map(meter => ({
    offSeason: indexDifference(meter?.offSeason?.indexStart, meter?.offSeason?.indexEnd),
    season: indexDifference(meter?.offSeason?.indexEnd, meter?.season?.indexEnd)
  }))
  const completePeriod = key => periods.length && periods.every(period => period[key] !== null)
    ? sumKnown(periods.map(period => period[key])) : null
  const offSeason = completePeriod('offSeason')
  const season = completePeriod('season')
  return {offSeason, season, total: sumKnown([offSeason, season]), partial: offSeason === null || season === null}
}

export function campaignVolumeNumbers(volumes) {
  return {...volumes, ...Object.fromEntries(['offSeason', 'season', 'total']
    .map(key => [key, volumes[key] === null ? null : Number(decimalString(volumes[key]))]))}
}

export function sumCampaignDeclaredVolumes(submittedData) {
  const volumes = submittedData.map(data => campaignDeclaredVolumeUnits(data))
  return campaignVolumeNumbers({
    ...Object.fromEntries(['offSeason', 'season', 'total'].map(key => [key, sumKnown(volumes.map(row => row[key]))])),
    partial: volumes.some(row => row.partial)
  })
}

export function campaignMeterChanges(data) {
  return (data?.meters ?? []).filter(meter => meter.meterChanged === true).map(meter => ({
    compteurId: meter.compteurId ?? null, serialNumber: meter.serialNumber ?? null, meterChangeReason: meter.meterChangeReason ?? ''
  }))
}

export function campaignMeterReadings(meter) {
  return [
    {date: CAMPAIGN_READING_DATES[0], value: meter.offSeason.indexStart, usageId: meter.offSeason.usageId},
    {date: CAMPAIGN_READING_DATES[1], value: meter.offSeason.indexEnd, usageId: meter.offSeason.usageId},
    {date: CAMPAIGN_READING_DATES[2], value: meter.season.indexEnd, usageId: meter.season.usageId}
  ]
}

export function campaignMeterFingerprint(meter) {
  const change = normalizedCampaignMeterChange(meter)
  return meterHash({compteurId: meter.compteurId, ...(change.meterChanged || change.meterChangeReason ? change : {}), readings: campaignMeterReadings(meter)
    .map(row => ({...row, value: scaledDecimal(row.value).toString()}))})
}

export function campaignIndexFingerprint(meter) {
  return meterHash(campaignMeterReadings(meter).map(row => scaledDecimal(row.value).toString()))
}

export function campaignMeterIndicesDecrease(meter) {
  const readings = campaignMeterReadings(meter).map(row => scaledDecimal(row.value))
  return readings.some((value, index) => index > 0 && value < readings[index - 1])
}

export function campaignPublicationIssue(code, compteurId, message) {
  return {code, compteurId, message}
}
