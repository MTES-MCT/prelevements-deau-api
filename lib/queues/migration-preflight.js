import {createHash} from 'node:crypto'
import {JOBS} from './config.js'

const MAX_SCHEDULES = 10_000

// Only these locally authored messages may be printed by the maintenance CLI.
export class QueueMigrationSafetyError extends Error {}

export function getCanonicalSchedulerId(queueName) {
  if (JOBS.some(job => job.name === queueName && job.cron)) {
    return queueName
  }

  // External contract: the orchestration scheduler uses `${job.name}-daily`.
  if (queueName === 'pull-updated-data') {
    return `${queueName}-daily`
  }

  throw new QueueMigrationSafetyError('Cette file ne possède pas de planification applicative connue : migration manuelle nécessaire.')
}

// Both APIs share :repeat. Only Job Schedulers store an iteration counter (ic).
// Read Redis directly: constructing a BullMQ Queue would update its metadata.
export async function inspectQueueSchedules(redis, queueName, prefix = 'bull') {
  const baseKey = `${prefix}:${queueName}`
  const count = await redis.zcard(`${baseKey}:repeat`)
  if (count > MAX_SCHEDULES) {
    throw new QueueMigrationSafetyError(`Trop de planifications pour inspecter ${queueName} en une fois.`)
  }

  const entries = await redis.zrange(`${baseKey}:repeat`, 0, -1, 'WITHSCORES')
  const schedules = []
  for (let index = 0; index < entries.length; index += 2) {
    const key = entries[index]
    const next = entries[index + 1]
    // Sequential reads keep this maintenance command from flooding a shared Redis.
    // eslint-disable-next-line no-await-in-loop -- Bounded, read-only maintenance scan.
    const metadata = await redis.hgetall(`${baseKey}:repeat:${key}`)
    const kind = Object.hasOwn(metadata, 'ic') ? 'scheduler' : 'legacy'
    const fingerprint = createHash('sha256').update(JSON.stringify({
      queueName, prefix, key, next,
      metadata: Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right))
    })).digest('hex')
    schedules.push({key, next: Number(next), kind, fingerprint})
  }

  const [paused, active] = await Promise.all([
    redis.hget(`${baseKey}:meta`, 'paused'),
    redis.llen(`${baseKey}:active`)
  ])
  return {queue: queueName, prefix, paused: paused === '1', active, schedules}
}

export function assertLegacyMigrationTarget(report, {legacyKey, fingerprint, schedulerId}) {
  if (!report.paused || report.active !== 0) {
    throw new QueueMigrationSafetyError('La file doit être en pause, sans tâche active, et ses producteurs arrêtés.')
  }

  const schedule = report.schedules.find(entry => entry.key === legacyKey)
  if (!schedule || schedule.kind !== 'legacy' || schedule.fingerprint !== fingerprint) {
    throw new QueueMigrationSafetyError('La planification a changé : refaire le contrôle avant toute migration.')
  }

  const canonicalId = getCanonicalSchedulerId(report.queue)
  if (schedulerId !== canonicalId) {
    throw new QueueMigrationSafetyError(`L’identifiant du Job Scheduler doit être ${canonicalId}, comme au démarrage de l’application.`)
  }

  if (report.schedules.some(entry => entry.key === canonicalId)) {
    throw new QueueMigrationSafetyError('L’identifiant applicatif existe déjà : migration manuelle nécessaire, aucune conversion automatique.')
  }

  if (report.schedules.length !== 1) {
    throw new QueueMigrationSafetyError('Plusieurs planifications existent dans cette file : migration ambiguë, aucune conversion automatique.')
  }

  return schedule
}

// Must execute with BullMQ 5, before the first BullMQ 6 worker is deployed.
// Creation comes first: on failure the old definition is never removed.
export async function migrateLegacySchedule({queue, report, legacyKey, fingerprint, schedulerId}) {
  const schedule = assertLegacyMigrationTarget(report, {legacyKey, fingerprint, schedulerId})
  const definitions = await queue.getRepeatableJobs()
  const definition = definitions.find(entry => entry.key === legacyKey)
  const job = await queue.getJob(`repeat:${legacyKey}:${schedule.next}`)
  if (!definition || !job || !job.opts?.repeat) {
    throw new QueueMigrationSafetyError('Définition ou prochaine tâche introuvable : migration automatique refusée.')
  }

  const {repeat} = job.opts
  const options = {...job.opts}
  for (const field of ['repeat', 'jobId', 'delay', 'timestamp', 'prevMillis']) {
    delete options[field]
  }

  const repeatOptions = {...repeat}
  for (const field of ['key', 'jobId', 'count', 'offset', 'immediately', 'utc']) {
    delete repeatOptions[field]
  }

  // cron-parser v4 gave utc:true precedence over tz; v5 no longer reads utc.
  if (repeat.utc === true) {
    repeatOptions.tz = 'UTC'
  }

  // Finite schedules need human review to preserve the exact number of remaining runs.
  if (repeatOptions.limit || repeatOptions.startDate || repeat.immediately || repeat.offset) {
    throw new QueueMigrationSafetyError('Planification bornée ou décalée : migration manuelle nécessaire, aucune suppression.')
  }

  if (!repeatOptions.every && !repeatOptions.pattern) {
    throw new QueueMigrationSafetyError('Fréquence de planification inconnue : aucune suppression.')
  }

  await queue.upsertJobScheduler(schedulerId, repeatOptions, {name: job.name, data: job.data, opts: options})
  const created = await queue.getJobScheduler(schedulerId)
  if (!created || created.key !== schedulerId) {
    throw new QueueMigrationSafetyError('Nouveau Job Scheduler non confirmé : ancienne planification conservée, garder la file en pause.')
  }

  const removed = await queue.removeRepeatableByKey(legacyKey)
  if (!removed) {
    throw new QueueMigrationSafetyError('Ancienne planification non retirée : garder la file en pause et contrôler les deux définitions.')
  }

  return {queue: report.queue, schedulerId, migrated: true}
}
