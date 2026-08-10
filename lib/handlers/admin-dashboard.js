import createHttpError from 'http-errors'
import Joi from 'joi'

import {prisma} from '../../db/prisma.js'
import {getReplayableDeclarationsWhere} from '../services/replayable-declarations.js'

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAX_PERIOD_DAYS = 366
const IN_PROGRESS_STATUSES = ['CREATED', 'UPLOADED', 'QUEUED', 'PROCESSING']
const PROBLEM_NOTIFICATION_STATUSES = ['FAILED', 'PARTIAL_FAILURE', 'BLOCKED']
const PARIS_TIME_ZONE = 'Europe/Paris'

const querySchema = Joi.object({
  startDate: Joi.string().pattern(DATE_KEY_PATTERN),
  endDate: Joi.string().pattern(DATE_KEY_PATTERN)
}).and('startDate', 'endDate')

function addUtcDays(value, days) {
  const date = new Date(value)
  date.setUTCDate(date.getUTCDate() + days)
  return date
}

function formatUtcDateKey(value) {
  return value.toISOString().slice(0, 10)
}

function getParisDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: PARIS_TIME_ZONE,
    year: 'numeric'
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))

  return `${values.year}-${values.month}-${values.day}`
}

function getTimeZoneOffset(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone,
    year: 'numeric'
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  const localTimeAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  )

  return localTimeAsUtc - date.getTime()
}

function getParisDayStart(dateValue) {
  const utcMidnight = new Date(dateValue)
  const firstEstimate = new Date(
    utcMidnight.getTime() - getTimeZoneOffset(utcMidnight, PARIS_TIME_ZONE)
  )

  return new Date(
    utcMidnight.getTime() - getTimeZoneOffset(firstEstimate, PARIS_TIME_ZONE)
  )
}

function parseDateKey(value) {
  if (!DATE_KEY_PATTERN.test(value)) {
    throw createHttpError(400, 'Période du tableau de bord invalide.')
  }

  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))

  if (formatUtcDateKey(date) !== value) {
    throw createHttpError(400, 'Période du tableau de bord invalide.')
  }

  return date
}

export function getAdminDashboardPeriod({startDate, endDate, now = new Date()} = {}) {
  if (Boolean(startDate) !== Boolean(endDate)) {
    throw createHttpError(400, 'Les dates de début et de fin doivent être renseignées ensemble.')
  }

  const today = getParisDateKey(now)
  const resolvedStartDate = startDate ?? `${today.slice(0, 7)}-01`
  const resolvedEndDate = endDate ?? today
  const startDateValue = parseDateKey(resolvedStartDate)
  const endDateValue = parseDateKey(resolvedEndDate)

  if (resolvedStartDate > resolvedEndDate) {
    throw createHttpError(400, 'La date de début doit précéder la date de fin.')
  }

  if (resolvedEndDate > today) {
    throw createHttpError(400, 'La période du tableau de bord ne peut pas inclure de date future.')
  }

  const days = Math.round((endDateValue - startDateValue) / 86_400_000) + 1

  if (days > MAX_PERIOD_DAYS) {
    throw createHttpError(400, 'La période du tableau de bord ne peut pas dépasser un an.')
  }

  return {
    startDate: resolvedStartDate,
    endDate: resolvedEndDate,
    days,
    startDateValue,
    startInstant: getParisDayStart(startDateValue),
    endExclusive: getParisDayStart(addUtcDays(endDateValue, 1))
  }
}

export function buildAdminDashboardDailyActivity(rows, period) {
  const rowsByDate = new Map(rows.map(row => [String(row.date), row]))

  return Array.from({length: period.days}, (_, index) => {
    const date = formatUtcDateKey(addUtcDays(period.startDateValue, index))
    const row = rowsByDate.get(date)

    return {
      date,
      declarations: Number(row?.declarations ?? 0),
      manualDeclarations: Number(row?.manualDeclarations ?? 0),
      spreadsheetDeclarations: Number(row?.spreadsheetDeclarations ?? 0),
      otherDeclarations: Number(row?.otherDeclarations ?? 0),
      failed: Number(row?.failed ?? 0)
    }
  })
}

function sumDailyActivity(rows, field) {
  return rows.reduce((sum, row) => sum + Number(row[field] ?? 0), 0)
}

