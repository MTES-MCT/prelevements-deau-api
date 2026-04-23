import {Queue} from 'bullmq'
import {getRedis} from './redis.js'

const queues = new Map()

export function getConnection() {
  return getRedis()
}

export const JOBS = [
  {name: 'process-declaration'},
  {name: 'process-api-import'}
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
