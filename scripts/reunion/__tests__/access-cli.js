import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {promisify} from 'node:util'
import test from 'ava'
import {TESTING_DATABASE_ENDPOINT} from '../../network/testing-database-target.js'
import {PROD_DATABASE_ENDPOINT} from '../../network/prod-database-target.js'
import {accessConnectionOptions, reservePrivateReport, validateAccessBackup} from '../lib/access-cli.js'

const runFile = promisify(execFile)
const certificatePath = '/usr/local/share/ca-certificates/scw-postgres-ca.crt'

async function privateDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'reunion-access-cli-test-'))
  t.teardown(() => rm(directory, {recursive: true, force: true}))
  return directory
}

function targetConfiguration(target) {
  const endpoint = target === 'testing' ? TESTING_DATABASE_ENDPOINT : PROD_DATABASE_ENDPOINT
  const identity = `${target}-partageons-leau-api`
  const url = new URL(`postgresql://${identity}:synthetic-password@${endpoint.host}:${endpoint.port}/${identity}`)
  url.searchParams.set('sslmode', 'verify-full')
  url.searchParams.set('sslrootcert', certificatePath)
  return {DATABASE_URL: url.toString()}
}

test('reserves a new private JSON report and never overwrites an existing file', async t => {
  const directory = await privateDirectory(t)
  const filename = path.join(directory, 'new', 'report.json')
  const report = await reservePrivateReport(filename)
  try {
    await report.writeFile('{"synthetic":true}\n')
    t.is((await report.stat()).mode & 0o777, 0o600)
  } finally {
    await report.close()
  }

  t.is((await stat(path.dirname(filename))).mode & 0o777, 0o700)
  await t.throwsAsync(reservePrivateReport(filename), {code: 'EEXIST'})
  t.is(await readFile(filename, 'utf8'), '{"synthetic":true}\n')
  await t.throwsAsync(reservePrivateReport(path.join(directory, 'report.txt')), {message: /nouveau fichier .json privé/u})
})

test('refuses report paths inside a Git checkout even through directory symlinks', async t => {
  const directory = await privateDirectory(t)
  const checkout = path.join(directory, 'checkout')
  await mkdir(checkout)
  await runFile('git', ['init', '--quiet', checkout])
  await t.throwsAsync(reservePrivateReport(path.join(checkout, 'report.json')), {message: /hors de tout dépôt Git/u})
  await t.throwsAsync(reservePrivateReport(path.join(checkout, '.git', 'report.json')), {message: /hors de tout dépôt Git/u})
  const linked = path.join(directory, 'linked-checkout')
  await symlink(checkout, linked, 'dir')
  await t.throwsAsync(reservePrivateReport(path.join(linked, 'report.json')), {message: /hors de tout dépôt Git/u})
  const bare = path.join(directory, 'bare.git')
  await runFile('git', ['init', '--bare', '--quiet', bare])
  await t.throwsAsync(reservePrivateReport(path.join(bare, 'report.json')), {message: /hors de tout dépôt Git/u})
})

test('refuses a report filename that is already a symlink', async t => {
  const directory = await privateDirectory(t)
  const original = path.join(directory, 'original.json')
  await writeFile(original, 'synthetic original', {mode: 0o600})
  const linked = path.join(directory, 'linked.json')
  await symlink(original, linked)
  await t.throwsAsync(reservePrivateReport(linked), {code: 'EEXIST'})
  t.is(await readFile(original, 'utf8'), 'synthetic original')
})

test('validates restored backup evidence against the actual backup bytes and exact target', async t => {
  const directory = await privateDirectory(t)
  const backupFile = path.join(directory, 'backup.dump')
  const bytes = 'synthetic PostgreSQL backup fixture'
  await writeFile(backupFile, bytes, {mode: 0o600})
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const evidenceFile = path.join(directory, 'evidence.json')
  await writeFile(evidenceFile, JSON.stringify({target: 'testing', backupFile, backup: {sha256}, restore: {success: true, matchesPreflight: true}}), {mode: 0o600})
  t.deepEqual(await validateAccessBackup(evidenceFile, 'testing'), {sha256, evidence: evidenceFile})
  await t.throwsAsync(validateAccessBackup(evidenceFile, 'prod'), {message: /même cible obligatoire/u})
  await writeFile(backupFile, 'modified synthetic bytes', {mode: 0o600})
  await t.throwsAsync(validateAccessBackup(evidenceFile, 'testing'), {message: /Empreinte de la sauvegarde différente/u})
})

test('rejects backup evidence without successful restoration and preflight reconciliation', async t => {
  const directory = await privateDirectory(t)
  const evidenceFile = path.join(directory, 'evidence.json')
  const evidence = {target: 'testing', backupFile: path.join(directory, 'absent.dump'), backup: {sha256: '1'.repeat(64)}, restore: {success: true, matchesPreflight: true}}
  await t.throwsAsync(validateAccessBackup(undefined, 'testing'), {message: /backup-evidence/u})
  for (const replacement of [
    {restore: {success: false, matchesPreflight: true}},
    {restore: {success: true, matchesPreflight: false}},
    {restore: {success: 'true', matchesPreflight: true}},
    {backup: {sha256: 'invalid'}},
    {backupFile: ''}
  ]) {
    await writeFile(evidenceFile, JSON.stringify({...evidence, ...replacement}), {mode: 0o600})
    await t.throwsAsync(validateAccessBackup(evidenceFile, 'testing'), {message: /même cible obligatoire/u})
  }
})

