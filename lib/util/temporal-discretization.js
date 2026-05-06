import moment from 'moment'

export const MIN_TIME_STEP_MINUTES = 15

export function normalizeTemporalStart(value) {
  const date = moment.utc(value, moment.ISO_8601, true)
  if (!date.isValid()) {
    return null
  }

  return date.seconds(0).milliseconds(0).toDate()
}

export function parseDurationToMinutes(duration) {
  if (typeof duration !== 'string') {
    return null
  }

  const normalized = duration.trim().toLowerCase()
  const match = normalized.match(/^(\d+)\s*(minute|minutes|hour|hours|day|days)$/)
  if (!match) {
    return null
  }

  const amount = Number.parseInt(match[1], 10)
  if (!Number.isFinite(amount) || amount <= 0) {
    return null
  }

  const unit = match[2]
  if (unit.startsWith('minute')) {
    return amount
  }

  if (unit.startsWith('hour')) {
    return amount * 60
  }

  if (unit.startsWith('day')) {
    return amount * 24 * 60
  }

  return null
}

export function computePeriodEnd(periodStart, duration, defaultDurationMinutes = MIN_TIME_STEP_MINUTES) {
  const durationMinutes = parseDurationToMinutes(duration) ?? defaultDurationMinutes
  return moment.utc(periodStart).add(durationMinutes, 'minutes').toDate()
}

export function isAlignedOnDiscreteStep(date, stepMinutes = MIN_TIME_STEP_MINUTES) {
  return date.getUTCSeconds() === 0
    && date.getUTCMilliseconds() === 0
    && date.getUTCMinutes() % stepMinutes === 0
}

export function isDurationAlignedOnDiscreteStep(duration, stepMinutes = MIN_TIME_STEP_MINUTES) {
  const durationMinutes = parseDurationToMinutes(duration)
  if (!durationMinutes) {
    return false
  }

  return durationMinutes % stepMinutes === 0
}
