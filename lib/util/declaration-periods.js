import moment from 'moment'

export const DECLARATION_PERIOD_TYPES = new Set(['month', 'week'])

export function getMonthKey(date = new Date()) {
  const year = date.getUTCFullYear()
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0')

  return `${year}-${month}`
}

export function getWeekKey(date = new Date()) {
  const week = moment.utc(date)

  return `${week.isoWeekYear()}-W${String(week.isoWeek()).padStart(2, '0')}`
}

export function parseMonthKey(value) {
  const monthKey = String(Array.isArray(value) ? value[0] : value ?? '')

  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    return null
  }

  const month = Number(monthKey.slice(5, 7))

  return month >= 1 && month <= 12 ? monthKey : null
}

export function getMonthStart(monthKey) {
  const [year, month] = monthKey.split('-').map(Number)

  return new Date(Date.UTC(year, month - 1, 1))
}

export function getNextMonthStart(monthKey) {
  const [year, month] = monthKey.split('-').map(Number)

  return new Date(Date.UTC(year, month, 1))
}

export function getWeekStart(weekKey) {
  const year = Number(weekKey.slice(0, 4))
  const week = Number(weekKey.slice(6, 8))

  return moment.utc([year, 0, 4])
    .isoWeek(week)
    .startOf('isoWeek')
    .startOf('day')
    .toDate()
}

export function getNextWeekStart(weekKey) {
  return moment.utc(getWeekStart(weekKey)).add(1, 'week').toDate()
}

export function parseWeekKey(value) {
  const weekKey = String(Array.isArray(value) ? value[0] : value ?? '')

  if (!/^\d{4}-W\d{2}$/.test(weekKey)) {
    return null
  }

  const week = Number(weekKey.slice(6, 8))

  if (week < 1 || week > 53) {
    return null
  }

  return getWeekKey(getWeekStart(weekKey)) === weekKey ? weekKey : null
}

export function parseDeclarationPeriodType(value) {
  const periodType = String(Array.isArray(value) ? value[0] : value ?? '')

  return DECLARATION_PERIOD_TYPES.has(periodType) ? periodType : 'month'
}

export function getMonthKeysBetween(startDate, endDate) {
  if (!startDate || !endDate) {
    return []
  }

  const monthKeys = []
  const start = getMonthStart(getMonthKey(startDate))
  const end = getMonthStart(getMonthKey(endDate)).getTime()

  for (
    let cursor = start.getTime();
    cursor <= end;
    cursor = Date.UTC(new Date(cursor).getUTCFullYear(), new Date(cursor).getUTCMonth() + 1, 1)
  ) {
    monthKeys.push(getMonthKey(new Date(cursor)))
  }

  return monthKeys
}

export function getWeekKeysBetween(startDate, endDate) {
  if (!startDate || !endDate) {
    return []
  }

  const weekKeys = []
  const cursor = moment.utc(getWeekStart(getWeekKey(startDate)))
  const end = moment.utc(getWeekStart(getWeekKey(endDate))).valueOf()

  while (cursor.valueOf() <= end) {
    weekKeys.push(getWeekKey(cursor.toDate()))
    cursor.add(1, 'week')
  }

  return weekKeys
}

export function getDeclarationPeriodKey(periodType, date = new Date()) {
  return periodType === 'week'
    ? getWeekKey(date)
    : getMonthKey(date)
}

export function parseDeclarationPeriodKey(value, periodType) {
  return periodType === 'week'
    ? parseWeekKey(value)
    : parseMonthKey(value)
}

export function getDeclarationPeriodStart(periodType, periodKey) {
  return periodType === 'week'
    ? getWeekStart(periodKey)
    : getMonthStart(periodKey)
}

export function getNextDeclarationPeriodStart(periodType, periodKey) {
  return periodType === 'week'
    ? getNextWeekStart(periodKey)
    : getNextMonthStart(periodKey)
}

export function getDeclarationPeriodKeysBetween(periodType, startDate, endDate) {
  return periodType === 'week'
    ? getWeekKeysBetween(startDate, endDate)
    : getMonthKeysBetween(startDate, endDate)
}

export function getPreviousDeclarationPeriodKey(periodType, date = new Date()) {
  const cursor = moment.utc(date)

  if (periodType === 'week') {
    return getWeekKey(cursor.subtract(1, 'week').toDate())
  }

  return getMonthKey(cursor.subtract(1, 'month').toDate())
}

export function getDeclarationPeriodEnd(periodType, periodKey) {
  return new Date(getNextDeclarationPeriodStart(periodType, periodKey).getTime() - 1)
}

export function getDeclarationPeriodLabel(periodType, periodKey) {
  const start = getDeclarationPeriodStart(periodType, periodKey)
  const end = getDeclarationPeriodEnd(periodType, periodKey)

  if (periodType === 'week') {
    return `Du ${start.toLocaleDateString('fr-FR', {timeZone: 'UTC'})} au ${end.toLocaleDateString('fr-FR', {timeZone: 'UTC'})}`
  }

  return start.toLocaleDateString('fr-FR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  })
}
