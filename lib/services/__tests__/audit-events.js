import test from 'ava'

import {
  getAuditRetentionCutoff,
  listAuditEvents,
  parseAuditEventQuery,
  purgeExpiredAuditEvents
} from '../audit-events.js'

const NOW = new Date('2026-08-10T12:30:00.000Z')

test('parseAuditEventQuery applique trente jours et le fuseau de Paris par défaut', t => {
  const filters = parseAuditEventQuery({}, {now: NOW})

  t.is(filters.from, '2026-07-12')
  t.is(filters.to, '2026-08-10')
  t.is(filters.startInstant.toISOString(), '2026-07-11T22:00:00.000Z')
  t.is(filters.endExclusive.toISOString(), '2026-08-10T22:00:00.000Z')
})

test('parseAuditEventQuery gère les vues 24 heures et tout l’historique', t => {
  const last24Hours = parseAuditEventQuery({period: '24h'}, {now: NOW})
  const all = parseAuditEventQuery({period: 'all'}, {now: NOW})

  t.is(last24Hours.startInstant.toISOString(), '2026-08-09T12:30:00.000Z')
  t.is(last24Hours.endExclusive.toISOString(), NOW.toISOString())
  t.is(all.startInstant.toISOString(), '2024-08-10T12:30:00.000Z')
})

test('listAuditEvents combine les filtres et exclut la consultation courante', async t => {
  let countWhere
  let findManyQuery
  const event = {
    id: 'event-1',
    actionType: 'AUTH.LOGOUT',
    actionCategory: 'AUTHENTICATION'
  }
  const client = {
    auditEvent: {
      count({where}) {
        countWhere = where
        return Promise.resolve(1)
      },
      findMany(query) {
        findManyQuery = query
        return Promise.resolve([event])
      }
    },
    $transaction(promises) {
      return Promise.all(promises)
    }
  }
  const result = await listAuditEvents({
    actor: 'samy',
    subject: 'nathalie',
    actionTypes: 'AUTH.LOGOUT',
    outcomes: 'SUCCESS',
    page: 2,
    pageSize: 50
  }, {
    client,
    excludeId: 'current-event',
    now: NOW
  })

  t.deepEqual(countWhere.id, {not: 'current-event'})
  t.deepEqual(countWhere.actionType, {in: ['AUTH.LOGOUT']})
  t.deepEqual(countWhere.outcome, {in: ['SUCCESS']})
  t.is(countWhere.AND.length, 2)
  t.is(findManyQuery.skip, 50)
  t.is(findManyQuery.take, 50)
  t.is(result.items[0].actionLabel, 'Déconnexion')
})

test('purgeExpiredAuditEvents supprime par lots les événements antérieurs à 24 mois', async t => {
  let findCalls = 0
  let receivedCutoff
  const client = {
    auditEvent: {
      async findMany({where}) {
        receivedCutoff = where.occurredAt.lt
        findCalls += 1
        return findCalls === 1 ? [{id: 'one'}, {id: 'two'}] : []
      },
      async deleteMany({where}) {
        t.deepEqual(where.id.in, ['one', 'two'])
        return {count: 2}
      }
    }
  }
  const result = await purgeExpiredAuditEvents({client, now: NOW, batchSize: 2})

  t.is(receivedCutoff.toISOString(), getAuditRetentionCutoff(NOW).toISOString())
  t.is(result.deletedCount, 2)
  t.is(findCalls, 2)
})

test('getAuditRetentionCutoff conserve une date calendaire valide autour des années bissextiles', t => {
  const cutoff = getAuditRetentionCutoff(new Date('2028-02-29T08:15:00.000Z'))

  t.is(cutoff.toISOString(), '2026-02-28T08:15:00.000Z')
})
