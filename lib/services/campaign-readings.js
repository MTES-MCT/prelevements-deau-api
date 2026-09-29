import {meterHash, scaledDecimal} from './meter-core.js'

export const CAMPAIGN_READING_DATES = ['2025-10-31', '2026-06-01', '2026-10-31']
export const CAMPAIGN_MANUAL_PROVIDER = 'manual-collection'

export function campaignMeterReadings(meter) {
  return [
    {date: CAMPAIGN_READING_DATES[0], value: meter.offSeason.indexStart, usageId: meter.offSeason.usageId},
    {date: CAMPAIGN_READING_DATES[1], value: meter.offSeason.indexEnd, usageId: meter.offSeason.usageId},
    {date: CAMPAIGN_READING_DATES[2], value: meter.season.indexEnd, usageId: meter.season.usageId}
  ]
}

export function campaignMeterFingerprint(meter) {
  return meterHash({compteurId: meter.compteurId, readings: campaignMeterReadings(meter)
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
