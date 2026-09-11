import {execFile} from 'node:child_process'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import test from 'ava'

const execute = promisify(execFile)
const projectDirectory = fileURLToPath(new URL('../../../', import.meta.url))
const configurationPath = path.join(projectDirectory, 'prisma.config.ts')
const prismaConfigurationEntry = import.meta.resolve('prisma/config')

async function loadProjectConfiguration(t, databaseUrl) {
  // The real loader runs in a fresh process and an empty working directory:
  // it cannot read the developer's .env files or inherit database credentials.
  const directory = await mkdtemp(path.join(tmpdir(), 'ple-prisma-config-test-'))
  t.teardown(() => rm(directory, {recursive: true, force: true}))
  const source = `
    import {createRequire} from 'node:module'
    import process from 'node:process'
    const require = createRequire(${JSON.stringify(prismaConfigurationEntry)})
    const {loadConfigFromFile} = require('@prisma/config')
    const result = await loadConfigFromFile({
      configFile: ${JSON.stringify(configurationPath)},
      configRoot: ${JSON.stringify(projectDirectory)}
    })
    console.log(JSON.stringify({
      config: result.config,
      resolvedPath: result.resolvedPath,
      error: result.error && {type: result.error._tag, message: result.error.error?.message},
      databaseUrl: process.env.DATABASE_URL
    }))
  `
  const {stdout} = await execute(process.execPath, ['--input-type=module', '-e', source], {
    cwd: directory,
    env: {NODE_ENV: 'test', APP_ENV: 'test', DATABASE_URL: databaseUrl},
    timeout: 20_000
  })
  return JSON.parse(stdout)
}

test('Prisma charge le vrai fichier TypeScript avec ses chemins de schéma et de migrations', async t => {
  const databaseUrl = 'postgresql://fixture:fixture@127.0.0.1:55439/security_tests'
  const result = await loadProjectConfiguration(t, databaseUrl)
  t.is(result.error, undefined)
  t.is(result.resolvedPath, configurationPath)
  t.is(result.config.loadedFromFile, configurationPath)
  t.is(result.config.schema, path.join(projectDirectory, 'prisma/schema'))
  t.deepEqual(result.config.migrations, {path: path.join(projectDirectory, 'prisma/migrations')})
  t.deepEqual(result.config.datasource, {url: databaseUrl})
  t.is(result.databaseUrl, databaseUrl)
})

test('Prisma peut charger la configuration sans URL pour générer le client hors connexion', async t => {
  const result = await loadProjectConfiguration(t, '')
  t.is(result.error, undefined)
  t.is(result.config.datasource.url, '')
  t.is(result.config.schema, path.join(projectDirectory, 'prisma/schema'))
  t.is(result.databaseUrl, '')
})

test('le chargement Prisma conserve le certificat et la validation TLS stricte sans modifier l’environnement', async t => {
  const databaseUrl = 'postgresql://fixture:fixture@127.0.0.1:55439/security_tests?sslmode=verify-full&sslrootcert=%2Ftmp%2Ffixture-ca.pem'
  const result = await loadProjectConfiguration(t, databaseUrl)
  t.is(result.error, undefined)
  const resolvedUrl = new URL(result.config.datasource.url)
  t.is(resolvedUrl.searchParams.get('sslmode'), 'require')
  t.is(resolvedUrl.searchParams.get('sslaccept'), 'strict')
  t.is(resolvedUrl.searchParams.get('sslcert'), '/tmp/fixture-ca.pem')
  t.false(resolvedUrl.searchParams.has('sslrootcert'))
  t.is(result.databaseUrl, databaseUrl)
})

test('le vrai chargeur Prisma refuse une configuration qui désactive la vérification TLS', async t => {
  const result = await loadProjectConfiguration(t,
    'postgresql://fixture:fixture@127.0.0.1:55439/security_tests?sslmode=verify-full&sslaccept=accept_invalid_certs')
  t.is(result.config, undefined)
  t.is(result.error.type, 'ConfigLoadError')
  t.true(result.error.message.includes('Refus de désactiver la validation TLS Prisma.'))
})

test('le vrai chargeur Prisma refuse une URL invalide et conserve l’erreur contrôlée', async t => {
  const result = await loadProjectConfiguration(t, 'invalid-database-url')
  t.is(result.config, undefined)
  t.is(result.error.type, 'ConfigLoadError')
  t.true(result.error.message.includes('DATABASE_URL invalide pour Prisma.'))
})
