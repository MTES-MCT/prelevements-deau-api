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

const cwd = fileURLToPath(new URL('../../../../', import.meta.url))
const execute = promisify(execFile)
const run = args => execute(process.execPath, ['scripts/dropt/import-epidropt.js', ...args], {
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
