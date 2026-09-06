import fs from 'node:fs'
import {fileURLToPath} from 'node:url'

import test from 'ava'
import pg from 'pg'

import {getPostgresConnectionOptions} from './connection-options.js'

const certificatePath = fileURLToPath(new URL('../deploy/certs/demo/postgres-ca.pem', import.meta.url))
const certificate = fs.readFileSync(certificatePath, 'utf8')
const hostname = 'rw-ea5a07db-05df-4869-9e57-fa5f5c6c81cc.rdb.fr-par.scw.cloud'

function databaseUrl(host = '172.16.12.2') {
  const url = new URL(`postgresql://demo:fake%3Ap%40ss@${host}:5432/prelevements_demo`)
  url.searchParams.set('sslmode', 'verify-full')
  url.searchParams.set('sslrootcert', certificatePath)
  return url.toString()
}

test('conserve les connexions locales et les options existantes sans verify-full', t => {
  for (const connectionString of [undefined, '', 'postgresql://local:fake@localhost:5432/local', 'postgresql://local:fake@localhost/local?sslmode=disable']) {
    t.deepEqual(getPostgresConnectionOptions(connectionString, {max: 3}), {connectionString, max: 3})
  }
})

test('pg conserve le TLS explicite après son propre parsing de connectionString', t => {
  const options = getPostgresConnectionOptions(databaseUrl(), {
    max: 1,
    connectionTimeoutMillis: 5000,
    keepAlive: true
  })
  const client = new pg.Client(options)

  t.is(options.max, 1)
  t.is(options.connectionTimeoutMillis, 5000)
  t.true(options.keepAlive)
  t.is(client.connectionParameters.host, '172.16.12.2')
  t.is(client.connectionParameters.port, 5432)
  t.is(client.connectionParameters.database, 'prelevements_demo')
  t.is(client.connectionParameters.password, 'fake:p@ss')
  t.is(client.connectionParameters.ssl, options.ssl)
  t.true(client.connectionParameters.ssl.rejectUnauthorized)
  t.is(client.connectionParameters.ssl.ca, certificate)
  t.is(new URL(options.connectionString).searchParams.size, 0)
})

test('vérifie l’IP attendue même lorsque pg présente localhost à Node TLS', t => {
  const {ssl} = getPostgresConnectionOptions(databaseUrl())

  t.is(ssl.checkServerIdentity('localhost', {subjectaltname: 'IP Address:172.16.12.2'}), undefined)
  const mismatch = ssl.checkServerIdentity('localhost', {subjectaltname: 'IP Address:172.16.12.3'})
  t.is(mismatch.code, 'ERR_TLS_CERT_ALTNAME_INVALID')
})

test('conserve la validation du nom DNS et de la CA publique explicite', t => {
  const {ssl} = getPostgresConnectionOptions(databaseUrl(hostname))

  t.is(ssl.checkServerIdentity('localhost', {subjectaltname: `DNS:${hostname}`}), undefined)
  t.is(ssl.checkServerIdentity(hostname, {subjectaltname: 'DNS:other.invalid'}).code, 'ERR_TLS_CERT_ALTNAME_INVALID')
  t.is(ssl.ca, certificate)
})

test('normalise les crochets IPv6 seulement pour la vérification de certificat', t => {
  const options = getPostgresConnectionOptions(databaseUrl('[::1]'))
  const client = new pg.Client(options)

  t.is(client.connectionParameters.host, '[::1]')
  t.is(options.ssl.checkServerIdentity('localhost', {subjectaltname: 'IP Address:0:0:0:0:0:0:0:1'}), undefined)
  t.is(options.ssl.checkServerIdentity('localhost', {subjectaltname: 'IP Address:127.0.0.1'}).code, 'ERR_TLS_CERT_ALTNAME_INVALID')
})

test('aucune option du demandeur ne peut désactiver un verify-full demandé par l’URL', t => {
  const {ssl} = getPostgresConnectionOptions(databaseUrl(), {
    ssl: {rejectUnauthorized: false, ca: 'other-ca', checkServerIdentity: () => undefined}
  })

  t.true(ssl.rejectUnauthorized)
  t.is(ssl.ca, certificate)
  t.is(ssl.checkServerIdentity('172.16.12.2', {subjectaltname: 'IP Address:127.0.0.1'}).code, 'ERR_TLS_CERT_ALTNAME_INVALID')
})

test('préserve les paramètres non TLS nécessaires au client PostgreSQL', t => {
  const url = new URL(databaseUrl())
  url.searchParams.set('application_name', 'demo-network-check')
  const client = new pg.Client(getPostgresConnectionOptions(url.toString()))

  t.is(client.connectionParameters.application_name, 'demo-network-check')
  t.true(client.connectionParameters.ssl.rejectUnauthorized)
})

test('refuse les paramètres qui contournent la cible ou le mode TLS strict', t => {
  for (const parameter of ['host', 'port', 'user', 'password', 'database', 'ssl', 'sslaccept', 'sslidentity', 'sslnegotiation', 'sslpassword', 'uselibpqcompat']) {
    t.throws(() => getPostgresConnectionOptions(`${databaseUrl()}&${parameter}=injected`), {
      message: `DATABASE_URL TLS : paramètre incompatible (${parameter}).`
    })
  }
})

test('refuse sslnegotiation=direct qui remplacerait l’objet TLS strict lors du parsing pg', t => {
  const bypass = new pg.Client({
    connectionString: 'postgresql://demo:fake@172.16.12.2:5432/prelevements_demo?sslnegotiation=direct',
    ssl: {rejectUnauthorized: true, checkServerIdentity: () => undefined}
  })
  t.is(bypass.connectionParameters.ssl, true)

  t.throws(() => getPostgresConnectionOptions(`${databaseUrl()}&sslnegotiation=direct`), {
    message: 'DATABASE_URL TLS : paramètre incompatible (sslnegotiation).'
  })
})

test('refuse les paramètres TLS dupliqués indépendamment de leur ordre', t => {
  for (const connectionString of [
    `${databaseUrl()}&sslmode=disable`,
    databaseUrl().replace('sslmode=verify-full', 'sslmode=disable&sslmode=verify-full'),
    `${databaseUrl()}&sslrootcert=other.pem`
  ]) {
    t.throws(() => getPostgresConnectionOptions(connectionString), {message: /paramètre dupliqué/})
  }
})

test('refuse un chemin de certificat vide et une URL stricte ambiguë', t => {
  const emptyCertificate = new URL(databaseUrl())
  emptyCertificate.searchParams.set('sslrootcert', '')
  t.throws(() => getPostgresConnectionOptions(emptyCertificate.toString()), {message: /chemin vide/})
  t.throws(() => getPostgresConnectionOptions(`${databaseUrl()}#fragment`), {message: /sans fragment/})
  t.throws(() => getPostgresConnectionOptions(databaseUrl().replace('postgresql:', 'https:')), {message: /URL PostgreSQL/})
})

test('une URL malformée ne se retrouve pas dans le message d’erreur', t => {
  const error = t.throws(() => getPostgresConnectionOptions('invalid fake-secret-value'), {message: 'DATABASE_URL invalide.'})
  t.false(error.message.includes('fake-secret-value'))
  t.false(Object.hasOwn(error, 'input'))
})
