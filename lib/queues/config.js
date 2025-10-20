import process from 'node:process'
import {Queue} from 'bullmq'
import Redis from 'ioredis'

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'

export const connection = new Redis(redisUrl, {
  maxRetriesPerRequest: null
})

export const JOBS = [
  {name: 'sync-updated-dossiers', cron: '0 0 * * * *'},
  {name: 'process-attachments', cron: '0 * * * * *'},
  {name: 'consolidate-dossiers', cron: '0 * * * * *'}
]

export function getQueue(name) {
  return new Queue(name, {connection})
}
