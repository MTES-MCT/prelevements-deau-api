import moment from 'moment'

export const MIN_TIME_STEP_MINUTES = 15

export const TEMPORAL_PERIOD_ERRORS = Object.freeze({
  INVALID_DURATION: 'INVALID_DURATION',
  INVALID_PERIOD_START: 'INVALID_PERIOD_START',
  INVALID_PERIOD_END: 'INVALID_PERIOD_END',
  NON_POSITIVE_PERIOD: 'NON_POSITIVE_PERIOD'
})

const FIXED_DURATION_UNIT_MINUTES = Object.freeze({
  minute: 1,
  hour: 60,
  day: 24 * 60,
  week: 7 * 24 * 60
})

function parseDuration(duration) {
  if (typeof duration !== 'string') {
    return null
  }

  const normalized = duration.trim().toLowerCase().replaceAll('_', ' ')
  const match = normalized.match(/^(\d+)\s*(minute|minutes|hour|hours|day|days|week|weeks|month|months|quarter|quarters|year|years)$/)
  if (!match) {
    return null
  }

  const amount = Number.parseInt(match[1], 10)
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return null
  }

  return {
    amount,
    unit: match[2].replace(/s$/, '')
  }
}

export function normalizeTemporalStart(value) {
  const date = moment.utc(value, moment.ISO_8601, true)
  if (!date.isValid()) {
    return null
  }

  return date.seconds(0).milliseconds(0).toDate()
}

export function parseDurationToMinutes(duration) {
  const parsedDuration = parseDuration(duration)
  if (!parsedDuration) {
    return null
  }

  const unitMinutes = FIXED_DURATION_UNIT_MINUTES[parsedDuration.unit]
  if (!unitMinutes) {
    return null
  }

  const durationMinutes = parsedDuration.amount * unitMinutes

  return Number.isSafeInteger(durationMinutes) ? durationMinutes : null
}

export function computePeriodEnd(periodStart, duration) {
  const parsedDuration = parseDuration(duration)
  const start = moment.utc(periodStart)

  if (!parsedDuration || !start.isValid()) {
    return null
  }

  const durationMinutes = parseDurationToMinutes(duration)
  if (durationMinutes) {
    return start.add(durationMinutes, 'minutes').toDate()
  }

  if (parsedDuration.unit === 'month') {
    return start.add(parsedDuration.amount, 'months').toDate()
  }

  if (parsedDuration.unit === 'quarter') {
    return start.add(parsedDuration.amount * 3, 'months').toDate()
  }

  if (parsedDuration.unit === 'year') {
    return start.add(parsedDuration.amount, 'years').toDate()
  }

  return null
}

export function computeInstantPeriodEnd(periodStart) {
  return computePeriodEnd(periodStart, `${MIN_TIME_STEP_MINUTES} minutes`)
}

export function resolveTemporalPeriod(value, duration) {
  const rawPeriodStart = value?.periodStart ?? value?.period_start ?? value?.date
  const rawPeriodEnd = value?.periodEnd ?? value?.period_end
  const periodStart = normalizeTemporalStart(rawPeriodStart)
  const hasExplicitPeriodEnd = rawPeriodEnd !== undefined && rawPeriodEnd !== null

  if (!periodStart) {
    return {
      error: TEMPORAL_PERIOD_ERRORS.INVALID_PERIOD_START,
      hasExplicitPeriodEnd,
      periodEnd: null,
      periodStart: null
    }
  }

  const periodEnd = hasExplicitPeriodEnd
    ? normalizeTemporalStart(rawPeriodEnd)
    : computePeriodEnd(periodStart, duration)

  if (!periodEnd) {
    return {
      error: hasExplicitPeriodEnd
        ? TEMPORAL_PERIOD_ERRORS.INVALID_PERIOD_END
        : TEMPORAL_PERIOD_ERRORS.INVALID_DURATION,
      hasExplicitPeriodEnd,
      periodEnd: null,
      periodStart
    }
  }

  if (periodEnd.getTime() <= periodStart.getTime()) {
    return {
      error: TEMPORAL_PERIOD_ERRORS.NON_POSITIVE_PERIOD,
      hasExplicitPeriodEnd,
      periodEnd,
      periodStart
    }
  }

  return {
    error: null,
    hasExplicitPeriodEnd,
    periodEnd,
    periodStart
  }
}

export function isAlignedOnDiscreteStep(date, stepMinutes = MIN_TIME_STEP_MINUTES) {
  return date.getUTCSeconds() === 0
    && date.getUTCMilliseconds() === 0
    && date.getUTCMinutes() % stepMinutes === 0
}

export function isDurationAlignedOnDiscreteStep(duration, stepMinutes = MIN_TIME_STEP_MINUTES) {
  const parsedDuration = parseDuration(duration)
  if (!parsedDuration) {
    return false
  }

  const durationMinutes = parseDurationToMinutes(duration)
  if (durationMinutes) {
    return durationMinutes % stepMinutes === 0
  }

  return ['month', 'quarter', 'year'].includes(parsedDuration.unit)
}
