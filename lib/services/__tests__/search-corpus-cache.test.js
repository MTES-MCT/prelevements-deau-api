import test from 'ava'
import express from 'express'
import request from 'supertest'

import {
  createSearchCorpusScopeDigest,
  isSearchCorpusCacheEnabled,
  readSearchCorpusCacheFailureBackoffMs,
  readSearchCorpusCacheMaxBytes,
  readSearchCorpusCacheNamespace,
  readSearchCorpusCacheTtlSeconds,
  warnInvalidSearchCacheConfiguration
} from '../search-cache-config.js'
import {
  createSearchCacheInvalidationMiddleware,
  createSearchCorpusCache
} from '../search-corpus-cache.js'
import {requestPerformanceMiddleware} from '../../util/request-performance.js'

class FakeRedis {
  constructor() {
    this.values = new Map()
    this.setCalls = []
    this.getCount = 0
    this.failAtGet = null
  }

  async get(key) {
    this.getCount++
    if (this.failAtGet && this.getCount >= this.failAtGet) {
      throw new Error('Redis unavailable')
    }

    return this.values.get(key) ?? null
  }

  async set(key, value, ...options) {
    if (options.includes('NX') && this.values.has(key)) {
      return null
    }

    this.values.set(key, value)
    this.setCalls.push({key, options, value})
    return 'OK'
  }

  async incr(key) {
    const version = Number(this.values.get(key) ?? 0) + 1
    this.values.set(key, String(version))
    return version
  }

  async eval(script, keyCount, key, token) {
    if (this.values.get(key) === token) {
      this.values.delete(key)
      return 1
    }

    return 0
  }
}

function createEnabledCache(redis, options = {}) {
  return createSearchCorpusCache({
    enabled: true,
    getRedis: async () => redis,
    namespace: readSearchCorpusCacheNamespace({APP_ENV: 'testing'}),
    ...options
  })
}

function nextTurn() {
  return new Promise(resolve => {
    setImmediate(resolve)
  })
}

test('le cache exige URL dédiée et namespace explicite', t => {
  t.false(isSearchCorpusCacheEnabled({
    NODE_ENV: 'production',
    SEARCH_CACHE_REDIS_URL: 'redis://cache.test'
  }))
  t.false(isSearchCorpusCacheEnabled({
    SEARCH_CACHE_NAMESPACE: 'development',
    SEARCH_CACHE_REDIS_URL: 'redis://localhost/4'
  }))
  t.false(isSearchCorpusCacheEnabled({
    APP_ENV: 'testing',
    REDIS_URL: 'redis://shared.test',
    SEARCH_CACHE_REDIS_URL: 'redis://shared.test:6379/0'
  }))
  t.false(isSearchCorpusCacheEnabled({
    APP_ENV: 'testing',
    REDIS_URL: 'rediss://user:secret@SHARED.test/1',
    SEARCH_CACHE_REDIS_URL: 'redis://shared.test:6379/9'
  }))
  t.false(isSearchCorpusCacheEnabled({
    SEARCH_CACHE_NAMESPACE: 'prod avec espaces',
    SEARCH_CACHE_REDIS_URL: 'redis://cache.test'
  }))
  t.true(isSearchCorpusCacheEnabled({
    SEARCH_CACHE_NAMESPACE: 'testing',
    REDIS_URL: 'redis://bullmq.test',
    SEARCH_CACHE_REDIS_URL: 'rediss://cache.test'
  }))

  const testing = readSearchCorpusCacheNamespace({APP_ENV: 'testing'})
  const production = readSearchCorpusCacheNamespace({APP_ENV: 'production'})
  t.not(testing, production)
  t.false(testing.includes('testing'))
  t.false(production.includes('production'))
  t.is(readSearchCorpusCacheNamespace({NODE_ENV: 'production'}), null)
})

