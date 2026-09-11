import test from 'ava'
import {getDedicatedSearchCacheRedis, closeDedicatedSearchCacheRedis} from '../search-cache-config.js'

test('l’arrêt libère le client du cache et reste idempotent, sans ouvrir de connexion', t => {
  const environment = {
    REDIS_URL: 'redis://127.0.0.1:56391/0',
    SEARCH_CACHE_REDIS_URL: 'redis://127.0.0.1:56392/0',
    SEARCH_CACHE_NAMESPACE: 'shutdown-test'
  }
  t.teardown(closeDedicatedSearchCacheRedis)
  const client = getDedicatedSearchCacheRedis(environment)
  t.is(client.status, 'wait')
  t.is(client.options.protocol, 2)
  closeDedicatedSearchCacheRedis()
  closeDedicatedSearchCacheRedis()
  t.is(client.status, 'end')
  const replacement = getDedicatedSearchCacheRedis(environment)
  t.not(replacement, client)
  t.is(replacement.status, 'wait')
})
