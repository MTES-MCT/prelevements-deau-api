import {createConnection} from 'node:net'
import {createHash} from 'node:crypto'
import {Transform} from 'node:stream'

export const MAX_FILE_BYTES = 50_000_000
export const MAX_SIGNATURE_AGE_MS = 72 * 60 * 60 * 1000

export class ScannerError extends Error {
  constructor(code = 'SCANNER_UNAVAILABLE', status = 503) {
    super(code)
    this.code = code
    this.status = status
  }
}

export function parseVersion(reply, now = Date.now()) {
  const match = /^ClamAV ([\w.-]+)\/(\d+)\/(.+)$/.exec(reply)
  if (!match) throw new ScannerError()
  // The daemon is always started with TZ=UTC. VERSION reports the loaded daily
  // database date, not an image build timestamp that could hide stale signatures.
  const timestamp = Date.parse(`${match[3]} UTC`)
  if (!Number.isFinite(timestamp) || timestamp > now + 300_000
    || now - timestamp > MAX_SIGNATURE_AGE_MS) throw new ScannerError('SIGNATURES_STALE')
  return {engineVersion: match[1], signatureVersion: match[2], signatureUpdatedAt: new Date(timestamp).toISOString()}
}

export function classifyReply(reply) {
  if (reply === 'stream: OK') return 'clean'
  if (/^stream: [^\r\n]+ FOUND$/.test(reply)) {
    return /^stream: Heuristics\.(?:Encrypted|Limits\.Exceeded|Broken)[.\w-]* FOUND$/.test(reply)
      ? 'unscannable' : 'infected'
  }
  throw new ScannerError()
}

function exchange(command, {host = '127.0.0.1', port = 3310, signal, source, expectedBytes,
  maxBytes = MAX_FILE_BYTES} = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({host, port})
    let reply = Buffer.alloc(0)
    let framer
    let bytes = 0
    let sha256
    let settled = false
    const hash = source ? createHash('sha256') : null
    function finish(error, value) {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      source?.unpipe(framer)
      framer?.unpipe(socket)
      framer?.destroy()
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    const abort = () => finish(new ScannerError('SCAN_TIMEOUT'))
    if (signal?.aborted) {abort(); return}
    signal?.addEventListener('abort', abort, {once: true})
    socket.on('error', () => finish(new ScannerError()))
    socket.on('end', () => finish(new ScannerError()))
    socket.on('close', () => finish(new ScannerError()))
    socket.on('data', chunk => {
      if (reply.length + chunk.length > 4096) {finish(new ScannerError()); return}
      reply = Buffer.concat([reply, chunk])
      const terminator = reply.indexOf(0)
      if (terminator === -1) return
      // Reject multiple records or a premature success. No partial scan is clean.
      if (terminator !== reply.length - 1 || (source && !sha256)) {finish(new ScannerError()); return}
      finish(null, {reply: reply.subarray(0, terminator).toString('utf8'), bytes, sha256})
    })
    socket.once('connect', () => {
      socket.write(`z${command}\0`)
      if (!source) return
      framer = new Transform({
        transform(chunk, encoding, callback) {
          bytes += chunk.length
          if (bytes > maxBytes) {callback(new ScannerError('FILE_TOO_LARGE', 413)); return}
          hash.update(chunk)
          const prefix = Buffer.allocUnsafe(4)
          prefix.writeUInt32BE(chunk.length)
          this.push(prefix)
          this.push(chunk)
          callback()
        },
        flush(callback) {
          if (!bytes || (expectedBytes !== undefined && bytes !== expectedBytes)) {
            callback(new ScannerError('INVALID_FILE_LENGTH', 400))
            return
          }
          sha256 = hash.digest('hex')
          this.push(Buffer.alloc(4))
          callback()
        }
      })
      framer.on('error', error => finish(error instanceof ScannerError ? error : new ScannerError()))
      source.once('error', () => finish(new ScannerError('UPLOAD_INTERRUPTED', 400)))
      source.pipe(framer).pipe(socket, {end: false})
    })
  })
}

export async function getEngineVersion(options = {}) {
  const result = await exchange('VERSION', {...options, signal: options.signal ?? AbortSignal.timeout(2000)})
  return parseVersion(result.reply)
}

export async function scanStream(source, options = {}) {
  const result = await exchange('INSTREAM', {...options, source})
  return {status: classifyReply(result.reply), sha256: result.sha256, bytes: result.bytes}
}