test('une configuration refusée avertit une fois sans exposer l’URL', t => {
  const messages = []
  const environment = {
    NODE_ENV: 'production',
    SEARCH_CACHE_REDIS_URL: 'redis://secret:password@cache.example.test'
  }

  t.true(warnInvalidSearchCacheConfiguration({
    environment,
    warn: message => messages.push(message)
  }))
  t.false(warnInvalidSearchCacheConfiguration({
    environment,
    warn: message => messages.push(message)
  }))
  t.is(messages.length, 1)
  t.false(messages[0].includes('secret'))
  t.false(messages[0].includes('password'))
  t.false(messages[0].includes('cache.example.test'))
})

test('TTL, taille et backoff restent bornés', t => {
  t.is(readSearchCorpusCacheTtlSeconds(), 30)
  t.is(readSearchCorpusCacheTtlSeconds('1'), 5)
  t.is(readSearchCorpusCacheTtlSeconds('3600'), 60)
  t.is(readSearchCorpusCacheMaxBytes(), 5 * 1024 * 1024)
  t.is(readSearchCorpusCacheMaxBytes('1'), 64 * 1024)
  t.is(readSearchCorpusCacheMaxBytes(String(50 * 1024 * 1024)), 10 * 1024 * 1024)
  t.is(readSearchCorpusCacheFailureBackoffMs(), 15_000)
  t.is(readSearchCorpusCacheFailureBackoffMs('10'), 1000)
  t.is(readSearchCorpusCacheFailureBackoffMs('120000'), 60_000)
})

test('le hash de scope est déterministe et opaque', t => {
  const left = createSearchCorpusScopeDigest({
    user: {id: 'utilisateur-secret', role: 'INSTRUCTOR'},
    zoneIds: ['zone-b', 'zone-a']
  })
  const right = createSearchCorpusScopeDigest({
    zoneIds: ['zone-a', 'zone-b'],
    user: {role: 'INSTRUCTOR', id: 'utilisateur-secret'}
  })

  t.is(left, right)
  t.regex(left, /^[a-f\d]{64}$/)
  t.false(left.includes('utilisateur-secret'))
  t.false(left.includes('zone-a'))
})

test('miss puis hit passent par un vrai round-trip JSON', async t => {
  const redis = new FakeRedis()
  const cache = createEnabledCache(redis, {ttlSeconds: 17})
  const scope = {
    includeSearchDocuments: true,
    user: {id: 'utilisateur-secret', role: 'INSTRUCTOR'}
  }
  let loads = 0
  const loader = async () => {
    loads++
    return {
      createdAt: new Date('2026-08-19T12:00:00.000Z'),
      occurrence: 2n,
      ids: ['declarant-secret']
    }
  }

  const first = await cache.getOrLoad({scope, loader})
  const second = await cache.getOrLoad({scope, loader})

  t.is(loads, 1)
  t.true(first.createdAt instanceof Date)
  t.is(first.occurrence, 2n)
  t.is(second.createdAt, '2026-08-19T12:00:00.000Z')
  t.is(second.occurrence, '2')
  const corpusWrite = redis.setCalls.find(call => call.options.includes('EX'))
  t.deepEqual(corpusWrite.options, ['EX', 17])
  t.false(corpusWrite.key.includes('utilisateur-secret'))
  t.false(corpusWrite.key.includes('declarant-secret'))
})

test('docs=0 et docs=1 forment exactement deux corpus', async t => {
  const redis = new FakeRedis()
  const cache = createEnabledCache(redis)
  let loads = 0
  const run = includeSearchDocuments => cache.getOrLoad({
    scope: {includeSearchDocuments, kind: 'declarants', user: {id: 'admin-1'}},
    async loader() {
      loads++
      return {includeSearchDocuments}
    }
  })

  await run(false)
  await run(true)
  await run(true)
  t.is(loads, 2)
})

test('cache désactivé ne contacte jamais Redis et charge directement', async t => {
  let redisCalls = 0
  let loads = 0
  const cache = createSearchCorpusCache({
    enabled: false,
    async getRedis() {
      redisCalls++
      return new FakeRedis()
    }
  })
  const run = () => cache.getOrLoad({
    scope: {kind: 'declarants', user: {id: 'admin-1'}},
    async loader() {
      loads++
      return {source: 'postgresql'}
    }
  })

  await run()
  await run()
  t.is(redisCalls, 0)
  t.is(loads, 2)
})

