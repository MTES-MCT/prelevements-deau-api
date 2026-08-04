import {randomUUID} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import process from 'node:process'

const REQUEST_ID_PATTERN = /^[\w.-]{1,100}$/
const UUID_SEGMENT_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i
const NUMERIC_SEGMENT_PATTERN = /^\d+$/
const DEFAULT_SLOW_REQUEST_MS = 1000

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

export function requestPerformanceMiddleware(request, response, next) {
  const startedAt = performance.now()
  const requestId = resolveRequestId(request.get('x-request-id'))
  const originalWriteHead = response.writeHead
  let serverTimingWritten = false

  request.requestId = requestId
  response.setHeader('X-Request-Id', requestId)
  response.setHeader('Timing-Allow-Origin', request.get('origin') || '*')

  response.writeHead = function (...args) {
    if (!serverTimingWritten && !response.headersSent) {
      const durationMs = performance.now() - startedAt
      const existingServerTiming = response.getHeader('Server-Timing')
      const apiTiming = `api;dur=${durationMs.toFixed(1)}`

      response.setHeader(
        'Server-Timing',
        existingServerTiming ? `${existingServerTiming}, ${apiTiming}` : apiTiming
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

    const routePath = request.route?.path
      ? `${request.baseUrl || ''}${request.route.path}`
      : request.path

    console.log('[API_PERF]', JSON.stringify({
      requestId,
      method: request.method,
      route: normalizeRequestPath(routePath),
      statusCode: response.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      responseBytes: Number(response.getHeader('Content-Length')) || undefined
    }))
  })

  next()
}
