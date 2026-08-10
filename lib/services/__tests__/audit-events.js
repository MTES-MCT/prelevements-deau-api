import test from 'ava'

import {
  getAuditEventDetail,
  getAuditRetentionCutoff,
  listAuditEvents,
  listResourceAuditHistory,
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
    target: 'Forage principal',
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
  t.is(countWhere.AND.length, 3)
  t.deepEqual(countWhere.AND[2].OR[0], {
    targetLabel: {contains: 'Forage principal', mode: 'insensitive'}
  })
  t.is(findManyQuery.skip, 50)
  t.is(findManyQuery.take, 50)
  t.is(result.items[0].actionLabel, 'Déconnexion')
})

test('getAuditEventDetail retourne les mutations sans requête complémentaire', async t => {
  const eventId = '11111111-1111-4111-8111-111111111111'
  let query
  const client = {
    auditEvent: {
      async findUnique(arguments_) {
        query = arguments_
        return {
          id: eventId,
          actionType: 'POINT.UPDATED',
          actionCategory: 'POINT',
          mutations: [{
            id: 'mutation-1',
            operation: 'UPDATE',
            entityType: 'POINT',
            entityId: 'point-1',
            changedFields: ['name'],
            redactedFields: [],
            metadata: {},
            scopes: []
          }]
        }
      }
    }
  }

  const result = await getAuditEventDetail(eventId, {client})

  t.true(query.include.mutations.include.scopes)
  t.is(result.mutationCount, 1)
  t.is(result.mutations[0].entityType, 'POINT')
})

test('listResourceAuditHistory pagine le diff sans exposer les données réseau', async t => {
  const resourceId = '22222222-2222-4222-8222-222222222222'
  let findManyQuery
  const client = {
    auditMutationScope: {
      count() {
        return Promise.resolve(1)
      },
      findMany(query) {
        findManyQuery = query
        return Promise.resolve([{
          id: 'scope-1',
          auditMutation: {
            id: 'mutation-1',
            occurredAt: NOW,
            operation: 'UPDATE',
            entityType: 'POINT',
            entityId: resourceId,
            entityLabel: 'Forage principal',
            before: {name: 'Ancien nom'},
            after: {name: 'Nouveau nom'},
            changedFields: ['name'],
            redactedFields: [],
            metadata: {},
            auditEvent: {
              actionType: 'POINT.UPDATED',
              actionCategory: 'POINT',
              actorType: 'USER',
              actorUserId: '33333333-3333-4333-8333-333333333333',
              actorServiceAccountId: null,
              actorLabel: 'Agent Test',
              actorEmail: 'agent@example.test',
              effectiveUserId: null,
              effectiveUserLabel: null,
              occurredAt: NOW
            }
          }
        }])
      }
    },
    $transaction(promises) {
      return Promise.all(promises)
    }
  }

  const result = await listResourceAuditHistory({
    query: {page: 1, pageSize: 10},
    resourceId,
    resourceType: 'point',
    user: {id: 'admin-1', role: 'ADMIN'}
  }, {client})

  t.is(findManyQuery.where.resourceType, 'POINT')
  t.is(findManyQuery.where.resourceId, resourceId)
  t.is(result.items[0].actorLabel, 'Agent Test')
  t.is(result.items[0].clientIp, undefined)
  t.is(result.items[0].requestId, undefined)
  t.deepEqual(result.items[0].before, {name: 'Ancien nom'})
})

test('listResourceAuditHistory refuse les comptes déclarants avant de lire la base', async t => {
  const error = await t.throwsAsync(listResourceAuditHistory({
    query: {},
    resourceId: '22222222-2222-4222-8222-222222222222',
    resourceType: 'POINT',
    user: {id: 'declarant-1', role: 'DECLARANT'}
  }, {client: {}}))

  t.is(error.statusCode, 403)
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
