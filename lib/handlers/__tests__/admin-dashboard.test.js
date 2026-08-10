import test from 'ava'

import {
  buildAdminDashboardDailyActivity,
  getAdminDashboardData,
  getAdminDashboardPeriod
} from '../admin-dashboard.js'
import {getReplayableDeclarationsWhere} from '../../services/replayable-declarations.js'

const NOW = new Date('2026-08-10T12:30:00.000Z')

test('getAdminDashboardPeriod utilise le mois en cours par défaut', t => {
  const period = getAdminDashboardPeriod({now: NOW})

  t.is(period.days, 10)
  t.is(period.startDate, '2026-08-01')
  t.is(period.endDate, '2026-08-10')
  t.is(period.startInstant.toISOString(), '2026-07-31T22:00:00.000Z')
  t.is(period.endExclusive.toISOString(), '2026-08-10T22:00:00.000Z')
})

test('getAdminDashboardPeriod applique le fuseau de Paris en été comme en hiver', t => {
  const summer = getAdminDashboardPeriod({
    startDate: '2026-07-01',
    endDate: '2026-07-01',
    now: NOW
  })
  const winter = getAdminDashboardPeriod({
    startDate: '2026-01-01',
    endDate: '2026-01-01',
    now: NOW
  })

  t.is(summer.startInstant.toISOString(), '2026-06-30T22:00:00.000Z')
  t.is(summer.endExclusive.toISOString(), '2026-07-01T22:00:00.000Z')
  t.is(winter.startInstant.toISOString(), '2025-12-31T23:00:00.000Z')
  t.is(winter.endExclusive.toISOString(), '2026-01-01T23:00:00.000Z')
})

test('getAdminDashboardPeriod valide les plages personnalisées', t => {
  const period = getAdminDashboardPeriod({
    startDate: '2026-01-01',
    endDate: '2026-08-10',
    now: NOW
  })

  t.is(period.days, 222)
  const invalidPeriods = [
    {startDate: '2026-08-01'},
    {startDate: '2026-02-30', endDate: '2026-03-01'},
    {startDate: '2026-08-11', endDate: '2026-08-12'},
    {startDate: '2026-08-10', endDate: '2026-08-01'},
    {startDate: '2025-08-09', endDate: '2026-08-10'}
  ]

  for (const invalidPeriod of invalidPeriods) {
    t.is(t.throws(() => getAdminDashboardPeriod({...invalidPeriod, now: NOW})).status, 400)
  }
})

test('buildAdminDashboardDailyActivity complète les jours sans activité', t => {
  const period = getAdminDashboardPeriod({
    startDate: '2026-08-04',
    endDate: '2026-08-10',
    now: NOW
  })
  const daily = buildAdminDashboardDailyActivity([
    {
      date: '2026-08-04',
      declarations: 3,
      manualDeclarations: 1,
      spreadsheetDeclarations: 2,
      otherDeclarations: 0,
      failed: 1
    },
    {
      date: '2026-08-10',
      declarations: 2,
      manualDeclarations: 2,
      spreadsheetDeclarations: 0,
      otherDeclarations: 0,
      failed: 0
    }
  ], period)

  t.is(daily.length, 7)
  t.deepEqual(daily[0], {
    date: '2026-08-04',
    declarations: 3,
    manualDeclarations: 1,
    spreadsheetDeclarations: 2,
    otherDeclarations: 0,
    failed: 1
  })
  t.deepEqual(daily[1], {
    date: '2026-08-05',
    declarations: 0,
    manualDeclarations: 0,
    spreadsheetDeclarations: 0,
    otherDeclarations: 0,
    failed: 0
  })
  t.deepEqual(daily[6], {
    date: '2026-08-10',
    declarations: 2,
    manualDeclarations: 2,
    spreadsheetDeclarations: 0,
    otherDeclarations: 0,
    failed: 0
  })
})

test('getReplayableDeclarationsWhere conserve la règle partagée et son seuil de quinze minutes', t => {
  const where = getReplayableDeclarationsWhere({now: NOW})

  t.deepEqual(where.files, {some: {}})
  t.deepEqual(where.source, {is: null})
  t.deepEqual(where.OR[0].processingStatus.in, ['COMPLETED', 'FAILED'])
  t.is(where.OR[1].createdAt.lt.toISOString(), '2026-08-10T12:15:00.000Z')
})

test('getAdminDashboardData sépare les métriques datées de l’état actuel', async t => {
  let telemetryQuery
  const client = {
    async $queryRaw() {
      return [
        {
          date: '2026-08-09',
          declarations: 6,
          manualDeclarations: 2,
          spreadsheetDeclarations: 3,
          otherDeclarations: 1,
          failed: 1
        },
        {
          date: '2026-08-10',
          declarations: 4,
          manualDeclarations: 3,
          spreadsheetDeclarations: 1,
          otherDeclarations: 0,
          failed: 1
        }
      ]
    },
    source: {
      async groupBy(query) {
        telemetryQuery = query

        return [
          {status: 'COMPLETED', _count: {_all: 17}},
          {status: 'FAILED', _count: {_all: 2}}
        ]
      }
    },
    declaration: {
      async count({where}) {
        return where.processingStatus ? 3 : 5
      }
    },
    declarationNotificationRun: {
      async aggregate({where}) {
        if (where.scheduledFor) {
          return {
            _sum: {
              sentCount: 12,
              failedCount: 2
            }
          }
        }

        return {
          _count: {_all: 2},
          _sum: {failedCount: 3}
        }
      }
    }
  }

  const data = await getAdminDashboardData({
    startDate: '2026-08-04',
    endDate: '2026-08-10',
    now: NOW,
    client
  })

  t.deepEqual(data.metrics, {
    declarationsReceived: 10,
    manualDeclarationsReceived: 5,
    spreadsheetDeclarationsReceived: 4,
    otherDeclarationsReceived: 1,
    declarationsFailed: 2,
    telemetryTransmissionsReceived: 19,
    telemetryTransmissionsFailed: 2,
    notificationRecipientsSent: 12,
    notificationRecipientsFailed: 2
  })
  t.deepEqual(telemetryQuery.by, ['status'])
  t.deepEqual(telemetryQuery.where.OR, [
    {type: 'API'},
    {declaration: {is: {dataSourceType: 'API'}}}
  ])
  t.is(telemetryQuery.where.createdAt.gte.toISOString(), '2026-08-03T22:00:00.000Z')
  t.is(telemetryQuery.where.createdAt.lt.toISOString(), '2026-08-10T22:00:00.000Z')
  t.deepEqual(data.currentStatus, {
    declarationsInProgress: 3,
    replayableDeclarations: 5,
    notificationRuns: {
      count: 2,
      failedRecipients: 3
    }
  })
  t.deepEqual(data.period, {
    startDate: '2026-08-04',
    endDate: '2026-08-10',
    days: 7
  })
  t.is(data.activity.daily.at(-1).declarations, 4)
  t.is(data.activity.daily.at(-1).manualDeclarations, 3)
})
