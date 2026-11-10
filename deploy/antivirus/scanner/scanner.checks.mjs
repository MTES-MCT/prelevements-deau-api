import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import {once} from 'node:events'
import {createHash} from 'node:crypto'
import {Readable} from 'node:stream'
import {setTimeout as delay} from 'node:timers/promises'
import {createScannerServer} from './server.mjs'
import {parseVersion, classifyReply, scanStream, getEngineVersion, ScannerError, MAX_SIGNATURE_AGE_MS} from './clamd.mjs'

const token = 'a'.repeat(64)
const metadata = {engineVersion: '1.4.6', signatureVersion: '12345', signatureUpdatedAt: new Date().toISOString()}
const headers = {Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream'}

async function mockClamd(t, result = 'stream: OK') {
  const sockets = new Set()
  const bodies = []
  const daemon = net.createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    let incoming = Buffer.alloc(0)
    let command
    const chunks = []
    socket.on('data', data => {
      incoming = Buffer.concat([incoming, data])
      if (!command) {
        const end = incoming.indexOf(0)
        if (end < 0) return
        command = incoming.subarray(0, end).toString()
        incoming = incoming.subarray(end + 1)
        if (command === 'zVERSION') {
          socket.end(`ClamAV 1.4.6/12345/${new Date().toUTCString().replace('GMT', '').trim()}\0`)
          return
        }
        assert.equal(command, 'zINSTREAM')
      }
      while (incoming.length >= 4) {
        const length = incoming.readUInt32BE()
        if (incoming.length < length + 4) return
        if (!length) {
          bodies.push(Buffer.concat(chunks))
          if (result !== null) socket.end(`${result}\0`)
          return
        }
        chunks.push(incoming.subarray(4, length + 4))
        incoming = incoming.subarray(length + 4)
      }
    })
  })
  daemon.listen(0, '127.0.0.1')
  await once(daemon, 'listening')
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => daemon.close(resolve))
  })
  return {port: daemon.address().port, bodies, sockets}
}

