import process from 'node:process'
import {Queue} from 'bullmq'
import Redis from 'ioredis'

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'
const isTest = process.env.NODE_ENV === 'test'

let connection = null

export function getConnection() {
  // En mode test, ne pas créer de connexion Redis réelle
  if (isTest) {
    return null
  }

  connection ||= new Redis(redisUrl, {
    maxRetriesPerRequest: null
  })

  return connection
}

export async function closeConnection() {
  if (connection) {
    await connection.quit()
    connection = null
  }
}

export const JOBS = [
  // Jobs récurrents (planifiés)
  {name: 'sync-updated-dossiers', cron: '0 0 * * * *'}, // Toutes les heures
  {name: 'process-attachments-maintenance', cron: '0 0 3 * * *'}, // 1x/jour à 3h
  {name: 'consolidate-dossiers-maintenance', cron: '0 0 4 * * *'}, // 1x/jour à 4h

  // Jobs atomiques (on-demand, pas de cron)
  {name: 'process-attachment'},
  {name: 'consolidate-dossier'}
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
