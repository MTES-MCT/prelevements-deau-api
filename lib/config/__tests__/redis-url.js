import {Buffer} from 'node:buffer'
import {X509Certificate} from 'node:crypto'
import fs from 'node:fs'
import tls from 'node:tls'

import test from 'ava'
import IORedis from 'ioredis'

import {getRedisTlsOptions, readRedisUrl} from '../redis-url.js'

const ORIGINAL = 'rediss://user%40testing:p%3A%40%25ss@public.example.test:6379/4?connectionName=testing%20worker&family=4'

test('sans override Redis, la chaîne et le comportement historique sont conservés', t => {
  t.is(readRedisUrl({}), 'redis://localhost:6379')
  for (const override of [undefined, null, '', '   ']) {
    t.is(readRedisUrl({REDIS_URL: ORIGINAL, REDIS_HOST_OVERRIDE: override}), ORIGINAL)
    t.is(readRedisUrl({REDIS_URL: 'old-value', REDIS_HOST_OVERRIDE: override}), 'old-value')
  }
})

test('le changement d’hôte préserve authentification, TLS, port, base et paramètres', t => {
  const effective = readRedisUrl({REDIS_URL: ORIGINAL, REDIS_HOST_OVERRIDE: '172.16.16.4'})
  t.is(effective, ORIGINAL.replace('public.example.test', '172.16.16.4'))
  const before = new URL(ORIGINAL)
  const after = new URL(effective)
  for (const key of ['protocol', 'username', 'password', 'port', 'pathname', 'search']) {
    t.is(after[key], before[key])
  }
})

test('le client IORedis reçoit le nouvel hôte et conserve ses credentials décodés', t => {
  const url = readRedisUrl({REDIS_URL: ORIGINAL, REDIS_HOST_OVERRIDE: 'private.redis.test'})
  const client = new IORedis(url, {lazyConnect: true, tls: {ca: 'testing-ca'}})
  t.teardown(() => client.disconnect(false))

  t.is(client.options.host, 'private.redis.test')
  t.is(client.options.port, 6379)
  t.is(client.options.username, 'user@testing')
  t.is(client.options.password, 'p:@%ss')
  t.is(client.options.db, 4)
  t.is(client.options.connectionName, 'testing worker')
  t.is(client.options.tls.ca, 'testing-ca')
  t.not(client.options.tls.rejectUnauthorized, false)
  t.is(client.options.tls.servername, undefined)
  t.is(tls.checkServerIdentity(client.options.host, {subjectaltname: 'DNS:private.redis.test'}), undefined)
  t.is(tls.checkServerIdentity(client.options.host, {subjectaltname: 'DNS:public.example.test'}).code, 'ERR_TLS_CERT_ALTNAME_INVALID')
})

test('les hôtes DNS et IPv6 sont normalisés sans accepter de port dans l’override', t => {
  for (const [override, expected] of [[' private.redis.test ', 'private.redis.test'], ['2001:db8::1', '[2001:db8::1]'], ['[2001:0DB8:0:0:0:0:0:1]', '[2001:db8::1]']]) {
    const url = new URL(readRedisUrl({REDIS_URL: ORIGINAL, REDIS_HOST_OVERRIDE: override}))
    t.is(url.hostname, expected)
    t.is(url.port, '6379')
  }
})

test('l’identité TLS IORedis suit aussi une IP privée sans accepter localhost', t => {
  const url = readRedisUrl({REDIS_URL: ORIGINAL, REDIS_HOST_OVERRIDE: '172.16.16.4'})
  const client = new IORedis(url, {lazyConnect: true, tls: {ca: 'testing-ca'}})
  t.teardown(() => client.disconnect(false))

  t.is(client.options.host, '172.16.16.4')
  t.not(client.options.tls.rejectUnauthorized, false)
  t.is(tls.checkServerIdentity(client.options.host, {subjectaltname: 'IP Address:172.16.16.4'}), undefined)
  t.is(tls.checkServerIdentity(client.options.host, {subjectaltname: 'DNS:localhost'}).code, 'ERR_TLS_CERT_ALTNAME_INVALID')
})

test('les overrides ambigus sont refusés sans exposer credentials ou payload', t => {
  for (const override of ['user@host', 'host:6379', 'rediss://host', 'host/path', 'host?secret=value', 'host#fragment', 'host%2Fpath', 'host name', 'host\nname', 'invalid_name', '-invalid.test', 'invalid-.test', '.test', 'host..test', 'a'.repeat(64) + '.test', 6379]) {
    const error = t.throws(() => readRedisUrl({REDIS_URL: ORIGINAL, REDIS_HOST_OVERRIDE: override}))
    t.false(error.message.includes('p%3A'))
    t.false(error.message.includes(String(override)))
    t.is(error.cause, undefined)
  }
})

