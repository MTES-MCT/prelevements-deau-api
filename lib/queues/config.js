import {Queue} from 'bullmq'
import {getRedis} from './redis.js'

export function getConnection() {
  return getRedis()
}

export const JOBS = [
  {name: 'process-declaration'}
]

const queueOptions = {
  defaultJobOptions: {
    removeOnComplete: true, // Supprimer les jobs réussis
    removeOnFail: false, // Garder les jobs en erreur
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000
    }
  }
}

export function getQueue(name) {
  const conn = getConnection()
  if (!conn) {
    return null
  }

  return new Queue(name, {connection: conn, ...queueOptions})
}