async function listen(t, options = {}) {
  const server = createScannerServer({token, version: async () => metadata, ...options})
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}`
}

test('VERSION uses actual signature date and rejects missing, stale and future databases', () => {
  const now = Date.parse('2026-11-10T12:00:00Z')
  assert.deepEqual(parseVersion('ClamAV 1.4.6/28177/Tue Nov 10 06:00:00 2026', now), {
    engineVersion: '1.4.6', signatureVersion: '28177', signatureUpdatedAt: '2026-11-10T06:00:00.000Z'
  })
  for (const reply of ['ClamAV 1.4.6', 'ClamAV 1.4.6/1/invalid', 'ClamAV 1.4.6/1/Fri Nov 6 00:00:00 2026', 'ClamAV 1.4.6/1/Wed Nov 11 00:00:00 2026']) {
    assert.throws(() => parseVersion(reply, now), ScannerError)
  }
  assert.equal(MAX_SIGNATURE_AGE_MS, 72 * 60 * 60 * 1000)
})

test('only an exact ClamAV OK is accepted; encrypted and exceeded limits are not a clean verdict', () => {
  assert.equal(classifyReply('stream: OK'), 'clean')
  assert.equal(classifyReply('stream: Win.Test.EICAR_HDB-1 FOUND'), 'infected')
  assert.equal(classifyReply('stream: Heuristics.Encrypted.Zip FOUND'), 'unscannable')
  assert.equal(classifyReply('stream: Heuristics.Limits.Exceeded.MaxScanSize FOUND'), 'unscannable')
  for (const reply of ['OK', 'stream: OK\nextra', 'stream: Internal error ERROR', 'stream: ', 'stream: OK\0stream: OK']) {
    assert.throws(() => classifyReply(reply), ScannerError)
  }
})

test('streaming protocol transmits exactly the bytes hashed, with bounded size and exact length', async t => {
  const daemon = await mockClamd(t)
  const options = {port: daemon.port, signal: AbortSignal.timeout(2000), expectedBytes: 6, maxBytes: 6}
  assert.equal((await getEngineVersion(options)).signatureVersion, '12345')
  const result = await scanStream(Readable.from([Buffer.from('abc'), Buffer.from('def')]), options)
  assert.equal(result.status, 'clean')
  assert.equal(result.sha256, createHash('sha256').update('abcdef').digest('hex'))
  assert.equal(result.bytes, 6)
  assert.deepEqual(daemon.bodies, [Buffer.from('abcdef')])
  await assert.rejects(scanStream(Readable.from([Buffer.alloc(7)]), options), {code: 'FILE_TOO_LARGE'})
  await assert.rejects(scanStream(Readable.from([Buffer.alloc(5)]), options), {code: 'INVALID_FILE_LENGTH'})
})

test('clamd failure and truncated replies cannot become a clean scan', async t => {
  const daemon = await mockClamd(t, 'stream: UNKNOWN ERROR')
  await assert.rejects(scanStream(Readable.from([Buffer.from('test')]), {port: daemon.port, signal: AbortSignal.timeout(1000)}), ScannerError)
})

test('a scan timeout closes the clamd connection and returns promptly', async t => {
  const daemon = await mockClamd(t, null)
  await assert.rejects(scanStream(Readable.from([Buffer.from('test')]), {port: daemon.port, signal: AbortSignal.timeout(50)}), {code: 'SCAN_TIMEOUT'})
  await delay(20)
  assert.equal(daemon.sockets.size, 0)
})

test('HTTP requires an explicit secret and protects scans and detailed health', async t => {
  assert.throws(() => createScannerServer({token: ''}), /256-bit/)
  assert.throws(() => createScannerServer({token: 'weak'}), /256-bit/)
  let calls = 0
  const base = await listen(t, {scan: async () => {calls++; return {status: 'clean'}}})
  const ready = await fetch(`${base}/readyz`)
  assert.equal(ready.status, 200)
  assert.deepEqual(await ready.json(), {status: 'ready'})
  assert.equal((await fetch(`${base}/healthz`)).status, 401)
  assert.equal((await fetch(`${base}/scan`, {method: 'POST', headers: {...headers, Authorization: 'Bearer bad'}, body: 'test'})).status, 401)
  assert.equal(calls, 0)
  const health = await fetch(`${base}/healthz`, {headers})
  assert.equal(health.status, 200)
  assert.equal((await health.json()).signatureVersion, '12345')
})

test('HTTP streams healthy files and reports actual integrity metadata', async t => {
  const daemon = await mockClamd(t)
  const base = await listen(t, {scan: (source, options) => scanStream(source, {...options, port: daemon.port})})
  const response = await fetch(`${base}/scan`, {method: 'POST', headers, body: 'test'})
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {status: 'clean', bytes: 4,
    sha256: createHash('sha256').update('test').digest('hex'), ...metadata})
})

test('HTTP fails closed for stale signatures, unsupported encoding, empty and oversized uploads', async t => {
  let calls = 0
  const base = await listen(t, {maxBytes: 4, scan: async () => {calls++; return {status: 'clean'}}})
  assert.equal((await fetch(`${base}/scan`, {method: 'POST', headers, body: '12345'})).status, 413)
  assert.equal((await fetch(`${base}/scan`, {method: 'POST', headers, body: ''})).status, 400)
  assert.equal((await fetch(`${base}/scan`, {method: 'POST', headers: {...headers, 'Content-Encoding': 'gzip'}, body: 'test'})).status, 415)
  assert.equal(calls, 0)
  const stale = await listen(t, {version: async () => {throw new ScannerError('SIGNATURES_STALE')}})
  assert.equal((await fetch(`${stale}/readyz`)).status, 503)
  const response = await fetch(`${stale}/scan`, {method: 'POST', headers, body: 'test'})
  assert.equal(response.status, 503)
  assert.equal((await response.json()).code, 'SIGNATURES_STALE')
})

test('concurrency is bounded and cancellation releases the slot', async t => {
  const started = Promise.withResolvers()
  const base = await listen(t, {concurrency: 1, timeoutMs: 1000, scan: async (source, {signal}) => {
    started.resolve()
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new ScannerError()), {once: true}))
  }})
  const controller = new AbortController()
  const pending = fetch(`${base}/scan`, {method: 'POST', headers, body: 'test', signal: controller.signal}).catch(() => {})
  await started.promise
  const busy = await fetch(`${base}/scan`, {method: 'POST', headers, body: 'test'})
  assert.equal(busy.status, 503)
  assert.equal((await busy.json()).code, 'SCANNER_BUSY')
  controller.abort()
  await pending
})

test('chunked uploads cannot bypass the size limit and the next request still works', async t => {
  const daemon = await mockClamd(t)
  const base = await listen(t, {maxBytes: 4, scan: (source, options) => scanStream(source, {...options, port: daemon.port})})
  const response = await new Promise((resolve, reject) => {
    const request = http.request(`${base}/scan`, {method: 'POST', headers}, reply => {
      reply.resume()
      resolve(reply.statusCode)
    })
    request.on('error', reject)
    request.write('123')
    request.end('456')
  })
  assert.equal(response, 413)
  assert.equal((await fetch(`${base}/scan`, {method: 'POST', headers, body: 'test'})).status, 200)
})
