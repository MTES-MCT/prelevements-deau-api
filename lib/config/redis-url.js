import {Buffer} from 'node:buffer'
import {isIP} from 'node:net'
import process from 'node:process'
import tls from 'node:tls'

function normalizeHostname(value, name = 'REDIS_HOST_OVERRIDE') {
  const host = value.trim()
  const address = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (isIP(address) === 6) {
    return new URL(`redis://[${address}]`).hostname
  }

  if (isIP(host) === 4) {
    return host
  }

  if (host.length <= 253 && host.split('.').every(label => label.length <= 63
    && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label))) {
    return host
  }

  throw new Error(`${name} invalide : un hôte seul est attendu.`)
}

export function readRedisUrl(environment = process.env) {
  const original = environment.REDIS_URL || 'redis://localhost:6379'
  const override = environment.REDIS_HOST_OVERRIDE
  if (override === undefined || override === null || override === '') {
    return original
  }

  if (typeof override !== 'string') {
    throw new TypeError('REDIS_HOST_OVERRIDE invalide : un hôte seul est attendu.')
  }

  if (!override.trim()) {
    return original
  }

  const host = normalizeHostname(override)
  try {
    const url = new URL(original)
    if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname) {
      throw new Error('INVALID_REDIS_URL')
    }

    url.hostname = host
    if (url.hostname !== host) {
      throw new Error('INVALID_REDIS_HOST')
    }

    return url.toString()
  } catch {
    throw new Error('Configuration Redis invalide pour le changement d’hôte.')
  }
}

export function getRedisTlsOptions(ca, environment = process.env) {
  const identity = environment.REDIS_TLS_IDENTITY
  if (identity === undefined || identity === null || identity === ''
    || (typeof identity === 'string' && !identity.trim())) {
    return ca === undefined ? undefined : {ca}
  }

  if (typeof identity !== 'string') {
    throw new TypeError('REDIS_TLS_IDENTITY invalide : un hôte seul est attendu.')
  }

  const normalized = normalizeHostname(identity, 'REDIS_TLS_IDENTITY')
  const hostname = normalized.startsWith('[') ? normalized.slice(1, -1) : normalized
  const configuredCa = (typeof ca === 'string' && ca.trim().length > 0)
    || (Buffer.isBuffer(ca) && ca.length > 0)
  let protocol
  try {
    const url = new URL(readRedisUrl(environment))
    if (!url.hostname) {
      throw new Error('INVALID_REDIS_HOST')
    }

    protocol = url.protocol
  } catch {
    throw new Error('Configuration Redis TLS invalide.')
  }

  if (protocol !== 'rediss:' || !configuredCa) {
    throw new Error('REDIS_TLS_IDENTITY exige rediss:// et une CA explicite non vide.')
  }

  return {
    ca,
    rejectUnauthorized: true,
    checkServerIdentity: (_servername, certificate) => tls.checkServerIdentity(hostname, certificate)
  }
}
