import {mkdtemp, readdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'

import test from 'ava'

import {
  authorizeLegacyDemoMutation,
  legacyConfirmationFor
} from '../legacy-demo-guard.js'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const demoDirectory = path.resolve(testDirectory, '..')
const projectDirectory = path.resolve(demoDirectory, '../..')
const LOCAL_MUTATION_ENVIRONMENT = Object.freeze({
  APP_ENV: 'local',
  DATABASE_URL: 'postgresql://legacy:secret@127.0.0.1:5432/legacy_demo',
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  REDIS_URL: 'redis://127.0.0.1:6379',
  ORCHESTRATION_BASE_URL: 'http://127.0.0.1:4000'
})

function runLegacyScript(scriptName, arguments_ = [], environment = {}) {
  return spawnSync(process.execPath, [path.join(demoDirectory, scriptName), ...arguments_], {
    cwd: projectDirectory,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      ...environment
    },
    encoding: 'utf8'
  })
}

function runLegacyShell(arguments_ = [], environment = {}) {
  return spawnSync('sh', [path.join(demoDirectory, 'import-demo-data.sh'), ...arguments_], {
    cwd: projectDirectory,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      ...environment
    },
    encoding: 'utf8'
  })
}

test('les scripts legacy sont en dry-run par défaut sur local et demo', t => {
  for (const environmentName of ['local', 'demo']) {
    const authorization = authorizeLegacyDemoMutation({
      arguments_: [],
      environment: {APP_ENV: environmentName}
    })

    t.deepEqual(authorization, {
      authorized: false,
      dryRun: true,
      environmentName,
      expectedConfirmation: legacyConfirmationFor(environmentName)
    })
  }
})

test('les scripts legacy refusent testing, staging et production', t => {
  for (const environmentName of ['testing', 'staging', 'prod', 'production']) {
    const error = t.throws(() => authorizeLegacyDemoMutation({
      arguments_: [],
      environment: {APP_ENV: environmentName}
    }))

    t.regex(error.message, /environnement .* interdit/)
  }
})

test('une écriture legacy exige le flag et la confirmation liée à la cible', t => {
  const missingConfirmation = t.throws(() => authorizeLegacyDemoMutation({
    arguments_: ['--apply'],
    environment: {APP_ENV: 'demo'}
  }))
  const wrongTarget = t.throws(() => authorizeLegacyDemoMutation({
    arguments_: ['--apply', '--confirm-legacy=APPLY_LEGACY_AQUASYS:local'],
    environment: {APP_ENV: 'demo'}
  }))
  const authorized = authorizeLegacyDemoMutation({
    arguments_: ['--apply', '--confirm-legacy=APPLY_LEGACY_AQUASYS:local'],
    environment: LOCAL_MUTATION_ENVIRONMENT,
    requireLocalServices: true
  })

  t.regex(missingConfirmation.message, /ajouter --confirm-legacy/)
  t.regex(wrongTarget.message, /APPLY_LEGACY_AQUASYS:demo/)
  t.true(authorized.authorized)
  t.false(authorized.dryRun)
})

test('neutralise tout apply legacy sur demo ou sans APP_ENV explicite', t => {
  const remoteDemo = t.throws(() => authorizeLegacyDemoMutation({
    arguments_: ['--apply', '--confirm-legacy=APPLY_LEGACY_AQUASYS:demo'],
    environment: {APP_ENV: 'demo'}
  }))
  const implicitDevelopment = t.throws(() => authorizeLegacyDemoMutation({
    arguments_: ['--apply', '--confirm-legacy=APPLY_LEGACY_AQUASYS:development'],
    environment: {
      ...LOCAL_MUTATION_ENVIRONMENT,
      APP_ENV: undefined,
      NODE_ENV: 'development'
    }
  }))

  t.regex(remoteDemo.message, /cibles demo et distantes sont neutralisées/)
  t.regex(implicitDevelopment.message, /APP_ENV doit être explicitement définie/)
})

test('refuse un PostgreSQL distant ou surchargé même avec confirmation', t => {
  for (const databaseUrl of [
    'postgresql://legacy:secret@database.example.test:5432/legacy_demo',
    `${LOCAL_MUTATION_ENVIRONMENT.DATABASE_URL}?host=database.example.test`
  ]) {
    const error = t.throws(() => authorizeLegacyDemoMutation({
      arguments_: ['--apply', '--confirm-legacy=APPLY_LEGACY_AQUASYS:local'],
      environment: {...LOCAL_MUTATION_ENVIRONMENT, DATABASE_URL: databaseUrl}
    }))

    t.regex(error.message, /DATABASE_URL (?:doit cibler loopback|ne doit contenir)/)
  }
})

test('refuse chaque service externe distant ou absent avant l’import complet', t => {
  for (const [variableName, remoteUrl] of [
    ['S3_ENDPOINT', 'https://s3.example.test'],
    ['REDIS_URL', 'rediss://redis.example.test:6380'],
    ['ORCHESTRATION_BASE_URL', 'https://orchestration.example.test']
  ]) {
    const remoteError = t.throws(() => authorizeLegacyDemoMutation({
      arguments_: ['--apply', '--confirm-legacy=APPLY_LEGACY_AQUASYS:local'],
      environment: {...LOCAL_MUTATION_ENVIRONMENT, [variableName]: remoteUrl},
      requireLocalServices: true
    }))
    const missingError = t.throws(() => authorizeLegacyDemoMutation({
      arguments_: ['--apply', '--confirm-legacy=APPLY_LEGACY_AQUASYS:local'],
      environment: {...LOCAL_MUTATION_ENVIRONMENT, [variableName]: undefined},
      requireLocalServices: true
    }))

    t.regex(remoteError.message, new RegExp(`${variableName} doit cibler loopback`))
    t.regex(missingError.message, new RegExp(`${variableName} est requise`))
  }
})

test('l’orchestrateur legacy ne lance aucune sous-commande en dry-run', t => {
  const result = runLegacyShell([], {APP_ENV: 'local'})

  t.is(result.status, 0)
  t.regex(result.stdout, /dry-run : aucune écriture effectuée/)
  t.regex(result.stdout, /--confirm-legacy=APPLY_LEGACY_AQUASYS:local/)
})

test('les deux scripts historiques directs appliquent aussi le garde avant mutation', async t => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'legacy-demo-guard-'))
  t.teardown(() => rm(temporaryDirectory, {recursive: true, force: true}))

  for (const scriptName of ['init-demo-fixtures.js', 'init-demo-declarations.js']) {
    const result = runLegacyScript(scriptName, [], {
      APP_ENV: 'local',
      TMPDIR: temporaryDirectory
    })

    t.is(result.status, 0)
    t.regex(result.stdout, /dry-run : aucune écriture effectuée/)
  }

  t.deepEqual(await readdir(temporaryDirectory), [])
})

test('l’orchestrateur legacy refuse testing avant toute sous-commande', t => {
  const result = runLegacyScript('run-legacy-import.js', [], {APP_ENV: 'testing'})

  t.is(result.status, 1)
  t.regex(result.stderr, /environnement testing interdit/)
})
