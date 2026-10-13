import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const readJson = file => JSON.parse(readFileSync(file, 'utf8'))
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
export const shardTotal = 2
const failures = ['failedHooks', 'failedTests', 'failedWorkers', 'internalErrors', 'remainingTests', 'sharedWorkerErrors', 'timeouts', 'timedOutTests', 'uncaughtExceptions', 'unexpectedProcessExits', 'unhandledRejections']

// These are the locked AVA implementation's own discovery and partition functions.
// An AVA upgrade must explicitly revalidate its observer and inventory contract.
export async function inventory() {
  const avaRoot = path.join(root, 'node_modules/ava')
  assert.equal(readJson(path.join(avaRoot, 'package.json')).version, '8.0.1', 'Revalidate CI sharding for this AVA version')
  const {findTests, normalizeGlobs} = await import(pathToFileURL(path.join(avaRoot, 'lib/globs.js')))
  const {default: extensions} = await import(pathToFileURL(path.join(avaRoot, 'lib/extensions.js')))
  const config = readJson(path.join(root, 'package.json')).ava
  assert.equal(config.sortTestFiles, undefined)
  assert.equal(config.typescript, undefined)
  const files = await findTests({cwd: root, ...normalizeGlobs({files: config.files, extensions: extensions(config.extensions), providers: []})})
  return files.map(file => path.relative(root, file)).sort((a, b) => a.localeCompare(b, [], {numeric: true}))
}

export async function selectedFiles(files, index) {
  assert.ok(Number.isInteger(index) && index >= 0 && index < shardTotal, 'Invalid shard index')
  const {default: chunkd} = await import('chunkd')
  return chunkd(files, index, shardTotal)
}

export function validateReceipt(receipt, {files, selected, index, commit, lockHash, checkoutRoot}) {
  assert.equal(receipt.version, 1)
  assert.equal(receipt.commit, commit, 'Shard revision differs')
  assert.equal(receipt.lockHash, lockHash, 'Shard dependencies differ')
  assert.equal(receipt.checkoutRoot, checkoutRoot, 'V8 checkout paths differ')
  assert.equal(receipt.index, index)
  assert.equal(receipt.total, shardTotal)
  assert.equal(receipt.completed, true, 'Shard did not finish')
  assert.deepEqual(receipt.files, files, 'Test inventory differs')
  assert.deepEqual([...receipt.finishedFiles].sort(), [...selected].sort(), 'Missing, repeated or unexpected test file')
  assert.deepEqual([...receipt.observedFiles].sort(), [...selected].sort(), 'Unexpected test selection')
  assert.equal(receipt.stats.finishedWorkers, selected.length)
  assert.deepEqual(receipt.stats.parallelRuns, {currentFileCount: selected.length, currentIndex: index, totalRuns: shardTotal})
  assert.equal(receipt.stats.files, files.length)
  assert.ok(receipt.stats.declaredTests > 0)
  for (const key of failures) assert.equal(receipt.stats[key], 0, `Unsuccessful shard: ${key}`)
}

export function writeReceipt(file, receipt) {
  mkdirSync(path.dirname(file), {recursive: true})
  writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'})
}

export function revision() {
  const commit = process.env.GITHUB_SHA ?? spawnSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).stdout.trim()
  assert.match(commit, /^[a-f0-9]{40}$/)
  return {commit, lockHash: hash(path.join(root, 'package-lock.json')), checkoutRoot: root}
}

export function compactV8Report(report, shouldInstrument) {
  const result = report.result.filter(entry => {
    const file = entry.url.startsWith('file:') ? fileURLToPath(entry.url) : entry.url
    return path.isAbsolute(file) && shouldInstrument(file)
  })
  const urls = new Set(result.map(entry => entry.url))
  return {...report, result, 'source-map-cache': Object.fromEntries(Object.entries(report['source-map-cache'] ?? {}).filter(([url]) => urls.has(url)))}
}

export function hasCoveredApplicationCode(report, checkoutRoot) {
  const prefix = pathToFileURL(path.join(checkoutRoot, 'lib') + path.sep).href
  return report.result.some(entry => entry.url.startsWith(prefix)
    && entry.functions.some(fn => fn.ranges.some(range => range.count > 0)))
}

