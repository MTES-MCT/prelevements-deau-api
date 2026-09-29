import {EventEmitter} from 'node:events'

import test from 'ava'
import request from 'supertest'

import {createMigrationService, getMigrationConfiguration} from '../testing-migration-service.js'
import {getPrismaDatabaseUrl} from '../prisma-database-url.js'
import {readMigrationStatus} from '../testing-migration-status.js'

import {TESTING_DATABASE_ENDPOINT} from '../testing-database-target.js'

const HOST = TESTING_DATABASE_ENDPOINT.host
const RELEASE = 'a'.repeat(40)
const SECRET = 'secret-of-this-migration-service-'.repeat(2)
const DATABASE_URL = `postgresql://testing-partageons-leau-api:database-secret@${HOST}:5432/testing-partageons-leau-api`
  + '?sslmode=verify-full&sslrootcert=/usr/local/share/ca-certificates/scw-postgres-ca.crt'
const ENVIRONMENT = {
  APP_ENV: 'testing',
  DATABASE_URL,
  MIGRATION_RELEASE_SHA: RELEASE,
  MIGRATION_INVOKE_SECRET: SECRET
}
const DATABASE_STATUS = {
  identity: {databaseName: 'testing-partageons-leau-api', databaseUser: 'testing-partageons-leau-api', tls: true},
  expectedCount: 1,
  pending: [],
  unfinished: [],
  migrations: []
}

function createService(t, overrides = {}) {
  const service = createMigrationService({
    environment: ENVIRONMENT,
    readStatus: async () => DATABASE_STATUS,
    spawn() {
      const child = new EventEmitter()
      setImmediate(() => child.emit('close', 0))
      return child
    },
    ...overrides
  })
  t.teardown(() => service.stop())
  return service
}

function postMigration(service, body) {
  return request(service.server).post('/migrate').set('X-Migration-Secret', SECRET)
    .send(body ?? {expectedRelease: RELEASE})
}

test('Prisma : conserve les URLs locales et anciennes sans changement', t => {
  for (const value of [undefined, '', 'postgresql://local:secret@localhost/db', 'postgres://u:p@host/db?sslmode=require']) {
    t.is(getPrismaDatabaseUrl(value), value)
  }
})

test('Prisma : traduit verify-full en TLS requis, validation stricte et CA explicite', t => {
  const parsed = new URL(getPrismaDatabaseUrl(DATABASE_URL))
  t.is(parsed.hostname, HOST)
  t.is(parsed.username, 'testing-partageons-leau-api')
  t.is(parsed.password, 'database-secret')
  t.is(parsed.searchParams.get('sslmode'), 'require')
  t.is(parsed.searchParams.get('sslaccept'), 'strict')
  t.is(parsed.searchParams.get('sslcert'), '/usr/local/share/ca-certificates/scw-postgres-ca.crt')
  t.false(parsed.searchParams.has('sslrootcert'))
  t.is(getPrismaDatabaseUrl(parsed.toString()), parsed.toString())
})

test('Prisma : refuse les réglages TLS ambigus ou faibles sans afficher les identifiants', t => {
  for (const suffix of ['&sslmode=disable', '&sslaccept=accept_invalid_certs', '&sslcert=/another-ca', '&sslrootcert=/another-ca']) {
    const error = t.throws(() => getPrismaDatabaseUrl(DATABASE_URL + suffix))
    t.false(error.message.includes('database-secret'))
  }

  const reversedModes = DATABASE_URL.replace('sslmode=verify-full', 'sslmode=disable&sslmode=verify-full')
  const error = t.throws(() => getPrismaDatabaseUrl(reversedModes))
  t.is(error.message, 'Paramètres TLS PostgreSQL dupliqués.')
  t.false(error.message.includes('database-secret'))
})

