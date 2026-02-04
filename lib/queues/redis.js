import process from 'node:process'
import IORedis from 'ioredis'
import * as Sentry from '@sentry/node'
import fs from 'node:fs'
import path from 'node:path'

const isTest = process.env.NODE_ENV === 'test'

let redis

export function getRedis() {
  if (redis) {
    return redis
  }

  const url = process.env.REDIS_URL || 'redis://localhost:6379'

  const redisTlsCaFilePath = process.env.REDIS_TLS_CA_FILE_PATH

  const options = {
    retryStrategy: times => Math.min(15_000, 250 * (2 ** times)),
    maxRetriesPerRequest: null,
    lazyConnect: true
  }

  if (redisTlsCaFilePath) {
    options.tls = {
      ca: fs.readFileSync(
        path.resolve(process.cwd(), redisTlsCaFilePath),
        'utf8'
      )
    }
  }

  redis = new IORedis(url, options)

  if (!isTest) {
    redis.on('ready', () => console.log('✅ Redis ready'))
    redis.on('reconnecting', () => console.log('🔁 Redis reconnecting...'))
    redis.on('error', err => {
      console.warn('❌ Redis error:', err?.message || err)
      Sentry.captureException(err)
    })
  }

  return redis
}

export async function waitForRedis() {
  if (isTest) {
    return
  }

  const r = getRedis()

  try {
    await r.connect()
  } catch {}

  if (r.status === 'ready') {
    return
  }

  await new Promise((resolve, reject) => {
    const onReady = () => {
      cleanup()
      resolve()
    }

    const onError = err => {
      cleanup()
      reject(err)
    }

    const cleanup = () => {
      r.off('ready', onReady)
      r.off('error', onError)
    }

    r.once('ready', onReady)
    r.once('error', onError)
  })
}
