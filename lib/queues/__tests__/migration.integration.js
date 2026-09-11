import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import {Queue as LegacyQueue} from 'bullmq-v5'
import {Queue} from 'bullmq'
import IORedis from 'ioredis'
import {inspectQueueSchedules, getCanonicalSchedulerId, migrateLegacySchedule} from '../migration-preflight.js'

function disposableRedisConnection() {
  const url = new URL(process.env.REDIS_URL ?? '')
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.port === '56391'
  const ci = process.env.CI === 'true' && ['127.0.0.1', 'localhost', 'redis'].includes(url.hostname)
    && ['', '6379'].includes(url.port)
  if (process.env.NODE_ENV !== 'test' || url.protocol !== 'redis:' || url.pathname !== '/0'
    || url.search || url.hash || (!local && !ci)) {
    throw new Error('La migration de test exige le Redis jetable dédié, base 0.')
  }

  return {host: url.hostname, port: Number(url.port || 6379), db: 0, protocol: 2, maxRetriesPerRequest: null}
}

const integration = process.env.QUEUE_INTEGRATION_TESTS === '1' ? test.serial : test.skip

for (const queueName of ['campaign-delivery', 'pull-updated-data']) {
  integration(`Redis réel : migration repeat v5 → scheduler v6 sans perte ni doublon (${queueName})`, async t => {
    const connection = disposableRedisConnection()
    const prefix = `ple-security-migration-${randomUUID()}`
    const options = {connection, prefix}
    const redis = new IORedis(connection)
    const legacyQueue = new LegacyQueue(queueName, options)
    const upgradedQueue = new Queue(queueName, options)
    t.teardown(async () => {
      try {
        // Only the UUID-prefixed fixture queue is deleted, never an application queue.
        await legacyQueue.obliterate({force: true})
      } finally {
        await Promise.all([legacyQueue.close(), upgradedQueue.close(), redis.quit()])
      }
    })
    const pattern = '0 0 3 * * *'
    const data = {declarationId: 'synthetic-migration'}
    const backoff = {type: 'exponential', delay: 1000}
    await legacyQueue.add('daily', data, {repeat: {pattern, tz: 'Europe/Paris'}, attempts: 3, backoff})
    await legacyQueue.pause()
    const before = await inspectQueueSchedules(redis, queueName, prefix)
    t.true(before.paused)
    t.is(before.active, 0)
    t.is(before.schedules.length, 1)
    const legacy = before.schedules[0]
    t.is(legacy.kind, 'legacy')
    const schedulerId = getCanonicalSchedulerId(queueName)
    const result = await migrateLegacySchedule({
      queue: legacyQueue, report: before, legacyKey: legacy.key, fingerprint: legacy.fingerprint, schedulerId
    })
    t.true(result.migrated)
    const after = await inspectQueueSchedules(redis, queueName, prefix)
    t.is(after.schedules.length, 1)
    t.is(after.schedules[0].kind, 'scheduler')
    t.is(after.schedules[0].next, legacy.next)
    const scheduler = await upgradedQueue.getJobScheduler(schedulerId)
    t.is(scheduler.name, 'daily')
    t.is(scheduler.pattern, pattern)
    t.is(scheduler.tz, 'Europe/Paris')
    const jobs = await upgradedQueue.getJobs(['delayed'])
    t.is(jobs.length, 1)
    t.deepEqual(jobs[0].data, data)
    t.is(jobs[0].opts.attempts, 3)
    t.deepEqual(jobs[0].opts.backoff, backoff)
  })
}