test('tunnels locally while authenticating TLS against the configured database endpoint', t => {
  for (const target of ['testing', 'prod']) {
    const endpoint = target === 'testing' ? TESTING_DATABASE_ENDPOINT : PROD_DATABASE_ENDPOINT
    const configuration = targetConfiguration(target)
    const original = configuration.DATABASE_URL
    const options = accessConnectionOptions(configuration, {target, tunnelPort: '15432'})
    t.is(options.host, '127.0.0.1')
    t.is(options.port, 15432)
    t.is(options.database, `${target}-partageons-leau-api`)
    t.is(options.user, `${target}-partageons-leau-api`)
    t.true(options.ssl.rejectUnauthorized)
    t.regex(options.ssl.ca, /BEGIN CERTIFICATE/u)
    t.is(options.ssl.checkServerIdentity('localhost', {subjectaltname: `IP Address:${endpoint.host}`}), undefined)
    t.truthy(options.ssl.checkServerIdentity('localhost', {subjectaltname: 'IP Address:127.0.0.1'}))
    t.false(Object.hasOwn(options, 'connectionString'))
    t.is(configuration.DATABASE_URL, original)
  }
})

test('rejects unsupported targets, ambiguous tunnel ports, wrong database and TLS weakening', t => {
  const configuration = targetConfiguration('testing')
  for (const target of [undefined, 'demo', 'production']) {
    t.throws(() => accessConnectionOptions(configuration, {target, tunnelPort: '15432'}), {message: /cible explicite local, testing ou prod/u})
  }

  for (const tunnelPort of [undefined, '', '1023', '65536', '1e4', '15432x', '+15432']) {
    t.throws(() => accessConnectionOptions(configuration, {target: 'testing', tunnelPort}), {message: /tunnel-port/u})
  }

  t.throws(() => accessConnectionOptions(configuration, {target: 'prod', tunnelPort: '15432'}), {message: /Refus/u})
  for (const mutate of [
    url => { url.hostname = 'example.test' },
    url => { url.username = 'wrong-user' },
    url => { url.pathname = '/wrong-database' },
    url => { url.searchParams.set('sslmode', 'disable') },
    url => { url.searchParams.append('sslmode', 'verify-full') },
    url => { url.searchParams.set('sslrootcert', '/tmp/untrusted-ca.pem') },
    url => { url.searchParams.set('host', 'example.test') }
  ]) {
    const url = new URL(configuration.DATABASE_URL)
    mutate(url)
    const error = t.throws(() => accessConnectionOptions({DATABASE_URL: url.toString()}, {target: 'testing', tunnelPort: '15432'}))
    t.false(error.message.includes('synthetic-password'))
  }
})

test('requires a previous report for apply and verify before opening files or connections', async t => {
  const common = ['--access-file', '/synthetic-absent/access.ods', '--effective-date', '2026-10-05', '--report', '/synthetic-absent/report.json']
  const moduleUrl = new URL('../lib/access-cli.js', import.meta.url).href
  // AVA uses workers, where process.umask cannot be set; exercise the real CLI process.
  const program = `import {runAccessCommand} from ${JSON.stringify(moduleUrl)}; try { await runAccessCommand(process.argv.slice(1)) } catch (error) { console.error(error.message); process.exitCode = 1 }`
  for (const [arguments_, expected] of [
    [['access-apply', ...common, '--apply'], /against-report/u],
    [['access-verify', ...common], /against-report/u],
    [['access-prepare', ...common, '--apply'], /réservé à access-apply/u],
    [['access-unknown', ...common], /Commande access-prepare/u]
  ]) {
    const error = await t.throwsAsync(runFile(process.execPath, ['--input-type=module', '-e', program, ...arguments_]), {code: 1})
    t.regex(error.stderr, expected)
  }
})

test('the migration entrypoint dispatches access commands with sanitized errors and preserves legacy help', async t => {
  const entrypoint = path.resolve(import.meta.dirname, '../migrate-reunion.js')
  const sensitiveMarker = 'synthetic-contact@example.test'
  const error = await t.throwsAsync(runFile(process.execPath, [entrypoint, 'access-prepare', `--${sensitiveMarker}`]), {code: 1})
  t.regex(error.stderr, /\[reunion-access\]/u)
  t.false(error.stderr.includes(sensitiveMarker))
  t.is(error.stdout, '')
  const {stdout} = await runFile(process.execPath, [entrypoint, '--help'])
  t.regex(stdout, /snapshot\|preflight\|apply\|verify\|all/u)
})


test('local access is restricted to the isolated reunion stack', t => {
  const configuration = {APP_ENV: 'reunion-local', DATABASE_URL: 'postgresql://pe_reunion:synthetic@127.0.0.1:5433/pe_reunion'}
  t.deepEqual(accessConnectionOptions(configuration, {target: 'local'}), {
    host: '127.0.0.1', port: 5433, user: 'pe_reunion', password: 'synthetic', database: 'pe_reunion',
    ssl: false, max: 2, connectionTimeoutMillis: 10_000
  })
  for (const replacement of [
    {APP_ENV: 'testing'},
    {DATABASE_URL: configuration.DATABASE_URL.replace('5433', '5432')},
    {DATABASE_URL: configuration.DATABASE_URL.replace('127.0.0.1', 'example.test')},
    {DATABASE_URL: `${configuration.DATABASE_URL}?options=-c%20search_path=other`}
  ]) t.throws(() => accessConnectionOptions({...configuration, ...replacement}, {target: 'local'}))
  t.throws(() => accessConnectionOptions(configuration, {target: 'local', tunnelPort: '5433'}))
})
