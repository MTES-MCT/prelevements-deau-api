import {AsyncLocalStorage} from 'node:async_hooks'
import {Buffer} from 'node:buffer'
import {randomUUID} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import process from 'node:process'

const REQUEST_ID_PATTERN = /^[\w.-]{1,100}$/
const UUID_SEGMENT_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i
const NUMERIC_SEGMENT_PATTERN = /^\d+$/
const PHASE_NAME_PATTERN = /^[a-z][a-z\d_]{0,31}$/
const DEFAULT_SLOW_REQUEST_MS = 1000

const requestPerformanceStorage = new AsyncLocalStorage()

function roundDuration(durationMs) {
  return Math.round(durationMs * 10) / 10
}

function readChunkBytes(chunk, encoding) {
  if (chunk === undefined || chunk === null) {
    return 0
  }

  if (typeof chunk === 'string') {
    return Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined)
  }

  if (Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk)) {
    return chunk.byteLength
  }

  return 0
}

function readContentLength(value) {
  const length = Number(value)
  return Number.isFinite(length) && length >= 0 ? length : undefined
}

function assertPhaseName(name) {
  if (!PHASE_NAME_PATTERN.test(name || '')) {
    throw new TypeError(`Invalid performance phase name: ${name}`)
  }
}

function serializePerformancePhases(context) {
  return Object.fromEntries([...context.phases].map(([name, phase]) => [name, {
    count: phase.count,
    durationMs: roundDuration(phase.durationMs),
    maxDurationMs: roundDuration(phase.maxDurationMs)
  }]))
}

function buildServerTiming(context, durationMs) {
  const timings = [...context.phases].map(([name, phase]) => (
    `${name};dur=${phase.durationMs.toFixed(1)}`
  ))

  timings.push(`api;dur=${durationMs.toFixed(1)}`)
  return timings.join(', ')
}

function resolveMatchedRequestRoute(request) {
  if (!request.route?.path) {
    return undefined
  }

  return normalizeRequestPath(`${request.baseUrl || ''}${request.route.path}`)
}

async function finalizeAsyncPhase(result, name, startedAt) {
  try {
    return await result
  } finally {
    recordRequestPerformancePhase(name, performance.now() - startedAt)
  }
}

export function normalizeRequestPath(path = '/') {
  return path
    .split('?')[0]
    .split('/')
    .map(segment => (
      UUID_SEGMENT_PATTERN.test(segment) || NUMERIC_SEGMENT_PATTERN.test(segment)
        ? ':id'
        : segment
    ))
    .join('/') || '/'
}

export function resolveRequestId(candidate) {
  return REQUEST_ID_PATTERN.test(candidate || '') ? candidate : randomUUID()
}

function readSlowRequestThreshold() {
  const configuredThreshold = Number.parseInt(process.env.API_SLOW_REQUEST_MS, 10)
  return Number.isFinite(configuredThreshold) && configuredThreshold >= 0
    ? configuredThreshold
    : DEFAULT_SLOW_REQUEST_MS
}

export function recordRequestPerformancePhase(name, durationMs) {
  assertPhaseName(name)

  const context = requestPerformanceStorage.getStore()
  if (!context || !Number.isFinite(durationMs) || durationMs < 0) {
    return
  }

  const phase = context.phases.get(name) || {
    count: 0,
    durationMs: 0,
    maxDurationMs: 0
  }

  phase.count++
  phase.durationMs += durationMs
  phase.maxDurationMs = Math.max(phase.maxDurationMs, durationMs)
  context.phases.set(name, phase)
}

export function withRequestPerformancePhase(name, operation) {
  assertPhaseName(name)
  const startedAt = performance.now()

  try {
    const result = operation()
    if (result && typeof result.finally === 'function') {
      return finalizeAsyncPhase(result, name, startedAt)
    }

    recordRequestPerformancePhase(name, performance.now() - startedAt)
    return result
  } catch (error) {
    recordRequestPerformancePhase(name, performance.now() - startedAt)
    throw error
  }
}

