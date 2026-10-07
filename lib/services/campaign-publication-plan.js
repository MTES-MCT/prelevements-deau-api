import {meterBusinessDateBoundary, planMeterInterval, scaledDecimal} from './meter-core.js'
import {CAMPAIGN_READING_DATES, campaignMeterReadings} from './campaign-readings.js'

export const CAMPAIGN_VOLUME_BOUNDARIES = CAMPAIGN_READING_DATES.map(date => meterBusinessDateBoundary(date))

// A calendar boundary is never interpolated from neighbouring supplier readings.
export function campaignPublicationCoverage(publications, boundaries = CAMPAIGN_VOLUME_BOUNDARIES) {
  for (let period = 0; period < boundaries.length - 1; period++) {
    let cursor = boundaries[period].getTime()
    const end = boundaries[period + 1].getTime()
    const rows = publications.filter(row => row.periodStart < boundaries[period + 1] && row.periodEnd > boundaries[period])
      .sort((a, b) => a.periodStart - b.periodStart)
    for (const row of rows) {
      if (row.periodStart.getTime() !== cursor || row.periodEnd.getTime() > end) return false
      cursor = row.periodEnd.getTime()
    }
    if (cursor !== end) return false
  }
  return true
}

export function campaignAllocationPlans(meter, stream, allocations, exploitationId, {additive = false} = {}) {
  const readings = campaignMeterReadings(meter).map((reading, index) => ({
    observedAt: CAMPAIGN_VOLUME_BOUNDARIES[index],
    currentRevision: {admissible: true, index: reading.value, streamId: stream.id, mode: 'OFFLINE'}
  }))
  const plans = readings.slice(1).map((end, index) => planMeterInterval(readings[index], end, stream, allocations))
  for (const plan of plans) {
    if (plan.reason) return {reason: plan.reason}
    const group = plan.groups.find(group => group.exploitation.id === exploitationId)
    if (!group) return {reason: 'ATTACHMENT_REVIEW'}
    if (additive && !group.additive) return {reason: 'ADDITIVE_NOT_VALIDATED'}
  }
  return {plans}
}

export function campaignReadingsMatch(meter, readings) {
  return campaignMeterReadings(meter).every((row, index) => {
    const reading = readings.find(reading => reading.observedAt.getTime() === CAMPAIGN_VOLUME_BOUNDARIES[index].getTime())
    return reading?.currentRevision?.admissible === true
      && scaledDecimal(reading.currentRevision.index) === scaledDecimal(row.value)
  })
}