async function getDailyActivityRows(period, client) {
  return client.$queryRaw`
    SELECT
      (declaration."createdAt" AT TIME ZONE 'Europe/Paris')::date::text AS date,
      COUNT(*)::int AS declarations,
      COUNT(*) FILTER (
        WHERE declaration."dataSourceType"::text = 'MANUAL'
      )::int AS "manualDeclarations",
      COUNT(*) FILTER (
        WHERE declaration."dataSourceType"::text = 'SPREADSHEET'
      )::int AS "spreadsheetDeclarations",
      COUNT(*) FILTER (
        WHERE COALESCE(declaration."dataSourceType"::text, 'NONE') NOT IN ('MANUAL', 'SPREADSHEET')
      )::int AS "otherDeclarations",
      COUNT(*) FILTER (WHERE declaration."processingStatus" = 'FAILED')::int AS failed
    FROM "Declaration" AS declaration
    LEFT JOIN "Source" AS source ON source."declarationId" = declaration.id
    WHERE declaration."createdAt" >= ${period.startInstant}
      AND declaration."createdAt" < ${period.endExclusive}
      AND COALESCE(source.type::text, '') <> 'API'
      AND COALESCE(declaration."dataSourceType"::text, '') <> 'API'
    GROUP BY (declaration."createdAt" AT TIME ZONE 'Europe/Paris')::date
    ORDER BY (declaration."createdAt" AT TIME ZONE 'Europe/Paris')::date
  `
}

function summarizeTelemetryStatusCounters(rows) {
  const summary = {received: 0, failed: 0}

  for (const row of rows) {
    const count = Number(row._count?._all ?? 0)

    summary.received += count

    if (row.status === 'FAILED') {
      summary.failed += count
    }
  }

  return summary
}

export async function getAdminDashboardData({
  startDate,
  endDate,
  now = new Date(),
  client = prisma
} = {}) {
  const period = getAdminDashboardPeriod({startDate, endDate, now})
  const notificationPeriodWhere = {
    scheduledFor: {
      gte: period.startInstant,
      lt: period.endExclusive
    }
  }
  const telemetryPeriodWhere = {
    createdAt: {
      gte: period.startInstant,
      lt: period.endExclusive
    },
    OR: [
      {type: 'API'},
      {
        declaration: {
          is: {dataSourceType: 'API'}
        }
      }
    ]
  }

  const [
    dailyActivityRows,
    telemetryStatusCounters,
    declarationsInProgress,
    replayableDeclarations,
    notificationRunCounters,
    problemNotificationRuns
  ] = await Promise.all([
    getDailyActivityRows(period, client),
    client.source.groupBy({
      by: ['status'],
      where: telemetryPeriodWhere,
      _count: {_all: true}
    }),
    client.declaration.count({
      where: {
        processingStatus: {in: IN_PROGRESS_STATUSES}
      }
    }),
    client.declaration.count({
      where: getReplayableDeclarationsWhere({now})
    }),
    client.declarationNotificationRun.aggregate({
      where: notificationPeriodWhere,
      _sum: {
        sentCount: true,
        failedCount: true
      }
    }),
    client.declarationNotificationRun.aggregate({
      where: {
        status: {in: PROBLEM_NOTIFICATION_STATUSES}
      },
      _count: {_all: true},
      _sum: {failedCount: true}
    })
  ])
  const telemetry = summarizeTelemetryStatusCounters(telemetryStatusCounters)

  return {
    generatedAt: now.toISOString(),
    period: {
      startDate: period.startDate,
      endDate: period.endDate,
      days: period.days
    },
    metrics: {
      declarationsReceived: sumDailyActivity(dailyActivityRows, 'declarations'),
      manualDeclarationsReceived: sumDailyActivity(dailyActivityRows, 'manualDeclarations'),
      spreadsheetDeclarationsReceived: sumDailyActivity(dailyActivityRows, 'spreadsheetDeclarations'),
      otherDeclarationsReceived: sumDailyActivity(dailyActivityRows, 'otherDeclarations'),
      declarationsFailed: sumDailyActivity(dailyActivityRows, 'failed'),
      telemetryTransmissionsReceived: telemetry.received,
      telemetryTransmissionsFailed: telemetry.failed,
      notificationRecipientsSent: Number(notificationRunCounters._sum?.sentCount ?? 0),
      notificationRecipientsFailed: Number(notificationRunCounters._sum?.failedCount ?? 0)
    },
    activity: {
      daily: buildAdminDashboardDailyActivity(dailyActivityRows, period)
    },
    currentStatus: {
      declarationsInProgress: Number(declarationsInProgress),
      replayableDeclarations: Number(replayableDeclarations),
      notificationRuns: {
        count: Number(problemNotificationRuns._count?._all ?? 0),
        failedRecipients: Number(problemNotificationRuns._sum?.failedCount ?? 0)
      }
    }
  }
}

export async function getAdminDashboardHandler(req, res) {
  const {error, value} = querySchema.validate(req.query, {
    abortEarly: false,
    stripUnknown: true
  })

  if (error) {
    throw createHttpError(400, 'Période du tableau de bord invalide.')
  }

  const data = await getAdminDashboardData({
    startDate: value.startDate,
    endDate: value.endDate
  })

  res.status(200).send({success: true, data})
}
