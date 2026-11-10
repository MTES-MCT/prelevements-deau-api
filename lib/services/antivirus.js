import {Buffer} from 'node:buffer'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import https from 'node:https'
import process from 'node:process'
import {rootCertificates} from 'node:tls'
import createHttpError from 'http-errors'
import {addAuditMetadata} from '../audit/context.js'
import {MAX_UPLOAD_BYTES} from '../util/upload.js'

export const ANTIVIRUS_TIMEOUT_MS = 180_000
export const MAX_SIGNATURE_AGE_MS = 72 * 60 * 60 * 1000
const MAX_RESPONSE_BYTES = 4096

function unavailable() {
  return createHttpError(503, 'La vérification des fichiers est temporairement indisponible. Veuillez réessayer.', {
    retryAfterSeconds: 30
  })
}

async function configuration(env) {
  if (env.CLAMAV_DISABLED === 'true' && ['development', 'test'].includes(env.NODE_ENV)) return null
  const url = new URL(env.CLAMAV_URL)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.pathname !== '/') throw unavailable()
  const token = env.CLAMAV_INVOKE_TOKEN
  if (!token || /\s/.test(token)) throw unavailable()
  const ca = env.CLAMAV_CA_FILE ? [...rootCertificates, await readFile(env.CLAMAV_CA_FILE, 'utf8')] : undefined
  return {url: new URL('/scan', url), token, ca}
}

// Use a dedicated agent: private traffic must not traverse an outbound HTTP proxy,
// and its optional CA must not change trust or authentication for other services.
export function requestFileScan(buffer, {config, agent, signal}) {
  return new Promise((resolve, reject) => {
    const request = https.request(config.url, {
      method: 'POST', agent, signal,
      headers: {'Content-Type': 'application/octet-stream', 'Content-Length': buffer.length, Authorization: `Bearer ${config.token}`}
    }, response => {
      if (response.statusCode !== 200 || !/^application\/json(?:;|$)/i.test(response.headers['content-type'] ?? '')) {
        response.destroy()
        reject(unavailable())
        return
      }
      let length = 0
      const chunks = []
      response.on('data', chunk => {
        length += chunk.length
        if (length > MAX_RESPONSE_BYTES) {
          response.destroy()
          reject(unavailable())
        } else {
          chunks.push(chunk)
        }
      })
      response.on('error', () => reject(unavailable()))
      response.on('aborted', () => reject(unavailable()))
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(unavailable()) }
      })
    })
    request.on('error', () => reject(unavailable()))
    request.end(buffer)
  })
}

function validateVerdict(result, buffer, now) {
  const updatedAt = Date.parse(result?.signatureUpdatedAt)
  if (!result || !['clean', 'infected', 'unscannable'].includes(result.status)
    || typeof result.engineVersion !== 'string' || !result.engineVersion || result.engineVersion.length > 100
    || typeof result.signatureVersion !== 'string' || !result.signatureVersion || result.signatureVersion.length > 100
    || !Number.isFinite(updatedAt) || updatedAt > now + 60_000 || now - updatedAt > MAX_SIGNATURE_AGE_MS
    || result.sha256 !== createHash('sha256').update(buffer).digest('hex')) throw unavailable()

  if (result.status === 'infected') {
    throw createHttpError(422, 'Un fichier a été refusé car il contient une menace détectée par l’antivirus. Aucun fichier du dépôt n’a été enregistré.')
  }
  if (result.status === 'unscannable') {
    throw createHttpError(422, 'Un fichier ne peut pas être entièrement vérifié par l’antivirus (fichier protégé ou limites d’analyse atteintes). Aucun fichier du dépôt n’a été enregistré.')
  }
  return {engineVersion: result.engineVersion, signatureVersion: result.signatureVersion,
    signatureUpdatedAt: new Date(updatedAt).toISOString(), sha256: result.sha256}
}

// Only new user uploads call this function. Existing files, generated exports and
// historical reprocessing are intentionally outside this boundary.
export async function scanUploadedFiles(files, {
  env = process.env, scanFile = requestFileScan, signal,
  timeoutMs = ANTIVIRUS_TIMEOUT_MS, now = Date.now
} = {}) {
  if (!Array.isArray(files) || !files.length || files.some(file => !Buffer.isBuffer(file?.buffer) || file.buffer.length > MAX_UPLOAD_BYTES)) {
    throw createHttpError(400, 'Fichier invalide ou trop volumineux.')
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, Math.min(timeoutMs, ANTIVIRUS_TIMEOUT_MS))
  signal?.addEventListener('abort', abort, {once: true})
  if (signal?.aborted) abort()
  let agent
  try {
    const config = await configuration(env)
    if (!config) return {skipped: true}
    if (controller.signal.aborted) throw unavailable()
    agent = new https.Agent({ca: config.ca, keepAlive: true, maxSockets: 2})
    const results = new Array(files.length)
    let nextIndex = 0
    let failure
    const run = async () => {
      while (nextIndex < files.length && !controller.signal.aborted) {
        const index = nextIndex++
        try {
          // eslint-disable-next-line no-await-in-loop
          const result = await scanFile(files[index].buffer, {config, agent, signal: controller.signal})
          if (controller.signal.aborted) throw unavailable()
          results[index] = validateVerdict(result, files[index].buffer, now())
        } catch (error) {
          failure ||= error.status === 422 ? error : unavailable()
          abort()
        }
      }
    }
    await Promise.all(Array.from({length: Math.min(2, files.length)}, run))
    if (failure) throw failure
    if (controller.signal.aborted || results.some(result => !result)) throw unavailable()
    return {files: results}
  } catch (error) {
    throw error.status === 422 ? error : unavailable()
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    agent?.destroy()
  }
}

export async function scanRequestFiles(request, response, files, {scanner = scanUploadedFiles} = {}) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  response.once?.('close', abort)
  request.once?.('aborted', abort)
  if (request.aborted || response.destroyed) abort()
  try {
    const report = await scanner(files, {signal: controller.signal})
    addAuditMetadata(request, {antivirus: report})
    return report
  } finally {
    response.removeListener?.('close', abort)
    request.removeListener?.('aborted', abort)
  }
}
