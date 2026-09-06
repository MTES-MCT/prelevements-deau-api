import {X509Certificate} from 'node:crypto'
import fs from 'node:fs'

import test from 'ava'

import {getRedisTlsOptions, readRedisUrl} from '../../../lib/config/redis-url.js'
import {PROD_DATABASE_ENDPOINT} from '../prod-database-target.js'

test('la CA PostgreSQL prod unique couvre les endpoints privé et public de la même instance', t => {
  const pem = fs.readFileSync(new URL('../../../deploy/certs/prod/postgres-ca.pem', import.meta.url), 'utf8')
  t.is(pem.match(/-----BEGIN CERTIFICATE-----/g)?.length, 1)
  const certificate = new X509Certificate(pem)
  t.is(certificate.checkIP(PROD_DATABASE_ENDPOINT.host), PROD_DATABASE_ENDPOINT.host)
  t.is(certificate.checkIP('51.15.219.67'), '51.15.219.67')
  const hostname = 'rw-08e5c5a3-05af-4771-b994-fe2ad901c7b7.rdb.fr-par.scw.cloud'
  t.is(certificate.checkHost(hostname), hostname)
  t.is(certificate.checkIP('172.16.16.3'), undefined)
  t.is(certificate.checkIP('172.16.12.2'), undefined)
})

test('la CA Redis prod conservée valide son identité explicite sans changer le transport privé', t => {
  const ca = fs.readFileSync(new URL('../../../deploy/certs/prod/redis-ca.pem', import.meta.url), 'utf8')
  const certificate = new X509Certificate(ca)
  const environment = {
    REDIS_URL: 'rediss://prod:fake-password@51.15.196.212:6379/0',
    REDIS_HOST_OVERRIDE: '172.16.20.4',
    REDIS_TLS_IDENTITY: '51.15.196.212'
  }
  const options = getRedisTlsOptions(ca, environment)
  t.is(new URL(readRedisUrl(environment)).hostname, '172.16.20.4')
  t.true(options.rejectUnauthorized)
  t.is(options.checkServerIdentity('172.16.20.4', certificate.toLegacyObject()), undefined)
  t.is(certificate.checkIP('51.15.196.212'), '51.15.196.212')
})