test('single-flight local et fail-open ne doublent pas le calcul', async t => {
  const redis = new FakeRedis()
  redis.failAtGet = 1
  const cache = createEnabledCache(redis)
  let releaseLoader
  const gate = new Promise(resolve => {
    releaseLoader = resolve
  })
  let loads = 0
  const loader = async () => {
    loads++
    await gate
    return {source: 'postgresql'}
  }

  const scope = {kind: 'declarants', user: {id: 'admin-1'}}
  const first = cache.getOrLoad({scope, loader})
  const second = cache.getOrLoad({scope, loader})

  await Promise.resolve()
  releaseLoader()
  t.deepEqual(await Promise.all([first, second]), [
    {source: 'postgresql'},
    {source: 'postgresql'}
  ])
  t.is(loads, 1)
})

test('une panne juste après SET NX reste fail-open', async t => {
  const redis = new FakeRedis()
  redis.failAtGet = 3
  const cache = createEnabledCache(redis)
  let loads = 0

  const result = await cache.getOrLoad({
    scope: {kind: 'declarants', user: {id: 'admin-1'}},
    async loader() {
      loads++
      return {source: 'postgresql'}
    }
  })

  t.deepEqual(result, {source: 'postgresql'})
  t.is(loads, 1)
})

test('un corpus trop volumineux n’est jamais stocké', async t => {
  const redis = new FakeRedis()
  const cache = createEnabledCache(redis, {maxBytes: 32})
  let loads = 0
  const loader = async () => {
    loads++
    return {payload: 'x'.repeat(100)}
  }

  const scope = {kind: 'point-map', user: {id: 'admin-1'}}

  await cache.getOrLoad({scope, loader})
  await cache.getOrLoad({scope, loader})
  t.is(loads, 2)
  t.false(redis.setCalls.some(call => call.options.includes('EX')))
})

test('une invalidation v2 rend illisible un calcul v1 encore en vol', async t => {
  const redis = new FakeRedis()
  const cache = createEnabledCache(redis)
  let announceLoad
  const loadStarted = new Promise(resolve => {
    announceLoad = resolve
  })
  let releaseOldLoad
  const oldGate = new Promise(resolve => {
    releaseOldLoad = resolve
  })
  const scope = {kind: 'declarants', user: {id: 'admin-1'}}
  const oldRequest = cache.getOrLoad({
    scope,
    async loader() {
      announceLoad()
      await oldGate
      return {version: 'v1'}
    }
  })

  await loadStarted
  t.true(await cache.invalidate())
  releaseOldLoad()
  t.deepEqual(await oldRequest, {version: 'v1'})

  let freshLoads = 0
  const fresh = await cache.getOrLoad({
    scope,
    async loader() {
      freshLoads++
      return {version: 'v2'}
    }
  })
  t.deepEqual(fresh, {version: 'v2'})
  t.is(freshLoads, 1)
})

test('un follower attend un leader 700 ms sans relancer PostgreSQL', async t => {
  const redis = new FakeRedis()
  let virtualNow = 0
  let releaseLeader
  let leaderReleased = false
  const leaderGate = new Promise(resolve => {
    releaseLeader = resolve
  })
  const options = {
    now: () => virtualNow,
    async wait(durationMs) {
      virtualNow += durationMs
      if (!leaderReleased && virtualNow >= 700) {
        leaderReleased = true
        releaseLeader()
      }

      await Promise.resolve()
    }
  }
  const leaderCache = createEnabledCache(redis, options)
  const followerCache = createEnabledCache(redis, options)
  let announceLeader
  const leaderStarted = new Promise(resolve => {
    announceLeader = resolve
  })
  const scope = {kind: 'declarants', user: {id: 'admin-1'}}
  const leader = leaderCache.getOrLoad({
    scope,
    async loader() {
      announceLeader()
      await leaderGate
      return {source: 'leader'}
    }
  })

  await leaderStarted
  let followerLoads = 0
  const follower = followerCache.getOrLoad({
    scope,
    async loader() {
      followerLoads++
      return {source: 'follower'}
    }
  })

  t.deepEqual(await follower, {source: 'leader'})
  t.deepEqual(await leader, {source: 'leader'})
  t.is(followerLoads, 0)
  t.true(virtualNow >= 700)
})

