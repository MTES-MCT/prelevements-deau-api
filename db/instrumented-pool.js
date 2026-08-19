import {performance} from 'node:perf_hooks'
import process from 'node:process'

import pgPkg from 'pg'

import {recordDatabasePoolAcquisition} from '../lib/util/request-performance.js'

const {Pool} = pgPkg

const DEFAULT_DATABASE_POOL_MAX = 5
const DEFAULT_DATABASE_POOL_SLOW_WAIT_MS = 100

function readNonNegativeInteger(value, fallback) {
  return /^\d+$/.test(value || '') ? Number.parseInt(value, 10) : fallback
}

export function readDatabasePoolMax() {
  const poolMax = readNonNegativeInteger(
    process.env.DATABASE_POOL_MAX,
    DEFAULT_DATABASE_POOL_MAX
  )

  return poolMax > 0 ? poolMax : DEFAULT_DATABASE_POOL_MAX
}

export function readDatabasePoolSlowWaitMs() {
  return readNonNegativeInteger(
    process.env.DATABASE_POOL_SLOW_WAIT_MS,
    DEFAULT_DATABASE_POOL_SLOW_WAIT_MS
  )
}

function roundDuration(durationMs) {
  return Math.round(durationMs * 10) / 10
}

async function finalizePoolConnection(connection, recordAcquisition) {
  try {
    const client = await connection
    recordAcquisition()
    return client
  } catch (error) {
    recordAcquisition(error)
    throw error
  }
}

export class InstrumentedPool extends Pool {
  connect(callback) {
    const startedAt = performance.now()
    const waitingCountAtStart = this.waitingCount

    const recordAcquisition = error => {
      const durationMs = performance.now() - startedAt
      const waitingCount = Math.max(waitingCountAtStart, this.waitingCount)
      const requestMetadata = recordDatabasePoolAcquisition({
        durationMs,
        failed: Boolean(error),
        idleCount: this.idleCount,
        totalCount: this.totalCount,
        waitingCount
      })

      if (durationMs < readDatabasePoolSlowWaitMs()) {
        return
      }

      console.log('[DB_POOL_PERF]', JSON.stringify({
        ...requestMetadata,
        durationMs: roundDuration(durationMs),
        failed: Boolean(error),
        idleCount: this.idleCount,
        poolMax: this.options.max,
        totalCount: this.totalCount,
        waitingCount
      }))
    }

    if (typeof callback === 'function') {
      return super.connect((error, client, done) => {
        recordAcquisition(error)
        callback(error, client, done)
      })
    }

    return finalizePoolConnection(super.connect(), recordAcquisition)
  }
}