test('une source Redis invalide est refusée sans imprimer l’URL', t => {
  for (const url of ['not-a-url-with-secret', 'https://user:secret@example.test/', 'redis:///4']) {
    const error = t.throws(() => readRedisUrl({REDIS_URL: url, REDIS_HOST_OVERRIDE: '172.16.16.4'}))
    t.false(error.message.includes(url))
    t.false(error.message.includes('secret'))
    t.is(error.cause, undefined)
  }
})

test('sans identité TLS explicite les options historiques restent inchangées', t => {
  for (const identity of [undefined, null, '', '   ']) {
    const environment = {REDIS_TLS_IDENTITY: identity}
    t.is(getRedisTlsOptions(undefined, environment), undefined)
    t.deepEqual(getRedisTlsOptions('', environment), {ca: ''})
    t.deepEqual(getRedisTlsOptions('legacy-ca', environment), {ca: 'legacy-ca'})
  }
})

test('une identité TLS explicite vérifie le certificat connu sans modifier le transport privé', t => {
  const environment = {
    REDIS_URL: ORIGINAL,
    REDIS_HOST_OVERRIDE: '172.16.16.4',
    REDIS_TLS_IDENTITY: '51.15.243.75'
  }
  const ca = fs.readFileSync(new URL('../../../deploy/certs/testing/redis-ca.pem', import.meta.url), 'utf8')
  const certificate = new X509Certificate(ca).toLegacyObject()
  const options = getRedisTlsOptions(ca, environment)
  const client = new IORedis(readRedisUrl(environment), {lazyConnect: true, tls: options})
  t.teardown(() => client.disconnect(false))

  t.is(client.options.host, '172.16.16.4')
  t.is(client.options.username, 'user@testing')
  t.is(client.options.password, 'p:@%ss')
  t.is(client.options.db, 4)
  t.true(client.options.tls.rejectUnauthorized)
  t.is(client.options.tls.ca, ca)
  t.is(options.checkServerIdentity('172.16.16.4', certificate), undefined)
  t.is(options.checkServerIdentity('51.15.243.75', {subjectaltname: 'IP Address:172.16.16.4'}).code, 'ERR_TLS_CERT_ALTNAME_INVALID')
  t.is(options.checkServerIdentity('51.15.243.75', {subjectaltname: 'DNS:localhost'}).code, 'ERR_TLS_CERT_ALTNAME_INVALID')
})

test('l’identité TLS accepte DNS et IPv6 sans hériter de l’hôte précédent', t => {
  for (const [identity, subjectaltname] of [
    ['private.redis.test', 'DNS:private.redis.test'],
    ['[2001:db8::1]', 'IP Address:2001:db8:0:0:0:0:0:1']
  ]) {
    const options = getRedisTlsOptions(Buffer.from('ca'), {REDIS_URL: ORIGINAL, REDIS_TLS_IDENTITY: identity})
    t.true(options.rejectUnauthorized)
    t.is(options.checkServerIdentity('public.example.test', {subjectaltname}), undefined)
    t.is(options.checkServerIdentity('public.example.test', {subjectaltname: 'DNS:public.example.test'}).code, 'ERR_TLS_CERT_ALTNAME_INVALID')
  }
})

test('une identité TLS exige une URL chiffrée et une CA explicite', t => {
  for (const [url, ca] of [
    ['redis://user:secret@public.example.test:6379', 'ca'],
    [ORIGINAL, undefined],
    [ORIGINAL, ''],
    [ORIGINAL, '   '],
    [ORIGINAL, Buffer.alloc(0)],
    [ORIGINAL, []],
    ['not-a-url-with-secret', 'ca'],
    ['rediss:///4', 'ca']
  ]) {
    const error = t.throws(() => getRedisTlsOptions(ca, {REDIS_URL: url, REDIS_TLS_IDENTITY: '51.15.243.75'}))
    t.false(error.message.includes(url))
    t.false(error.message.includes('secret'))
    t.is(error.cause, undefined)
  }
})

test('une identité TLS malformée est refusée sans contenu sensible', t => {
  for (const identity of ['user@host', 'host:6379', 'rediss://host', 'host/path', 'host?secret=value', 'host#fragment', 'host%2Fpath', 'host name', 'host\nname', 'invalid_name', '-invalid.test', 'invalid-.test', '.test', 'host..test', 'a'.repeat(64) + '.test', 6379]) {
    const error = t.throws(() => getRedisTlsOptions('ca', {REDIS_URL: ORIGINAL, REDIS_TLS_IDENTITY: identity}))
    t.false(error.message.includes(String(identity)))
    t.false(error.message.includes('p%3A'))
    t.is(error.cause, undefined)
  }
})
