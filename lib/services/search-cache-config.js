import {createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import IORedis from 'ioredis'

const CACHE_NAMESPACE_PREFIX = 'preservonsleau:search-corpus:v1'
const CACHE_VALUE_SCHEMA = 1
const NAMESPACE_PATTERN = /^[a-z\d][\w.-]{0,63}$/i
const DEFAULT_TTL_SECONDS = 30
const MIN_TTL_SECONDS = 5
const MAX_TTL_SECONDS = 60
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const MIN_MAX_BYTES = 64 * 1024
const HARD_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_FAILURE_BACKOFF_MS = 15_000
const DEFAULT_COMMAND_TIMEOUT_MS = 150
const DEFAULT_CONNECT_TIMEOUT_MS = 200

let dedicatedRedis
let dedicatedRedisSignature
let configurationWarningEmitted = false

function boundedInteger(value, fallback, {min, max}) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, parsed))
    : fallback
}

function compareStrings(left, right) {
  return left < right ? -1 : Number(left > right)
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value
      .map(item => canonicalize(item))
      .sort((left, right) => compareStrings(JSON.stringify(left), JSON.stringify(right)))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, item]) => [key, canonicalize(item)]))
  }

  return value
}

function digest(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')
}

function redisEndpointIdentity(value) {
  try {
    const url = new URL(value)

    if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname) {
      return null
    }

    return `${url.hostname.toLowerCase()}:${url.port || '6379'}`
  } catch {
    return null
  }
}

function readSearchCacheUrl(environment = process.env) {
  const searchCacheUrl = String(environment.SEARCH_CACHE_REDIS_URL ?? '').trim()
  const bullMqUrl = String(
    environment.REDIS_URL ?? 'redis://localhost:6379'
  ).trim()
  const searchEndpoint = redisEndpointIdentity(searchCacheUrl)
  const bullMqEndpoint = redisEndpointIdentity(bullMqUrl)

  return searchEndpoint && (!bullMqEndpoint || searchEndpoint !== bullMqEndpoint)
    ? searchCacheUrl
    : null
}

export function readSearchCorpusCacheNamespace(environment = process.env) {
  const namespaceCandidate = environment.SEARCH_CACHE_NAMESPACE
    ?? environment.APP_ENV

  if (!NAMESPACE_PATTERN.test(String(namespaceCandidate ?? '').trim())) {
    return null
  }

  return `${CACHE_NAMESPACE_PREFIX}:environment:${digest(String(namespaceCandidate).trim())}`
}

export function isSearchCorpusCacheEnabled(environment = process.env) {
  return Boolean(
    readSearchCacheUrl(environment)
    && readSearchCorpusCacheNamespace(environment)
  )
}

export function warnInvalidSearchCacheConfiguration({
  environment = process.env,
  warn = message => console.warn(message)
} = {}) {
  const configuredUrl = String(environment.SEARCH_CACHE_REDIS_URL ?? '').trim()

  if (!configuredUrl
    || isSearchCorpusCacheEnabled(environment)
    || configurationWarningEmitted) {
    return false
  }

  configurationWarningEmitted = true
  warn('[SEARCH_CACHE_DISABLED] Cache API désactivé : namespace absent ou endpoint Redis non dédié.')
  return true
}

export function readSearchCorpusCacheTtlSeconds(value = process.env.SEARCH_CACHE_TTL_SECONDS) {
  return boundedInteger(value, DEFAULT_TTL_SECONDS, {
    min: MIN_TTL_SECONDS,
    max: MAX_TTL_SECONDS
  })
}

export function readSearchCorpusCacheMaxBytes(value = process.env.SEARCH_CACHE_MAX_BYTES) {
  return boundedInteger(value, DEFAULT_MAX_BYTES, {
    min: MIN_MAX_BYTES,
    max: HARD_MAX_BYTES
  })
}

export function readSearchCorpusCacheFailureBackoffMs(
  value = process.env.SEARCH_CACHE_FAILURE_BACKOFF_MS
) {
  return boundedInteger(value, DEFAULT_FAILURE_BACKOFF_MS, {
    min: 1000,
    max: 60_000
  })
}

export function createSearchCorpusScopeDigest(scope) {
  return digest(scope)
}

export function createSearchCacheKeySet(namespace, scope, version) {
  const keyDigest = digest({scope, version})

  return {
    corpus: `${namespace}:corpus:${keyDigest}`,
    lock: `${namespace}:lock:${keyDigest}`,
    version: `${namespace}:version`
  }
}

export function serializeSearchCacheValue(value) {
  return JSON.stringify({schema: CACHE_VALUE_SCHEMA, value}, (key, item) => (
    typeof item === 'bigint' ? item.toString() : item
  ))
}

export function deserializeSearchCacheValue(serialized) {
  if (typeof serialized !== 'string') {
    return {hit: false}
  }

  try {
    const parsed = JSON.parse(serialized)

    return parsed?.schema === CACHE_VALUE_SCHEMA && Object.hasOwn(parsed, 'value')
      ? {hit: true, value: parsed.value}
      : {hit: false}
  } catch {
    return {hit: false}
  }
}

function createDedicatedRedis(url, environment = process.env) {
  const caFilePath = String(
    environment.SEARCH_CACHE_REDIS_TLS_CA_FILE_PATH ?? ''
  ).trim()
  const options = {
    commandTimeout: boundedInteger(
      environment.SEARCH_CACHE_REDIS_COMMAND_TIMEOUT_MS,
      DEFAULT_COMMAND_TIMEOUT_MS,
      {min: 50, max: 1000}
    ),
    connectTimeout: boundedInteger(
      environment.SEARCH_CACHE_REDIS_CONNECT_TIMEOUT_MS,
      DEFAULT_CONNECT_TIMEOUT_MS,
      {min: 50, max: 1000}
    ),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null
  }

  if (caFilePath) {
    options.tls = {
      ca: fs.readFileSync(path.resolve(process.cwd(), caFilePath), 'utf8')
    }
  }

  const client = new IORedis(url, options)
  client.on('error', () => {})
  return client
}

export function getDedicatedSearchCacheRedis(environment = process.env) {
  const url = readSearchCacheUrl(environment)

  if (!url || !readSearchCorpusCacheNamespace(environment)) {
    return null
  }

  const signature = digest({
    caFilePath: environment.SEARCH_CACHE_REDIS_TLS_CA_FILE_PATH ?? '',
    url
  })

  if (dedicatedRedis && dedicatedRedisSignature === signature
    && dedicatedRedis.status !== 'end') {
    return dedicatedRedis
  }

  dedicatedRedis?.disconnect(false)
  dedicatedRedis = createDedicatedRedis(url, environment)
  dedicatedRedisSignature = signature
  return dedicatedRedis
}