test('refuse un environnement, une cible, une identité, un TLS ou un secret non conformes', t => {
  const changes = [
    {APP_ENV: 'prod'},
    {APP_ENV: 'demo'},
    {APP_ENV: undefined},
    {MIGRATION_RELEASE_SHA: 'demo-latest'},
    {MIGRATION_INVOKE_SECRET: 'short'},
    {MIGRATION_TIMEOUT_SECONDS: '1201'},
    {MIGRATION_TIMEOUT_SECONDS: '0'},
    {DATABASE_URL: undefined},
    {DATABASE_URL: ''},
    {DATABASE_URL: 'not-a-database-url'},
    {DATABASE_URL: DATABASE_URL.replace('postgresql:', 'https:')},
    {DATABASE_URL: DATABASE_URL + '#fragment'},
    {DATABASE_URL: DATABASE_URL.replace('/testing-partageons-leau-api', '/prelevements_prod')},
    {DATABASE_URL: DATABASE_URL.replace('testing-partageons-leau-api', 'postgres')},
    {DATABASE_URL: DATABASE_URL.replace(`${HOST}:5432`, '51.15.219.67:24881')},
    {DATABASE_URL: DATABASE_URL.replace(`${HOST}:5432`, '163.172.7.73:17063')},
    {DATABASE_URL: DATABASE_URL.replace(`${HOST}:5432`, 'rw-ea5a07db-05df-4869-9e57-fa5f5c6c81cc.rdb.fr-par.scw.cloud:17063')},
    {DATABASE_URL: DATABASE_URL.replace(`${HOST}:5432`, '172.16.12.2:5432')},
    {DATABASE_URL: DATABASE_URL.replace(`${HOST}:5432`, '163.172.149.197:5826')},
    {DATABASE_URL: DATABASE_URL.replace(`${HOST}:5432`, 'rw-a94bb20e-1f62-4203-9b60-234c12170876.rdb.fr-par.scw.cloud:5826')},
    {DATABASE_URL: DATABASE_URL.replace(`${HOST}:5432`, 'localhost:5432')},
    {DATABASE_URL: DATABASE_URL.replace('verify-full', 'disable')},
    {DATABASE_URL: DATABASE_URL + '&host=prod'},
    {DATABASE_URL: DATABASE_URL + '&sslmode=disable'}
  ]
  for (const change of changes) {
    t.throws(() => getMigrationConfiguration({...ENVIRONMENT, ...change}))
  }
})

test('healthz ne connecte pas PostgreSQL et ne lance aucune migration', async t => {
  const service = createService(t, {
    readStatus() {
      t.fail('Aucune lecture SQL ne doit être déclenchée')
    },
    spawn() {
      t.fail('Aucun processus ne doit démarrer')
    }
  })
  const response = await request(service.server).get('/healthz')
  t.is(response.status, 200)
  t.deepEqual(response.body, {ok: true, service: 'testing-migrations', release: RELEASE})
})

test('status et migration refusent tout secret absent ou faux avant la lecture SQL', async t => {
  const service = createService(t, {
    readStatus() {
      t.fail('Une requête non authentifiée ne doit pas atteindre PostgreSQL')
    }
  })
  for (const endpoint of ['/status', '/migrate']) {
    const missing = await request(service.server).get(endpoint)
    const wrong = await request(service.server).post(endpoint).set('X-Migration-Secret', 'incorrect').send({expectedRelease: RELEASE})
    t.is(missing.status, 403)
    t.is(wrong.status, 403)
  }
})

test('status authentifié lit le registre sans déclencher la commande', async t => {
  const service = createService(t, {
    spawn() {
      t.fail('GET /status ne doit jamais lancer Prisma migrate')
    }
  })
  const response = await request(service.server).get('/status').set('X-Migration-Secret', SECRET)
  t.is(response.status, 200)
  t.is(response.body.release, RELEASE)
  t.is(response.body.state, 'idle')
  t.deepEqual(response.body.database, DATABASE_STATUS)
})

