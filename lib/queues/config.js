import {Queue} from 'bullmq'
import {getRedis} from './redis.js'

const queues = new Map()

export function getConnection() {
  return getRedis()
}

export const JOBS = [
  {name: 'process-declaration'},
  {name: 'process-api-import'},
  {name: 'process-data-export'},
  {name: 'reconstruct-volumes-from-index-for-point'},
  {name: 'declaration-notification-reminder-week', cron: '0 9 * * 1', tz: 'Europe/Paris'},
  {name: 'declaration-notification-followup-week', cron: '0 17 * * 1', tz: 'Europe/Paris'},
  {name: 'declaration-notification-reminder-month', cron: '0 9 28 * *', tz: 'Europe/Paris'},
  {name: 'declaration-notification-followup-month', cron: '0 9 5 * *', tz: 'Europe/Paris'},
  {name: 'sync-monitoring-station'},
  {name: 'sync-monitoring-stations-realtime', cron: '*/15 * * * *', tz: 'Europe/Paris'},
  {name: 'sync-monitoring-stations-daily', cron: '30 3 * * *', tz: 'Europe/Paris'},
  {name: 'sync-monitoring-stations-full', cron: '0 4 * * 0', tz: 'Europe/Paris'}
]

export const WORKER_JOBS = [
  {name: 'process-api-import'},
  {name: 'process-data-export'},
  {name: 'reconstruct-volumes-from-index-for-point'},
  {name: 'declaration-notification-reminder-week'},
  {name: 'declaration-notification-followup-week'},
  {name: 'declaration-notification-reminder-month'},
  {name: 'declaration-notification-followup-month'},
  {name: 'sync-monitoring-station'},
  {name: 'sync-monitoring-stations-realtime'},
  {name: 'sync-monitoring-stations-daily'},
  {name: 'sync-monitoring-stations-full'}
]

const queueOptions = {
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000
    }
  }
}

export function getQueue(name) {
  if (queues.has(name)) {
    return queues.get(name)
  }

  const conn = getConnection()
  if (!conn) {
    return null
  }

  const queue = new Queue(name, {connection: conn, ...queueOptions})
  queues.set(name, queue)

  return queue
}

export async function closeQueues() {
  await Promise.all(
    [...queues.values()].map(queue => queue.close())
  )
  queues.clear()
}
