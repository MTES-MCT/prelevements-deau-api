import test from 'ava'

import {createAsyncTtlCache} from '../async-ttl-cache.js'

test('partage la requête en vol puis conserve la valeur pendant le TTL', async t => {
  let currentTime = 1000
  let calls = 0
  const cache = createAsyncTtlCache({
    now: () => currentTime,
    ttlMs: 100
  })
  const loader = async () => {
    calls += 1
    return {calls}
  }

  const [first, second] = await Promise.all([cache.get(loader), cache.get(loader)])
  t.is(first, second)
  t.is(calls, 1)
  t.is(await cache.get(loader), first)

  currentTime = 1101
  t.deepEqual(await cache.get(loader), {calls: 2})
})

test('clear invalide immédiatement une valeur mémorisée', async t => {
  let calls = 0
  const cache = createAsyncTtlCache({ttlMs: 1000})
  const loader = () => ++calls

  t.is(await cache.get(loader), 1)
  cache.clear()
  t.is(await cache.get(loader), 2)
})

test('clear empêche une ancienne requête en vol de repeupler le cache', async t => {
  let resolveFirst
  const cache = createAsyncTtlCache({ttlMs: 1000})
  const first = cache.get(async () => new Promise(resolve => {
    resolveFirst = resolve
  }))

  cache.clear()
  resolveFirst('ancienne valeur')
  t.is(await first, 'ancienne valeur')
  t.is(await cache.get(() => 'nouvelle valeur'), 'nouvelle valeur')
})