test('refuse une mauvaise release et toute entrée autre que expectedRelease', async t => {
  const service = createService(t, {
    readStatus() {
      t.fail('Les requêtes invalides ne doivent pas lire PostgreSQL')
    }
  })
  const wrongRelease = await postMigration(service, {expectedRelease: 'b'.repeat(40)})
  t.is(wrongRelease.status, 409)
  t.is(wrongRelease.body.errorCode, 'RELEASE_MISMATCH')
  for (const body of [{}, {expectedRelease: RELEASE, sql: 'DROP DATABASE'}, {expectedRelease: RELEASE, databaseUrl: DATABASE_URL}, {expectedRelease: RELEASE, command: 'echo'}, []]) {
    const response = await postMigration(service, body)
    t.is(response.status, 400)
  }
})

test('commande fixe, URL CLI strictement traduite, aucun secret secondaire transmis au processus', async t => {
  let spawnCount = 0
  let statusCount = 0
  const service = createService(t, {
    async readStatus(url) {
      t.is(url, DATABASE_URL)
      statusCount++
      return DATABASE_STATUS
    },
    spawn(command, args, options) {
      spawnCount++
      t.regex(command, /node$/)
      t.regex(args[0], /node_modules\/prisma\/build\/index\.js$/)
      t.deepEqual(args.slice(1), ['migrate', 'deploy'])
      t.is(options.stdio, 'ignore')
      t.is(options.env.DATABASE_URL, getPrismaDatabaseUrl(DATABASE_URL))
      t.is(options.env.MIGRATION_INVOKE_SECRET, undefined)
      const child = new EventEmitter()
      setImmediate(() => child.emit('close', 0))
      return child
    }
  })
  const response = await postMigration(service)
  t.is(response.status, 200)
  t.is(response.body.state, 'succeeded')
  t.is(response.body.operation.exitCode, 0)
  t.is(spawnCount, 1)
  t.is(statusCount, 2)
  t.false(JSON.stringify(response.body).includes('database-secret'))
  t.false(JSON.stringify(response.body).includes(SECRET))
})

test('une seule opération est admise, le second appel obtient le même identifiant en conflit', async t => {
  let child
  let started
  const start = new Promise(resolve => {
    started = resolve
  })
  const service = createService(t, {
    spawn() {
      child = new EventEmitter()
      started()
      return child
    }
  })
  const firstRequest = postMigration(service).then(response => response)
  await start
  const conflict = await postMigration(service)
  t.is(conflict.status, 409)
  t.is(conflict.body.errorCode, 'MIGRATION_IN_PROGRESS')
  const status = await request(service.server).get('/status').set('X-Migration-Secret', SECRET)
  t.is(status.body.state, 'running')
  t.is(status.body.operation.id, conflict.body.operation.id)
  child.emit('close', 0)
  const response = await firstRequest
  t.is(response.body.operation.id, conflict.body.operation.id)
  t.is(response.body.state, 'succeeded')
})

test('un échec de contrôle PostgreSQL interdit le démarrage et masque son erreur brute', async t => {
  const service = createService(t, {
    readStatus() {
      throw new Error(`password=${SECRET} ${DATABASE_URL}`)
    },
    spawn() {
      t.fail('La cible doit être validée avant la commande')
    }
  })
  const response = await postMigration(service)
  t.is(response.status, 503)
  t.is(response.body.state, 'unknown')
  t.is(response.body.operation.errorCode, 'DATABASE_STATUS_UNAVAILABLE')
  t.false(JSON.stringify(response.body).includes('database-secret'))
  t.false(JSON.stringify(response.body).includes(SECRET))
})

test('Prisma non zéro et un registre incomplet ne sont jamais des succès', async t => {
  for (const exitCode of [0, 1]) {
    const service = createService(t, {
      readStatus: async () => ({...DATABASE_STATUS, pending: ['20260906_pending']}),
      spawn() {
        const child = new EventEmitter()
        setImmediate(() => child.emit('close', exitCode))
        return child
      }
    })
    const response = await postMigration(service)
    t.is(response.status, 503)
    t.is(response.body.state, 'failed')
  }
})