export async function compactCoverage(directory) {
  assert.equal(readJson(path.join(root, 'node_modules/c8/package.json')).version, '12.0.0', 'Revalidate V8 compaction for this c8 version')
  const {buildYargs} = await import('../../node_modules/c8/lib/parse-args.js')
  const {default: Exclude} = await import('test-exclude')
  const options = buildYargs().parse(['report'])
  assert.equal(options.excludeAfterRemap, false, 'Coverage remapping requires a new compaction review')
  const filter = new Exclude({cwd: root, exclude: options.exclude, include: options.include, extension: options.extension, relativePath: !options.allowExternal, excludeNodeModules: options.excludeNodeModules})
  let rawBytes = 0
  let compactBytes = 0
  for (const file of readdirSync(directory).filter(file => file.endsWith('.json'))) {
    const location = path.join(directory, file)
    const raw = readFileSync(location, 'utf8')
    const compact = JSON.stringify(compactV8Report(JSON.parse(raw), file => filter.shouldInstrument(file)))
    rawBytes += Buffer.byteLength(raw)
    compactBytes += Buffer.byteLength(compact)
    writeFileSync(location, compact)
  }
  return {rawBytes, compactBytes}
}

async function run() {
  const index = Number(process.env.CI_NODE_INDEX)
  assert.equal(process.env.CI_NODE_TOTAL, String(shardTotal))
  await selectedFiles([], index)
  const output = path.join(root, 'coverage', `shard-${index}`)
  // Refuse stale receipts/coverage rather than silently incorporating an earlier run.
  mkdirSync(output, {recursive: false})
  const v8 = path.join(output, 'v8')
  mkdirSync(v8)
  const child = spawnSync(process.execPath, ['node_modules/ava/entrypoints/cli.js', '--config=.github/scripts/ava-shard.config.mjs', '--concurrency=1', '--timeout=180s'], {
    cwd: root,
    stdio: 'inherit',
    env: {...process.env, CI: 'true', NODE_V8_COVERAGE: v8, AVA_SHARD_RECEIPT: path.join(output, 'inventory.json')}
  })
  if (child.error) throw child.error
  assert.equal(child.status, 0, 'AVA shard failed')
  const files = await inventory()
  validateReceipt(readJson(path.join(output, 'inventory.json')), {files, selected: await selectedFiles(files, index), index, ...revision()})
  assert.ok(readdirSync(v8).some(file => file.endsWith('.json')), 'Missing V8 coverage')
  // Keep every V8 function/range c8 uses; discard only modules c8 already excludes.
  // Avoid shipping gigabytes of dependency coverage between otherwise isolated runners.
  writeReceipt(path.join(output, 'coverage-size.json'), await compactCoverage(v8))
}

async function merge() {
  const files = await inventory()
  const destination = path.join(root, 'coverage', 'merged-v8')
  mkdirSync(destination, {recursive: false})
  const seen = new Set()
  const summaries = []
  for (let index = 0; index < shardTotal; index++) {
    const input = path.join(root, 'coverage', `shard-${index}`)
    const receipt = readJson(path.join(input, 'inventory.json'))
    const selected = await selectedFiles(files, index)
    validateReceipt(receipt, {files, selected, index, ...revision()})
    for (const file of selected) {
      assert.ok(!seen.has(file), 'Overlapping test shards')
      seen.add(file)
    }
    const coverageFiles = readdirSync(path.join(input, 'v8')).filter(file => file.endsWith('.json'))
    assert.ok(coverageFiles.length > 0, 'Missing shard V8 coverage')
    let coveredApplicationCode = false
    for (const file of coverageFiles) {
      const source = path.join(input, 'v8', file)
      const report = readJson(source)
      assert.ok(Array.isArray(report.result), 'Invalid V8 coverage')
      coveredApplicationCode ||= hasCoveredApplicationCode(report, root)
      copyFileSync(source, path.join(destination, `${index}-${file}`))
    }
    assert.ok(coveredApplicationCode, 'Empty or incorrectly rooted application coverage')
    summaries.push({index, files: selected.length, passed: receipt.stats.passedTests, skipped: receipt.stats.skippedTests, todo: receipt.stats.todoTests})
  }
  assert.equal(seen.size, files.length, 'Incomplete test inventory')
  const child = spawnSync(process.execPath, ['node_modules/c8/bin/c8.js', 'report', '--temp-directory=coverage/merged-v8', '--reporter=html', '--reporter=text', '--reporter=json-summary'], {cwd: root, stdio: 'inherit'})
  if (child.error) throw child.error
  assert.equal(child.status, 0, 'Coverage merge failed')
  const summary = readJson(path.join(root, 'coverage/coverage-summary.json'))
  assert.ok(summary.total.lines.total > 0, 'Empty merged coverage')
  assert.ok(Object.keys(summary).some(file => file.startsWith(path.join(root, 'lib/'))), 'Coverage checkout paths were not resolved')
  writeReceipt(path.join(root, 'coverage/shards-verified.json'), {version: 1, ...revision(), files: files.length, shards: summaries})
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    mkdirSync(path.join(root, 'coverage'), {recursive: true})
    assert.ok(['run', 'merge'].includes(process.argv[2]), 'Expected run or merge')
    await (process.argv[2] === 'run' ? run() : merge())
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
