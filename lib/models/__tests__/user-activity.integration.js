import {randomUUID} from 'node:crypto'
import process from 'node:process'

import {PrismaPg} from '@prisma/adapter-pg'
import prismaPackage from '@prisma/client'
import test from 'ava'
import pgPackage from 'pg'

import {createUserActivityRecorder, USER_ACTIVITY_COLLECTION_ID} from '../user-activity.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'

const {PrismaClient} = prismaPackage
const {Pool} = pgPackage
const DATABASE_URL = process.env.USER_ACTIVITY_TEST_DATABASE_URL ?? process.env.PUBLIC_STATS_TEST_DATABASE_URL
const NOW = new Date('2026-09-14T10:00:00Z')
const STATE_WHERE = {id: USER_ACTIVITY_COLLECTION_ID}

let client
let pool

function defineIntegrationTest(title, implementation) {
  if (DATABASE_URL) {
    test.serial(title, implementation)
    return
  }

  // eslint-disable-next-line ava/no-skip-test -- requires an explicitly provided disposable PostgreSQL database.
  test.skip(title, implementation)
}

test.before(() => {
  if (!DATABASE_URL) {
    return
  }

  requireDisposableDatabase(DATABASE_URL)
  pool = new Pool({connectionString: DATABASE_URL, max: 12})
  client = new PrismaClient({adapter: new PrismaPg(pool)})
})

test.after.always(async () => {
  if (client) {
    await client.$disconnect()
    await pool.end()
  }
})

async function withFixtures(operation) {
  // Les tests concurrents utilisent de vraies transactions indépendantes : ne
  // lancer ce fichier qu’en concurrency=1 avec les autres intégrations globales.
  const previousState = await client.userActivityCollectionState.findUnique({where: STATE_WHERE})
  await client.userActivityCollectionState.deleteMany({where: STATE_WHERE})
  const user = await client.user.create({
    data: {email: `activity.${randomUUID()}@example.test`, role: 'DECLARANT'},
    select: {id: true, role: true}
  })
  try {
    return await operation({userId: user.id, role: user.role})
  } finally {
    await client.user.deleteMany({where: {id: user.id}})
    await client.userActivityCollectionState.deleteMany({where: STATE_WHERE})
    if (previousState) {
      await client.userActivityCollectionState.create({data: previousState})
    }
  }
}

defineIntegrationTest('activité PostgreSQL : des processus concurrents créent un seul marqueur et un seul état', async t => {
  await withFixtures(async user => {
    const results = await Promise.all(Array.from({length: 12}, () => {
      const record = createUserActivityRecorder({client, now: () => NOW})
      return record(user)
    }))
    t.true(results.every(result => result.month === '2026-09'))
    t.is(await client.userMonthlyActivity.count({where: {userId: user.userId}}), 1)
    const state = await client.userActivityCollectionState.findUnique({where: STATE_WHERE})
    t.deepEqual(state, {id: USER_ACTIVITY_COLLECTION_ID, startedAt: NOW})

    const recordAfterRestart = createUserActivityRecorder({client, now: () => new Date('2026-09-15T10:00:00Z')})
    await recordAfterRestart({...user, role: 'ADMIN'})
    const activity = await client.userMonthlyActivity.findUnique({where: {month_userId: {month: '2026-09', userId: user.userId}}})
    t.is(activity.role, 'DECLARANT')
    t.deepEqual(activity.createdAt, NOW)
    t.deepEqual(await client.userActivityCollectionState.findUnique({where: STATE_WHERE}), state)
  })
})

defineIntegrationTest('activité PostgreSQL : le changement de mois ajoute un marqueur sans déplacer le début de collecte', async t => {
  await withFixtures(async user => {
    let now = NOW
    const record = createUserActivityRecorder({client, now: () => now})
    await record(user)
    now = new Date('2026-09-30T22:00:00Z')
    await record({...user, role: 'INSTRUCTOR'})
    const activities = await client.userMonthlyActivity.findMany({
      where: {userId: user.userId},
      select: {month: true, role: true},
      orderBy: {month: 'asc'}
    })
    t.deepEqual(activities, [
      {month: '2026-09', role: 'DECLARANT'},
      {month: '2026-10', role: 'INSTRUCTOR'}
    ])
    const state = await client.userActivityCollectionState.findUnique({where: STATE_WHERE})
    t.deepEqual(state.startedAt, NOW)
  })
})

defineIntegrationTest('activité PostgreSQL : un marqueur refusé annule aussi la création du début de collecte', async t => {
  await withFixtures(async user => {
    const record = createUserActivityRecorder({client, now: () => NOW})
    await t.throwsAsync(record({...user, userId: randomUUID()}), {code: 'P2003'})
    t.is(await client.userActivityCollectionState.findUnique({where: STATE_WHERE}), null)
    await record(user)
    t.is(await client.userMonthlyActivity.count({where: {userId: user.userId}}), 1)
  })
})

defineIntegrationTest('activité PostgreSQL : les contraintes SQL protègent le mois, l’unicité et la suppression du compte', async t => {
  await withFixtures(async user => {
    const record = createUserActivityRecorder({client, now: () => NOW})
    await record(user)
    await t.throwsAsync(client.userMonthlyActivity.create({data: {...user, month: '2026-09'}}), {code: 'P2002'})
    await t.throwsAsync(client.userMonthlyActivity.create({data: {...user, month: '2026-13'}}))
    t.is(await client.userMonthlyActivity.count({where: {userId: user.userId}}), 1)

    await client.user.delete({where: {id: user.userId}})
    t.is(await client.userMonthlyActivity.count({where: {userId: user.userId}}), 0)
    const state = await client.userActivityCollectionState.findUnique({where: STATE_WHERE})
    t.deepEqual(state.startedAt, NOW)
  })
})
