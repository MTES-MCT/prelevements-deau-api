import test from 'ava'

import {validateDemoAdminDatabaseUrl} from '../database-target.js'

const password = 'secret'
const hostname = 'rw-ea5a07db-05df-4869-9e57-fa5f5c6c81cc.rdb.fr-par.scw.cloud'

function databaseUrl({
  protocol = 'postgresql',
  user = 'demo_admin',
  secret = password,
  host = hostname,
  port = '17063',
  database = 'prelevements_demo',
  sslmode = 'verify-full',
  sslrootcert = '/usr/local/share/ca-certificates/scw-postgres-ca.crt'
} = {}) {
  const searchParameters = new URLSearchParams()
  if (sslmode !== null) {
    searchParameters.set('sslmode', sslmode)
  }

  if (sslrootcert !== null) {
    searchParameters.set('sslrootcert', sslrootcert)
  }

  const query = searchParameters.size > 0 ? `?${searchParameters}` : ''
  return `${protocol}://${user}:${secret}@${host}:${port}/${database}${query}`
}

test('accepte le hostname public exact de PostgreSQL demo', t => {
  const parsed = validateDemoAdminDatabaseUrl(databaseUrl())

  t.is(parsed.hostname, hostname)
})

test('accepte l’adresse IP publique exacte de PostgreSQL demo', t => {
  const parsed = validateDemoAdminDatabaseUrl(databaseUrl({host: '163.172.7.73'}))

  t.is(parsed.hostname, '163.172.7.73')
})

test('refuse une autre instance PostgreSQL', t => {
  const error = t.throws(() => validateDemoAdminDatabaseUrl(
    databaseUrl({host: 'database.example.test'})
  ))

  t.regex(error.message, /instance PostgreSQL demo attendue/)
})

test('refuse un autre port', t => {
  const error = t.throws(() => validateDemoAdminDatabaseUrl(databaseUrl({port: '5432'})))

  t.regex(error.message, /port PostgreSQL demo doit être 17063/)
})

test('refuse une connexion sans vérification TLS complète', t => {
  const error = t.throws(() => validateDemoAdminDatabaseUrl(databaseUrl({sslmode: 'require'})))

  t.regex(error.message, /sslmode=verify-full/)
})

test('refuse une connexion sans le CA PostgreSQL demo explicite', t => {
  const error = t.throws(() => validateDemoAdminDatabaseUrl(databaseUrl({sslrootcert: null})))

  t.regex(error.message, /sslrootcert=.*scw-postgres-ca\.crt/)
})

test('refuse un autre certificat racine PostgreSQL', t => {
  const error = t.throws(() => validateDemoAdminDatabaseUrl(
    databaseUrl({sslrootcert: '/etc/ssl/certs/ca-certificates.crt'})
  ))

  t.regex(error.message, /sslrootcert=.*scw-postgres-ca\.crt/)
})

test('refuse une URL sans mot de passe', t => {
  const error = t.throws(() => validateDemoAdminDatabaseUrl(databaseUrl({secret: ''})))

  t.regex(error.message, /mot de passe de migration/)
})
