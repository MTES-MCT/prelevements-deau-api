import http from 'node:http'
import {createHash, timingSafeEqual} from 'node:crypto'
import {getEngineVersion, scanStream, ScannerError, MAX_FILE_BYTES} from './clamd.mjs'

function respond(response, status, body) {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    ...(status !== 200 ? {Connection: 'close'} : {}), ...(status === 503 ? {'Retry-After': '30'} : {})})
  response.end(JSON.stringify(body))
}

function uploadLength(request, maxBytes) {
  if (request.headers['content-type'] !== 'application/octet-stream' || request.headers['content-encoding']) {
    throw new ScannerError('UNSUPPORTED_MEDIA_TYPE', 415)
  }
  const declaredLength = request.headers['content-length']
  const expectedBytes = declaredLength === undefined ? undefined : Number(declaredLength)
  if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1)) {
    throw new ScannerError('INVALID_FILE_LENGTH', 400)
  }
  if (expectedBytes > maxBytes) throw new ScannerError('FILE_TOO_LARGE', 413)
  return expectedBytes
}

export function createScannerServer({version = getEngineVersion, scan = scanStream, maxBytes = MAX_FILE_BYTES,
  concurrency = 2, timeoutMs = 120_000, token = process.env.CLAMAV_INVOKE_TOKEN} = {}) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw new Error('A 256-bit invocation token is required')
  const expectedAuthorization = createHash('sha256').update(`Bearer ${token}`).digest()
  let active = 0
  const server = http.createServer(async (request, response) => {
    if (request.url === '/readyz' && request.method === 'GET') {
      try {await version(); respond(response, 200, {status: 'ready'})} catch {respond(response, 503, {status: 'unavailable'})}
      return
    }
    const actualAuthorization = createHash('sha256').update(request.headers.authorization ?? '').digest()
    if (!timingSafeEqual(actualAuthorization, expectedAuthorization)) {
      respond(response, 401, {code: 'UNAUTHORIZED'})
      return
    }
    if (request.url === '/healthz' && request.method === 'GET') {
      try {respond(response, 200, {status: 'ready', ...await version()})} catch {respond(response, 503, {status: 'unavailable'})}
      return
    }
    if (request.url !== '/scan' || request.method !== 'POST') {
      respond(response, 404, {code: 'NOT_FOUND'})
      return
    }
    let expectedBytes
    try {expectedBytes = uploadLength(request, maxBytes)} catch (error) {
      respond(response, error.status, {code: error.code})
      return
    }
    if (active >= concurrency) {respond(response, 503, {code: 'SCANNER_BUSY'}); return}
    active++
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const abort = () => controller.abort()
    request.once('aborted', abort)
    response.once('close', abort)
    try {
      const metadata = await version({signal: controller.signal})
      const result = await scan(request, {signal: controller.signal, expectedBytes, maxBytes})
      respond(response, 200, {...result, ...metadata})
    } catch (error) {
      const safe = error instanceof ScannerError ? error : new ScannerError()
      respond(response, safe.status, {code: safe.code})
    } finally {
      clearTimeout(timer)
      request.removeListener('aborted', abort)
      response.removeListener('close', abort)
      active--
      // Do not keep an unread, rejected upload flowing or retaining a slot.
      if (!request.complete) response.once('finish', () => request.destroy())
    }
  })
  server.requestTimeout = timeoutMs
  server.headersTimeout = 15_000
  server.keepAliveTimeout = 5000
  server.maxRequestsPerSocket = 100
  return server
}
