import test from 'ava'
import {defaultRepeatStrategy as legacyRepeatStrategy} from 'bullmq-v5'
import {defaultRepeatStrategy} from 'bullmq'
import {JOBS} from '../config.js'
import {startScheduler} from '../scheduler.js'
import {inspectQueueSchedules, assertLegacyMigrationTarget, getCanonicalSchedulerId, migrateLegacySchedule} from '../migration-preflight.js'

function readOnlyRedis({metadata = {}, entries = ['legacy-hash', '123', 'scheduler-id', '456']} = {}) {
  return {
    async zcard() {
      return entries.length / 2
    },
    async zrange() {
      return entries
    },
    async hgetall(key) {
      return key.endsWith('scheduler-id') ? {ic: '1', name: 'tick', every: '5000'} : metadata
    },
    async hget() {
      return '1'
    },
    async llen() {
      return 0
    }
  }
}

async function legacyTarget(queueName = 'campaign-delivery') {
  const report = await inspectQueueSchedules(readOnlyRedis({entries: ['legacy-hash', '123']}), queueName)
  return {
    report,
    legacyKey: 'legacy-hash',
    fingerprint: report.schedules[0].fingerprint,
    schedulerId: getCanonicalSchedulerId(queueName)
  }
}

test('le contrôle distingue les anciens repeat et Job Schedulers sans aucune commande d’écriture', async t => {
  const report = await inspectQueueSchedules(readOnlyRedis(), 'process-declaration')
  t.is(report.queue, 'process-declaration')
  t.is(report.prefix, 'bull')
  t.true(report.paused)
  t.deepEqual(report.schedules.map(schedule => schedule.kind), ['legacy', 'scheduler'])
  t.is(report.schedules[0].fingerprint.length, 64)
})

test('une métadonnée manquante bloque la migration v6 au lieu de déclarer la file sûre', async t => {
  const report = await inspectQueueSchedules(readOnlyRedis({entries: ['x:with:many:colon:segments', '123']}), 'pull-updated-data')
  t.is(report.schedules[0].kind, 'legacy')
})

test('les empreintes changent dès que la définition de la planification change', async t => {
  const before = await inspectQueueSchedules(readOnlyRedis({metadata: {every: '1000'}}), 'process-declaration')
  const after = await inspectQueueSchedules(readOnlyRedis({metadata: {every: '2000'}}), 'process-declaration')
  t.not(before.schedules[0].fingerprint, after.schedules[0].fingerprint)
})

test('une migration refuse une file active, non suspendue, une empreinte ancienne ou un identifiant existant', async t => {
  const target = await legacyTarget()
  t.throws(() => assertLegacyMigrationTarget({...target.report, paused: false}, target), {message: /pause/})
  t.throws(() => assertLegacyMigrationTarget({...target.report, active: 1}, target), {message: /active/})
  t.throws(() => assertLegacyMigrationTarget(target.report, {...target, fingerprint: 'stale'}), {message: /changé/})
  t.throws(() => assertLegacyMigrationTarget(target.report, {...target, schedulerId: 'scheduler-id'}), {message: /identifiant.*doit être/})
  t.throws(() => assertLegacyMigrationTarget({
    ...target.report,
    schedules: [...target.report.schedules, {key: target.schedulerId, kind: 'scheduler'}]
  }, target), {message: /existe déjà/})
})

function legacyQueue(events, {creationError, missingJob = false, bounded = false, repeat = {every: 1000}} = {}) {
  return {
    async getRepeatableJobs() {
      return [{key: 'legacy-hash'}]
    },
    async getJob() {
      return missingJob
        ? undefined
        : {
          name: 'legacy-job', data: {opaque: 'preserved'},
          opts: {attempts: 3, backoff: {type: 'exponential', delay: 5000}, jobId: 'generated-id', delay: 300,
            repeat: {...repeat, count: 7, ...(bounded ? {limit: 10} : {})}}
        }
    },
    async upsertJobScheduler(id, repeat, template) {
      events.push({action: 'create', id, repeat, template})
      if (creationError) {
        throw creationError
      }
    },
    async getJobScheduler(id) {
      return {key: id}
    },
    async removeRepeatableByKey(key) {
      events.push({action: 'remove', key})
      return true
    }
  }
}

