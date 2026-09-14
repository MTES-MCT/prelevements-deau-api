import test from 'ava'

import {createUserActivityRecorder, getUserActivityMonth} from '../user-activity.js'

const NOW = new Date('2026-09-14T10:00:00Z')
const USER = {userId: '11111111-1111-4111-8111-111111111111', role: 'DECLARANT'}

function createClient({beforeCommit} = {}) {
  const states = new Map()
  const activities = new Map()
  const transactions = []
  const client = {
    async $transaction(callback) {
      const operations = []
      transactions.push(operations)
      const result = await callback({
        userActivityCollectionState: {
          async createMany(options) {
            operations.push({model: 'state', ...options})
          }
        },
        userMonthlyActivity: {
          async createMany(options) {
            operations.push({model: 'activity', ...options})
          }
        }
      })
      await beforeCommit?.()
      for (const operation of operations) {
        const {data} = operation
        const records = operation.model === 'state' ? states : activities
        const key = operation.model === 'state' ? data.id : `${data.month}:${data.userId}`
        if (!records.has(key)) {
          records.set(key, data)
        }
      }

      return result
    }
  }
  return {client, states, activities, transactions}
}

test('le mois de collecte suit Europe/Paris, y compris aux changements d’année et d’heure', t => {
  t.is(getUserActivityMonth(new Date('2026-09-30T21:59:59Z')), '2026-09')
  t.is(getUserActivityMonth(new Date('2026-09-30T22:00:00Z')), '2026-10')
  t.is(getUserActivityMonth(new Date('2026-12-31T23:00:00Z')), '2027-01')
  t.is(getUserActivityMonth(new Date('2026-03-31T22:00:00Z')), '2026-04')
})

test('le premier signal crée le début de collecte et le marqueur dans la même transaction', async t => {
  const {client, states, activities, transactions} = createClient()
  const record = createUserActivityRecorder({client, now: () => NOW})

  t.deepEqual(await record(USER), {month: '2026-09'})
  t.deepEqual([...states.values()], [{id: 'active-users', startedAt: NOW}])
  t.deepEqual([...activities.values()], [{...USER, month: '2026-09', createdAt: NOW}])
  t.is(transactions.length, 1)
  t.true(transactions[0].every(operation => operation.skipDuplicates === true))
})

test('une session persistante ne produit qu’une écriture par utilisateur et par mois', async t => {
  const {client, transactions, activities} = createClient()
  let now = NOW
  const record = createUserActivityRecorder({client, now: () => now})

  await record(USER)
  await record(USER)
  await record({...USER, role: 'ADMIN'})
  t.is(transactions.length, 1)
  t.is([...activities.values()][0].role, 'DECLARANT')

  now = new Date('2026-09-30T22:00:00Z')
  t.deepEqual(await record({...USER, role: 'ADMIN'}), {month: '2026-10'})
  t.is(transactions.length, 2)
  t.is(activities.size, 2)
})

test('les appels simultanés pour un même utilisateur sont coalescés jusqu’au commit', async t => {
  let release
  const gate = new Promise(resolve => {
    release = resolve
  })
  const {client, transactions} = createClient({beforeCommit: () => gate})
  const record = createUserActivityRecorder({client, now: () => NOW})
  const calls = [record(USER), record(USER), record(USER)]

  t.is(transactions.length, 1)
  release()
  t.deepEqual(await Promise.all(calls), [
    {month: '2026-09'}, {month: '2026-09'}, {month: '2026-09'}
  ])
  await record(USER)
  t.is(transactions.length, 1)
})

test('une panne ne confirme aucun signal et permet une nouvelle tentative', async t => {
  let unavailable = true
  const {client, states, activities, transactions} = createClient({
    beforeCommit() {
      if (unavailable) {
        throw new Error('Base indisponible')
      }
    }
  })
  const record = createUserActivityRecorder({client, now: () => NOW})

  const failed = await Promise.allSettled([record(USER), record(USER)])
  t.true(failed.every(result => result.status === 'rejected'))
  t.is(transactions.length, 1)
  t.is(states.size, 0)
  t.is(activities.size, 0)

  unavailable = false
  t.deepEqual(await record(USER), {month: '2026-09'})
  t.is(transactions.length, 2)
  t.is(states.size, 1)
  t.is(activities.size, 1)
})

test('le cache borné ne modifie ni le premier rôle ni le début de collecte après éviction', async t => {
  const {client, states, activities, transactions} = createClient()
  let now = NOW
  const record = createUserActivityRecorder({client, now: () => now, maxCacheEntries: 1})
  await record(USER)
  now = new Date('2026-09-15T10:00:00Z')
  await record({userId: '22222222-2222-4222-8222-222222222222', role: 'ADMIN'})
  await record({...USER, role: 'INSTRUCTOR'})

  t.is(transactions.length, 3)
  t.is(activities.size, 2)
  t.is(activities.get(`2026-09:${USER.userId}`).role, 'DECLARANT')
  t.is(states.get('active-users').startedAt, NOW)
})

test('deux processus conservent l’unicité et ne déplacent pas la date de début', async t => {
  const {client, states, activities} = createClient()
  const first = createUserActivityRecorder({client, now: () => NOW})
  const second = createUserActivityRecorder({client, now: () => new Date('2026-09-15T10:00:00Z')})

  await first(USER)
  await second({...USER, role: 'ADMIN'})
  t.is(activities.size, 1)
  t.is([...activities.values()][0].role, 'DECLARANT')
  t.is(states.get('active-users').startedAt, NOW)
})

test('un signal du mois précédent terminé tardivement ne remplit pas le cache du nouveau mois', async t => {
  let release
  const gate = new Promise(resolve => {
    release = resolve
  })
  let held = true
  const {client, transactions} = createClient({beforeCommit: () => held ? gate : undefined})
  let now = NOW
  const record = createUserActivityRecorder({client, now: () => now, maxCacheEntries: 1})
  const previous = record(USER)
  held = false
  now = new Date('2026-09-30T22:00:00Z')
  await record(USER)
  release()
  await previous
  await record(USER)
  t.is(transactions.length, 2)
})
