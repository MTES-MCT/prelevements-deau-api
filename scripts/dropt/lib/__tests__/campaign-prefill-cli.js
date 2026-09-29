import test from 'ava'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtemp, readFile, rm, stat, writeFile, symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import ExcelJS from 'exceljs'
import {CAMPAIGN_PREFILL_HEADERS} from '../campaign-prefill-source.js'
import {PROD_DATABASE_ENDPOINT} from '../../../network/prod-database-target.js'

const cwd = fileURLToPath(new URL('../../../../', import.meta.url))
const execute = promisify(execFile)
const run = (args, nodeArgs = []) => execute(process.execPath, [...nodeArgs, 'scripts/dropt/import-epidropt.js', ...args], {
  cwd, env: {...process.env, DATABASE_URL: 'deliberately-invalid-no-database-connection'}, timeout: 15_000
})

async function sourceFile(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dropt-prefill-cli-'))
  t.teardown(() => rm(directory, {recursive: true, force: true}))
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('BASE GLOBALE')
  sheet.addRow(CAMPAIGN_PREFILL_HEADERS)
  const row = Array(25).fill(null)
  Object.assign(row, {1: 'SYNTHETIC-POINT', 2: '00000000000001', 3: 50, 11: 10, 13: 20, 16: 0, 17: 'SYNTHETIC-COUNT', 21: 0})
  sheet.addRow(row)
  const filename = path.join(directory, 'synthetic.xlsx')
  await workbook.xlsx.writeFile(filename)
  return {directory, filename}
}

test('prepare-prefill reads source without connecting and writes a private off-repo report', async t => {
  const {directory, filename} = await sourceFile(t)
  const original = await readFile(filename)
  const report = path.join(directory, 'read-only.json')
  const {stdout} = await run(['prepare-prefill', '--prefill-file', filename, '--report', report])
  t.is(JSON.parse(stdout).summary.sourceRows, 1)
  t.is((await stat(report)).mode & 0o777, 0o600)
  const parsed = JSON.parse(await readFile(report, 'utf8'))
  t.is(parsed.records[0].needs.offSeason.volume, '30')
  t.deepEqual(await readFile(filename), original)
  t.false(stdout.includes('SYNTHETIC-POINT'))
})

test('report cannot overwrite original, previous report or symlink target', async t => {
  const {directory, filename} = await sourceFile(t)
  const original = await readFile(filename)
  await t.throwsAsync(run(['prepare-prefill', '--prefill-file', filename, '--report', filename]))
  const report = path.join(directory, 'existing.json')
  await writeFile(report, 'preserve previous review', {mode: 0o600})
  await t.throwsAsync(run(['prepare-prefill', '--prefill-file', filename, '--report', report]))
  t.is(await readFile(report, 'utf8'), 'preserve previous review')
  const linked = path.join(directory, 'source-alias.json')
  await symlink(filename, linked)
  await t.throwsAsync(run(['prepare-prefill', '--prefill-file', filename, '--report', linked]))
  t.deepEqual(await readFile(filename), original)
})

test('prepare rejects reports inside Git and never accepts --apply', async t => {
  const {directory, filename} = await sourceFile(t)
  const inGit = path.join(cwd, `must-not-create-${randomUUID()}.json`)
  const error = await t.throwsAsync(run(['prepare-prefill', '--prefill-file', filename, '--report', inGit]))
  t.regex(error.stderr, /hors de tout dépôt Git/)
  await t.throwsAsync(stat(inGit), {code: 'ENOENT'})
  await t.throwsAsync(run(['prepare-prefill', '--prefill-file', filename, '--report', path.join(directory, 'forbidden.json'), '--apply']))
})

test('prod rejects every operation other than campaign prefill and verification before reading any input', async t => {
  for (const operation of ['prepare', 'apply', 'review', 'verify', 'rebuild', 'recompute-rebuild', 'enable-logins', 'seed-campaign', 'prepare-prefill']) {
    const error = await t.throwsAsync(run([operation, '--target', 'prod']))
    t.regex(error.stderr, /prod est réservée à prefill-campaign et verify-prefill-campaign/)
  }
})

test('both prod campaign operations require an explicit environment file and tunnel', async t => {
  for (const operation of ['prefill-campaign', 'verify-prefill-campaign']) {
    for (const connection of [[], ['--target-env', '/must-not-read'], ['--tunnel-port', '15432']]) {
      const error = await t.throwsAsync(run([operation, '--target', 'prod', ...connection]))
      t.regex(error.stderr, /--target-env et --tunnel-port sont obligatoires pour prod/)
    }
  }
})