test('la migration préserve nom, données et tentatives puis retire seulement la définition ciblée', async t => {
  const events = []
  const result = await migrateLegacySchedule({...await legacyTarget(), queue: legacyQueue(events)})
  t.true(result.migrated)
  t.deepEqual(events, [
    {action: 'create', id: 'campaign-delivery', repeat: {every: 1000}, template: {
      name: 'legacy-job', data: {opaque: 'preserved'}, opts: {attempts: 3, backoff: {type: 'exponential', delay: 5000}}
    }},
    {action: 'remove', key: 'legacy-hash'}
  ])
})

test('les identifiants canoniques suivent les crons API et le contrat de l’orchestrateur', t => {
  for (const job of JOBS) {
    if (job.cron) {
      t.is(getCanonicalSchedulerId(job.name), job.name)
    } else {
      t.throws(() => getCanonicalSchedulerId(job.name), {message: /migration manuelle/})
    }
  }

  t.is(getCanonicalSchedulerId('pull-updated-data'), 'pull-updated-data-daily')
  t.throws(() => getCanonicalSchedulerId('unknown'), {message: /migration manuelle/})
})

test('une cible ambiguë est refusée avant toute écriture de conversion', async t => {
  const target = await legacyTarget()
  const scenarios = [
    {...target, schedulerId: 'migrated-campaign-delivery'},
    {...target, report: {...target.report, queue: 'process-declaration'}},
    {...target, report: {...target.report, schedules: [...target.report.schedules, {key: 'another-legacy', kind: 'legacy'}]}},
    {...target, legacyKey: target.schedulerId, report: {...target.report, schedules: [
      {...target.report.schedules[0], key: target.schedulerId}
    ]}}
  ]
  await Promise.all(scenarios.map(async scenario => {
    const events = []
    await t.throwsAsync(migrateLegacySchedule({...scenario, queue: legacyQueue(events)}))
    t.deepEqual(events, [])
  }))
})

for (const repeat of [
  {pattern: '0 9 * * *', utc: true},
  {pattern: '0 9 * * *', utc: true, tz: 'Europe/Paris'},
  {pattern: '0 9 * * *', utc: false, tz: 'Europe/Paris'}
]) {
  test(`la conversion retire utc et préserve sa priorité historique : ${JSON.stringify(repeat)}`, async t => {
    const events = []
    await migrateLegacySchedule({...await legacyTarget(), queue: legacyQueue(events, {repeat})})
    const converted = events[0].repeat
    t.false(Object.hasOwn(converted, 'utc'))
    t.is(converted.tz, repeat.utc ? 'UTC' : repeat.tz)
    const now = Date.parse('2026-09-11T00:00:00Z')
    t.is(defaultRepeatStrategy(now, converted), legacyRepeatStrategy(now, repeat))
  })
}

test('le redémarrage du vrai scheduler API conserve une seule planification après conversion', async t => {
  const events = []
  const target = await legacyTarget()
  const job = JOBS.find(job => job.name === target.report.queue)
  await migrateLegacySchedule({...target, queue: legacyQueue(events, {repeat: {pattern: job.cron, tz: job.tz}})})
  const created = events[0]
  const queues = new Map([[target.report.queue, new Set([created.id])]])
  await startScheduler(queueName => {
    if (!queues.has(queueName)) {
      queues.set(queueName, new Set())
    }

    return {async upsertJobScheduler(id) {
      queues.get(queueName).add(id)
    }}
  })
  t.deepEqual([...queues.get(target.report.queue)], [target.schedulerId])
})

test('la conversion du cron orchestrateur conserve son identifiant canonique', async t => {
  const events = []
  const target = await legacyTarget('pull-updated-data')
  await migrateLegacySchedule({...target, queue: legacyQueue(events)})
  t.is(events[0].id, 'pull-updated-data-daily')
})

test('aucune suppression si la création échoue, si les données manquent ou si le nombre de passages est borné', async t => {
  const target = await legacyTarget()
  await Promise.all([{creationError: new Error('unavailable')}, {missingJob: true}, {bounded: true}].map(async options => {
    const events = []
    await t.throwsAsync(migrateLegacySchedule({...target, queue: legacyQueue(events, options)}))
    t.false(events.some(event => event.action === 'remove'))
  }))
})
