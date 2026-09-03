import test from 'ava'

import {
  assertConnectedDemoAdminDatabase,
  validateDemoAdminDatabaseUrl
} from '../database-target.js'

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

test('refuse les paramètres capables de surcharger l’autorité PostgreSQL', t => {
  for (const parameter of ['host', 'port', 'user', 'password', 'database', 'ssl']) {
    const error = t.throws(() => validateDemoAdminDatabaseUrl(
      `${databaseUrl()}&${parameter}=valeur-injectee`
    ))

    t.regex(error.message, new RegExp(`paramètre DATABASE_URL interdit \\(${parameter}\\)`))
  }
})

test('refuse les paramètres TLS dupliqués et les fragments', t => {
  const duplicatedSslMode = t.throws(() => validateDemoAdminDatabaseUrl(
    `${databaseUrl()}&sslmode=disable`
  ))
  const duplicatedCertificate = t.throws(() => validateDemoAdminDatabaseUrl(
    `${databaseUrl()}&sslrootcert=/tmp/other-ca.pem`
  ))
  const fragment = t.throws(() => validateDemoAdminDatabaseUrl(`${databaseUrl()}#ignored`))

  t.regex(duplicatedSslMode.message, /paramètre DATABASE_URL dupliqué \(sslmode\)/)
  t.regex(duplicatedCertificate.message, /paramètre DATABASE_URL dupliqué \(sslrootcert\)/)
  t.regex(fragment.message, /aucun fragment/)
})

test('contrôle l’identité réelle de la connexion PostgreSQL demo', async t => {
  const identity = {
    databaseName: 'prelevements_demo',
    databaseUser: 'demo_admin',
    serverAddress: '163.172.7.73',
    // Le port vu par PostgreSQL est celui du backend, pas celui du proxy public.
    serverPort: 5432,
    tls: true
  }
  const pgClient = {
    async query(query) {
      t.regex(query, /inet_server_addr/)
      return {rows: [identity]}
    }
  }
  const prismaClient = {
    async $queryRawUnsafe(query) {
      t.regex(query, /pg_stat_ssl/)
      return [identity]
    }
  }

  t.deepEqual(await assertConnectedDemoAdminDatabase(pgClient), identity)
  t.deepEqual(await assertConnectedDemoAdminDatabase(prismaClient), identity)
})

test('refuse toute dérive de l’identité PostgreSQL connectée', async t => {
  const identity = {
    databaseName: 'prelevements_demo',
    databaseUser: 'demo_admin',
    serverAddress: '163.172.7.73',
    serverPort: 17_063,
    tls: true
  }

  for (const [field, value, expectedMessage] of [
    ['databaseName', 'prod-partageons-leau-api', 'nom de base'],
    ['databaseUser', 'prod_admin', 'utilisateur'],
    ['tls', false, 'TLS']
  ]) {
    const database = {
      async query() {
        return {rows: [{...identity, [field]: value}]}
      }
    }
    const error = await t.throwsAsync(assertConnectedDemoAdminDatabase(database))

    t.true(error.message.includes(expectedMessage))
  }
})