test('timeout : termine le processus, relit le registre, ne relance pas la migration', async t => {
  let spawnCount = 0
  let statusCount = 0
  const signals = []
  const service = createService(t, {
    environment: {...ENVIRONMENT, MIGRATION_TIMEOUT_SECONDS: '1'},
    async readStatus() {
      statusCount++
      return DATABASE_STATUS
    },
    spawn() {
      spawnCount++
      const child = new EventEmitter()
      child.kill = signal => {
        signals.push(signal)
        setImmediate(() => child.emit('close', null))
      }

      return child
    }
  })
  const response = await postMigration(service)
  t.is(response.status, 503)
  t.is(response.body.state, 'unknown')
  t.is(response.body.operation.errorCode, 'MIGRATION_TIMEOUT')
  t.deepEqual(signals, ['SIGTERM'])
  t.is(spawnCount, 1)
  t.is(statusCount, 2)
  const replay = await postMigration(service)
  t.is(replay.status, 409)
  t.is(replay.body.errorCode, 'MIGRATION_REQUIRES_REVIEW')
  t.is(spawnCount, 1)
})

test('le statut utilise uniquement une transaction lecture seule, vérifie la cible et déconnecte', async t => {
  const queries = []
  let disconnected = false
  const appliedMigration = {name: '20260906_applied', finishedAt: new Date(), rolledBackAt: null}
  const transaction = {
    async $executeRawUnsafe(sql) {
      queries.push(sql)
    },
    async $queryRawUnsafe(sql) {
      queries.push(sql)
      if (sql.includes('current_database()')) {
        return [DATABASE_STATUS.identity]
      }

      if (sql.includes('to_regclass')) {
        return [{present: true}]
      }

      return [appliedMigration]
    }
  }
  const status = await readMigrationStatus(DATABASE_URL, {
    createPrisma: async () => ({
      async $transaction(callback, options) {
        t.deepEqual(options, {maxWait: 5000, timeout: 15_000})
        return callback(transaction)
      },
      async $disconnect() {
        disconnected = true
      }
    }),
    readDirectory: async () => ['20260906_applied', '20260907_pending', '20260309093415'].map(name => ({name, isDirectory: () => true}))
  })
  t.is(queries[0], 'SET TRANSACTION READ ONLY')
  t.is(queries[1], 'SET LOCAL statement_timeout = \'10s\'')
  t.true(queries.slice(2).every(sql => sql.trim().startsWith('SELECT')))
  t.false(queries.join('\n').includes('logs'))
  t.deepEqual(status.pending, ['20260309093415', '20260907_pending'])
  t.deepEqual(status.unfinished, [])
  t.true(disconnected)
})

test('un arrêt à vide ne déclenche ni SQL ni migration', async t => {
  const service = createMigrationService({
    environment: ENVIRONMENT,
    readStatus() {
      t.fail('Arrêter un service à vide ne doit pas interroger PostgreSQL')
    },
    spawn() {
      t.fail('Arrêter un service à vide ne doit pas lancer de commande')
    }
  })
  await t.notThrowsAsync(service.stop())
})

test('un arrêt pendant une migration termine la commande sans déclarer de succès', async t => {
  let started
  const start = new Promise(resolve => {
    started = resolve
  })
  const signals = []
  const service = createService(t, {
    spawn() {
      const child = new EventEmitter()
      child.kill = signal => {
        signals.push(signal)
        setImmediate(() => child.emit('close', null))
      }

      started()
      return child
    }
  })
  const migrating = postMigration(service).then(response => response)
  await start
  await service.stop()
  const response = await migrating
  t.is(response.status, 503)
  t.is(response.body.operation.errorCode, 'SERVICE_STOPPING')
  t.is(response.body.state, 'unknown')
  t.deepEqual(signals, ['SIGTERM'])
})