test('l’invalidation précède end et préserve signature, callback et double-end', async t => {
  let releaseInvalidation
  const invalidationGate = new Promise(resolve => {
    releaseInvalidation = resolve
  })
  const calls = []
  let firstCallback = 0
  let secondCallback = 0
  const response = {
    statusCode: 201,
    end(...arguments_) {
      calls.push({arguments: arguments_, target: this})
      arguments_.find(item => typeof item === 'function')?.()
      return this
    }
  }
  const middleware = createSearchCacheInvalidationMiddleware({
    cache: {
      async invalidate() {
        await invalidationGate
        return true
      },
      isEnabled: () => true
    }
  })

  middleware({method: 'POST'}, response, () => {})
  t.is(response.end('contenu', 'utf8', () => firstCallback++), response)
  t.is(response.end(() => secondCallback++), response)
  t.is(calls.length, 0)

  releaseInvalidation()
  await nextTurn()
  t.is(calls.length, 1)
  t.is(calls[0].target, response)
  t.deepEqual(calls[0].arguments.slice(0, 2), ['contenu', 'utf8'])
  t.is(firstCallback, 1)
  t.is(secondCallback, 0)
})

test('un rejet d’invalidation reste fail-open et appelle end une fois', async t => {
  const calls = []
  let callbackCalls = 0
  const response = {
    statusCode: 200,
    end(...arguments_) {
      calls.push(arguments_)
      arguments_.find(item => typeof item === 'function')?.()
      return this
    }
  }
  const middleware = createSearchCacheInvalidationMiddleware({
    cache: {
      async invalidate() {
        throw new Error('Redis unavailable')
      },
      isEnabled: () => true
    }
  })

  middleware({method: 'PATCH'}, response, () => {})
  response.end(() => callbackCalls++)
  await nextTurn()
  t.is(calls.length, 1)
  t.is(callbackCalls, 1)
})

test('les lectures et mutations en erreur ne sont pas retardées', async t => {
  let invalidations = 0
  const cache = {
    async invalidate() {
      invalidations++
    },
    isEnabled: () => true
  }
  const middleware = createSearchCacheInvalidationMiddleware({cache})
  const createResponse = statusCode => ({
    calls: 0,
    statusCode,
    end() {
      this.calls++
      return this
    }
  })
  const readResponse = createResponse(200)
  const failedResponse = createResponse(422)

  middleware({method: 'GET'}, readResponse, () => {})
  middleware({method: 'POST'}, failedResponse, () => {})
  readResponse.end()
  failedResponse.end()
  await nextTurn()
  t.is(readResponse.calls, 1)
  t.is(failedResponse.calls, 1)
  t.is(invalidations, 0)
})

test('Server-Timing distingue miss, load puis hit sans scope lisible', async t => {
  const redis = new FakeRedis()
  const cache = createEnabledCache(redis)
  const app = express()
  let loads = 0

  app.use(requestPerformanceMiddleware)
  app.get('/cached', async (request_, response) => {
    const value = await cache.getOrLoad({
      scope: {user: {id: 'utilisateur-secret', role: 'ADMIN'}},
      async loader() {
        loads++
        return {ok: true}
      }
    })
    response.json(value)
  })

  const miss = await request(app).get('/cached').expect(200)
  const hit = await request(app).get('/cached').expect(200)
  t.regex(miss.headers['server-timing'], /search_cache_miss;dur=/)
  t.regex(miss.headers['server-timing'], /search_cache_load;dur=/)
  t.regex(hit.headers['server-timing'], /search_cache_hit;dur=/)
  t.false(hit.headers['server-timing'].includes('utilisateur-secret'))
  t.is(loads, 1)
})