test('prod validates original database identity and TLS before constructing the tunnel', async t => {
  const {directory, filename} = await sourceFile(t)
  const base = `postgresql://prod-partageons-leau-api:synthetic-password@${PROD_DATABASE_ENDPOINT.host}:${PROD_DATABASE_ENDPOINT.port}/prod-partageons-leau-api`
    + '?sslmode=verify-full&sslrootcert=/usr/local/share/ca-certificates/scw-postgres-ca.crt'
  const invalid = [
    base.replace('/prod-partageons-leau-api?', '/testing-partageons-leau-api?'),
    base.replace('://prod-partageons-leau-api:', '://testing-partageons-leau-api:'),
    base.replace(PROD_DATABASE_ENDPOINT.host, 'localhost'),
    base.replace(`:${PROD_DATABASE_ENDPOINT.port}/`, ':15432/'),
    base.replace('verify-full', 'disable'),
    base.replace('/usr/local/share/ca-certificates/scw-postgres-ca.crt', '/tmp/untrusted.crt'),
    `${base}&sslmode=disable`, `${base}&host=localhost`, `${base}&sslaccept=accept_invalid_certs`
  ]
  const configuration = path.join(directory, 'synthetic.env')
  const args = ['prefill-campaign', '--target', 'prod', '--target-env', configuration, '--prefill-file', filename,
    '--campaign-id', randomUUID(), '--actor-user-id', randomUUID(), '--report', path.join(directory, 'rejected.json')]
  for (const value of invalid) {
    await writeFile(configuration, `DATABASE_URL=${value}\n`, {mode: 0o600})
    const error = await t.throwsAsync(run([...args, '--tunnel-port', '15432']))
    t.regex(error.stderr, /Refus :/)
    t.false(error.stderr.includes('synthetic-password'))
  }
  await writeFile(configuration, `DATABASE_URL=${base}\n`, {mode: 0o600})
  for (const port of ['0', '5432.5', '65536']) {
    const error = await t.throwsAsync(run([...args, '--tunnel-port', port]))
    t.regex(error.stderr, /port local explicite/)
  }
  await t.throwsAsync(stat(path.join(directory, 'rejected.json')), {code: 'ENOENT'})
})

test('prod verifies the connected identity and strict endpoint TLS before dispatch without real connections', async t => {
  const {directory, filename} = await sourceFile(t)
  const configuration = path.join(directory, 'synthetic.env')
  const preload = path.join(directory, 'synthetic-client.mjs')
  await writeFile(configuration, `DATABASE_URL=postgresql://prod-partageons-leau-api:synthetic-password@${PROD_DATABASE_ENDPOINT.host}:${PROD_DATABASE_ENDPOINT.port}/prod-partageons-leau-api?sslmode=verify-full&sslrootcert=/usr/local/share/ca-certificates/scw-postgres-ca.crt\n`, {mode: 0o600})
  const args = ['prefill-campaign', '--target', 'prod', '--target-env', configuration, '--tunnel-port', '15432',
    '--prefill-file', filename, '--campaign-id', randomUUID(), '--actor-user-id', randomUUID(), '--report', path.join(directory, 'rejected.json')]
  const valid = {databaseName: 'prod-partageons-leau-api', databaseUser: 'prod-partageons-leau-api', tls: true}
  for (const [identity, expected] of [
    [{...valid, databaseName: 'testing-partageons-leau-api'}, /nom de base/],
    [{...valid, databaseUser: 'testing-partageons-leau-api'}, /utilisateur/],
    [{...valid, tls: false}, /\(TLS\)/],
    [valid, /SYNTHETIC_PREFILL_REACHED/]
  ]) {
    await writeFile(preload, `
      globalThis.prisma = {
        async $queryRawUnsafe() {
          const {host, port, ssl} = globalThis.pgPool.options
          if (process.env.APP_ENV !== 'prod' || host !== '127.0.0.1' || port !== 15432
            || ssl.rejectUnauthorized !== true || !ssl.ca.includes('BEGIN CERTIFICATE')
            || ssl.checkServerIdentity('localhost', {subjectaltname: ${JSON.stringify(`IP Address:${PROD_DATABASE_ENDPOINT.host}`)}})) {
            throw new Error('SYNTHETIC_UNSAFE_CONNECTION')
          }
          return [${JSON.stringify(identity)}]
        },
        async $transaction() { throw new Error('SYNTHETIC_PREFILL_REACHED') },
        async $disconnect() {}
      }
    `, {mode: 0o600})
    const error = await t.throwsAsync(run(args, ['--import', preload]))
    t.regex(error.stderr, expected)
    t.false(error.stderr.includes('synthetic-password'))
  }
  await t.throwsAsync(stat(path.join(directory, 'rejected.json')), {code: 'ENOENT'})
})
