import {meterHash, scaledDecimal} from './meter-core.js'

export const CAMPAIGN_READING_DATES = ['2025-11-01', '2026-05-31', '2026-10-31']
export const CAMPAIGN_MANUAL_PROVIDER = 'manual-collection'
export const METER_CHANGE_REPORTED = 'METER_CHANGE_REPORTED'

export function normalizedCampaignMeterChange(meter) {
  return {meterChanged: meter.meterChanged === true, meterChangeReason: meter.meterChangeReason?.trim() || ''}
}

export function campaignPublicationLabel(response) {
  const issues = response.publicationIssues ?? []
  if (issues.length && issues.every(issue => issue.code === METER_CHANGE_REPORTED)) return 'Non calculé : changement de compteur signalé'
  return {NOT_SUBMITTED: 'Non soumis', PUBLISHED: 'Publié', PENDING_REVIEW: 'En attente de validation'}[response.publicationStatus] ?? response.publicationStatus
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