export function recordDatabasePoolAcquisition({
  durationMs,
  failed = false,
  idleCount,
  totalCount,
  waitingCount
}) {
  const context = requestPerformanceStorage.getStore()
  if (!context) {
    return undefined
  }

  recordRequestPerformancePhase('db_pool_wait', durationMs)

  const pool = context.databasePool
  pool.acquisitions++
  pool.failures += Number(failed)
  pool.idleCountMin = Math.min(pool.idleCountMin, idleCount)
  pool.totalCountMax = Math.max(pool.totalCountMax, totalCount)
  pool.waitingCountMax = Math.max(pool.waitingCountMax, waitingCount)

  return {
    method: context.method,
    requestId: context.requestId,
    route: resolveMatchedRequestRoute(context.request)
  }
}

export function requestPerformanceMiddleware(request, response, next) {
  const startedAt = performance.now()
  const requestId = resolveRequestId(request.get('x-request-id'))
  const context = {
    databasePool: {
      acquisitions: 0,
      failures: 0,
      idleCountMin: Number.POSITIVE_INFINITY,
      totalCountMax: 0,
      waitingCountMax: 0
    },
    method: request.method,
    phases: new Map(),
    request,
    requestId,
    route: undefined
  }
  const originalEnd = response.end
  const originalSetHeader = response.setHeader
  const originalWrite = response.write
  const originalWriteHead = response.writeHead
  let declaredResponseBytes
  let serverTimingWritten = false
  let transferredBytes = 0

  response.setHeader = function (name, value) {
    if (String(name).toLowerCase() === 'content-length') {
      declaredResponseBytes = readContentLength(value)
    }

    return originalSetHeader.call(this, name, value)
  }

  response.write = function (chunk, encoding, callback) {
    transferredBytes += readChunkBytes(chunk, encoding)
    return originalWrite.call(this, chunk, encoding, callback)
  }

  response.end = function (chunk, encoding, callback) {
    transferredBytes += readChunkBytes(chunk, encoding)
    return originalEnd.call(this, chunk, encoding, callback)
  }

  request.requestId = requestId
  response.setHeader('X-Request-Id', requestId)
  response.setHeader('Timing-Allow-Origin', request.get('origin') || '*')

  response.writeHead = function (...args) {
    if (!serverTimingWritten && !response.headersSent) {
      const durationMs = performance.now() - startedAt
      const existingServerTiming = response.getHeader('Server-Timing')
      const requestTimings = buildServerTiming(context, durationMs)

      response.setHeader(
        'Server-Timing',
        existingServerTiming ? `${existingServerTiming}, ${requestTimings}` : requestTimings
      )
      serverTimingWritten = true
    }

    return originalWriteHead.apply(this, args)
  }

  response.on('finish', () => {
    const durationMs = performance.now() - startedAt
    if (process.env.API_PERF_LOG !== '1' && durationMs < readSlowRequestThreshold()) {
      return
    }

    context.route = resolveMatchedRequestRoute(request) || '/unmatched'

    const responseBytes = declaredResponseBytes
      ?? readContentLength(response.getHeader('Content-Length'))
      ?? transferredBytes
    const phases = serializePerformancePhases(context)
    const databasePool = context.databasePool.acquisitions > 0
      ? {
        acquisitions: context.databasePool.acquisitions,
        failures: context.databasePool.failures,
        idleCountMin: context.databasePool.idleCountMin,
        totalCountMax: context.databasePool.totalCountMax,
        waitingCountMax: context.databasePool.waitingCountMax
      }
      : undefined

    console.log('[API_PERF]', JSON.stringify({
      requestId,
      method: request.method,
      route: context.route,
      statusCode: response.statusCode,
      durationMs: roundDuration(durationMs),
      responseBytes,
      transferredBytes,
      compressionRatio: responseBytes > 0 && transferredBytes < responseBytes
        ? Math.round((transferredBytes / responseBytes) * 1000) / 1000
        : undefined,
      phases: Object.keys(phases).length > 0 ? phases : undefined,
      databasePool
    }))
  })

  requestPerformanceStorage.run(context, next)
}
