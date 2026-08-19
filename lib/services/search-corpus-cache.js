import {Buffer} from 'node:buffer'
import {randomUUID} from 'node:crypto'
import {performance} from 'node:perf_hooks'

import {
  createSearchCacheKeySet,
  createSearchCorpusScopeDigest,
  deserializeSearchCacheValue,
  getDedicatedSearchCacheRedis,
  isSearchCorpusCacheEnabled,
  readSearchCorpusCacheFailureBackoffMs,
  readSearchCorpusCacheMaxBytes,
  readSearchCorpusCacheNamespace,
  readSearchCorpusCacheTtlSeconds,
  serializeSearchCacheValue
} from './search-cache-config.js'
import {
  recordRequestPerformancePhase,
  withRequestPerformancePhase
} from '../util/request-performance.js'

const DEFAULT_LOCK_WAIT_MS = 1000
const DEFAULT_LOCK_TTL_MS = 5000
const RELEASE_LOCK_SCRIPT = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  end
  return 0
`
const DEFAULT_PHASES = Object.freeze({
  hit: 'search_cache_hit',
  load: 'search_cache_load',
  miss: 'search_cache_miss'
})

function boundedInteger(value, fallback, {min, max}) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, parsed))
    : fallback
}

function resolveOption(option) {
  return typeof option === 'function' ? option() : option
}

function normalizeVersion(version = '0') {
  if (version === null) {
    return '0'
  }

  if (!/^\d{1,20}$/.test(String(version))) {
    throw new TypeError('Invalid search cache version')
  }

  return String(version)
}

function delay(durationMs) {
  return new Promise(resolve => {
    setTimeout(resolve, durationMs)
  })
}

export function createSearchCorpusCache({
  enabled = () => isSearchCorpusCacheEnabled(),
  failureBackoffMs = () => readSearchCorpusCacheFailureBackoffMs(),
  getRedis = () => getDedicatedSearchCacheRedis(),
  lockTtlMs = DEFAULT_LOCK_TTL_MS,
  lockWaitMs = DEFAULT_LOCK_WAIT_MS,
  maxBytes = () => readSearchCorpusCacheMaxBytes(),
  namespace = () => readSearchCorpusCacheNamespace(),
  now = () => Date.now(),
  ttlSeconds = () => readSearchCorpusCacheTtlSeconds(),
  wait = delay
} = {}) {
  const localFlights = new Map()
  let unavailableUntil = 0

  const markUnavailable = () => {
    unavailableUntil = now() + boundedInteger(
      resolveOption(failureBackoffMs),
      readSearchCorpusCacheFailureBackoffMs(),
      {min: 1000, max: 60_000}
    )
  }

  const runLocalFlight = (key, operation) => {
    if (localFlights.has(key)) {
      return localFlights.get(key)
    }

    const flight = (async () => {
      await Promise.resolve()

      try {
        return await operation()
      } finally {
        localFlights.delete(key)
      }
    })()

    localFlights.set(key, flight)
    return flight
  }

  const loadCorpus = (loader, phases) => withRequestPerformancePhase(
    phases.load,
    loader
  )

  const releaseLock = async (redis, key, token) => {
    try {
      await redis.eval(RELEASE_LOCK_SCRIPT, 1, key, token)
    } catch {
      markUnavailable()
    }
  }

  const store = async ({keys, redis, value, version}) => {
    const serialized = serializeSearchCacheValue(value)

    if (Buffer.byteLength(serialized) > resolveOption(maxBytes)) {
      return
    }

    const currentVersion = normalizeVersion(await redis.get(keys.version))
    if (currentVersion !== version) {
      return
    }

    await redis.set(
      keys.corpus,
      serialized,
      'EX',
      resolveOption(ttlSeconds)
    )
  }

  const loadWithLock = async ({keys, loader, phases, redis, version}) => {
    const token = randomUUID()
    let lockAcquired

    try {
      lockAcquired = await redis.set(
        keys.lock,
        token,
        'PX',
        boundedInteger(lockTtlMs, DEFAULT_LOCK_TTL_MS, {min: 1000, max: 15_000}),
        'NX'
      ) === 'OK'
    } catch {
      markUnavailable()
      return loadCorpus(loader, phases)
    }

    if (lockAcquired) {
      try {
        let secondRead

        try {
          secondRead = deserializeSearchCacheValue(await redis.get(keys.corpus))
        } catch {
          markUnavailable()
          return loadCorpus(loader, phases)
        }

        if (secondRead.hit) {
          return secondRead.value
        }

        const value = await loadCorpus(loader, phases)

        try {
          await store({keys, redis, value, version})
        } catch {
          markUnavailable()
        }

        return value
      } finally {
        await releaseLock(redis, keys.lock, token)
      }
    }

    const waitUntil = now() + boundedInteger(lockWaitMs, DEFAULT_LOCK_WAIT_MS, {
      min: 50,
      max: 1500
    })

    try {
      while (now() < waitUntil) {
        // Sondage borné à une seconde, interrompu à la première erreur Redis.
        // eslint-disable-next-line no-await-in-loop
        await wait(Math.min(25, Math.max(1, waitUntil - now())))
        // eslint-disable-next-line no-await-in-loop
        const cached = deserializeSearchCacheValue(await redis.get(keys.corpus))

        if (cached.hit) {
          return cached.value
        }
      }
    } catch {
      markUnavailable()
    }

    return loadCorpus(loader, phases)
  }

  const getOrLoad = async ({loader, phases = DEFAULT_PHASES, scope}) => {
    if (!resolveOption(enabled)) {
      return loader()
    }

    const fallbackKey = `fallback:${createSearchCorpusScopeDigest(scope)}`
    if (now() < unavailableUntil) {
      recordRequestPerformancePhase(phases.miss, 0)
      return runLocalFlight(fallbackKey, () => loadCorpus(loader, phases))
    }

    const lookupStartedAt = performance.now()
    let keys
    let redis
    let version

    try {
      const resolvedNamespace = resolveOption(namespace)
      redis = await getRedis()
      if (!redis || !resolvedNamespace) {
        throw new Error('Dedicated search cache unavailable')
      }

      const versionKey = createSearchCacheKeySet(
        resolvedNamespace,
        scope,
        '0'
      ).version
      version = normalizeVersion(await redis.get(versionKey))
      keys = createSearchCacheKeySet(resolvedNamespace, scope, version)
      const cached = deserializeSearchCacheValue(await redis.get(keys.corpus))

      if (cached.hit) {
        recordRequestPerformancePhase(phases.hit, performance.now() - lookupStartedAt)
        return cached.value
      }

      recordRequestPerformancePhase(phases.miss, performance.now() - lookupStartedAt)
    } catch {
      recordRequestPerformancePhase(phases.miss, performance.now() - lookupStartedAt)
      markUnavailable()
      return runLocalFlight(fallbackKey, () => loadCorpus(loader, phases))
    }

    return runLocalFlight(keys.corpus, () => loadWithLock({
      keys,
      loader,
      phases,
      redis,
      version
    }))
  }

  const invalidate = async () => {
    if (!resolveOption(enabled)) {
      return false
    }

    try {
      const resolvedNamespace = resolveOption(namespace)
      const redis = await getRedis()
      if (!redis || !resolvedNamespace) {
        return false
      }

      const versionKey = createSearchCacheKeySet(
        resolvedNamespace,
        {},
        '0'
      ).version
      await redis.incr(versionKey)
      unavailableUntil = 0
      return true
    } catch {
      markUnavailable()
      return false
    }
  }

  return {
    getOrLoad,
    invalidate,
    isEnabled: () => resolveOption(enabled)
  }
}

export const searchCorpusCache = createSearchCorpusCache()

function flushPendingEnds(response, originalEnd, pendingEnds) {
  for (const pending of pendingEnds.splice(0)) {
    try {
      originalEnd.apply(pending.target, pending.arguments)
    } catch (error) {
      response.destroy?.(error)
      break
    }
  }
}

export function createSearchCacheInvalidationMiddleware({
  cache = searchCorpusCache
} = {}) {
  return (request, response, next) => {
    if (!cache.isEnabled()
      || ['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) {
      return next()
    }

    const originalEnd = response.end
    const pendingEnds = []
    let invalidationStarted = false
    let flushed = false

    response.end = function (...arguments_) {
      if (flushed || response.statusCode < 200 || response.statusCode >= 400) {
        return originalEnd.apply(this, arguments_)
      }

      if (invalidationStarted) {
        return this
      }

      invalidationStarted = true
      pendingEnds.push({arguments: arguments_, target: this})
      const complete = () => {
        flushed = true
        flushPendingEnds(response, originalEnd, pendingEnds)
      }

      try {
        const invalidation = cache.invalidate()

        // Response.end doit rester synchrone : on finalise dans les deux branches.
        // eslint-disable-next-line promise/prefer-await-to-then, promise/prefer-catch
        Promise.resolve(invalidation).then(complete, complete)
      } catch {
        complete()
      }

      return this
    }

    return next()
  }
}

export const searchCacheInvalidationMiddleware
  = createSearchCacheInvalidationMiddleware()
