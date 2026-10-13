import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {validateReceipt, selectedFiles, inventory, compactV8Report, compactCoverage, hasCoveredApplicationCode} from './ci-shards.mjs'
import {checkPrivateRegistry} from './check-private-registry.mjs'

function fixture() {
  const files = ['a.test.js', 'b.test.js', 'c.test.js']
  const expected = {files, selected: files.slice(0, 2), index: 0, commit: 'a'.repeat(40), lockHash: 'b'.repeat(64), checkoutRoot: '/workspace/api'}
  const receipt = {
    version: 1, ...expected, index: 0, total: 2, completed: true,
    finishedFiles: files.slice(0, 2), observedFiles: files.slice(0, 2),
    stats: {finishedWorkers: 2, files: 3, declaredTests: 3, parallelRuns: {currentFileCount: 2, currentIndex: 0, totalRuns: 2}, failedHooks: 0, failedTests: 0, failedWorkers: 0, internalErrors: 0, remainingTests: 0, sharedWorkerErrors: 0, timeouts: 0, timedOutTests: 0, uncaughtExceptions: 0, unexpectedProcessExits: 0, unhandledRejections: 0}
  }
  return {receipt, expected}
}

test('native AVA partitions cover the complete discovered suite exactly once', async () => {
  const files = await inventory()
  const parts = await Promise.all([0, 1].map(index => selectedFiles(files, index)))
  assert.ok(files.length > 200)
  assert.deepEqual(parts.flat(), files)
  assert.equal(new Set(parts.flat()).size, files.length)
  assert.ok(parts.every(part => part.length > 0))
  await assert.rejects(selectedFiles(files, 2))
})

test('inventory validates actual completed workers, independent of worker ordering', () => {
  const {receipt, expected} = fixture()
  receipt.finishedFiles.reverse()
  validateReceipt(receipt, expected)
})

test('V8 compaction preserves every retained function/range and its source map', () => {
  const kept = {url: 'file:///workspace/api/lib/model.js', functions: [{functionName: 'f', ranges: [{startOffset: 0, endOffset: 30, count: 7}, {startOffset: 10, endOffset: 20, count: 0}], isBlockCoverage: true}]}
  const discarded = {url: 'file:///workspace/api/node_modules/example/index.js', functions: []}
  const report = {result: [kept, discarded, {url: 'node:fs', functions: []}], timestamp: 1, 'source-map-cache': {[kept.url]: {data: {sources: ['model.js']}}, [discarded.url]: {data: {sources: ['index.js']}}}}
  const compact = compactV8Report(report, file => file.startsWith('/workspace/api/lib/'))
  assert.deepEqual(compact, {result: [kept], timestamp: 1, 'source-map-cache': {[kept.url]: report['source-map-cache'][kept.url]}})
  assert.equal(report.result.length, 3)
})

test('compaction reads the real c8 configuration and excludes only its ignored modules', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pe-ci-v8-test-'))
  try {
    const kept = {url: pathToFileURL(path.resolve('lib/routes.js')).href, functions: []}
    const discarded = {url: pathToFileURL(path.resolve('scripts/example.js')).href, functions: []}
    const file = path.join(directory, 'coverage.json')
    writeFileSync(file, JSON.stringify({result: [kept, discarded]}))
    const sizes = await compactCoverage(directory)
    assert.ok(sizes.compactBytes < sizes.rawBytes)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).result, [kept])
  } finally {
    rmSync(directory, {recursive: true})
  }
})

test('coverage cannot pass through c8 all=true with only empty or wrongly rooted V8 records', () => {
  const report = {result: [{url: 'file:///workspace/api/lib/model.js', functions: [{ranges: [{count: 1}]}]}]}
  assert.equal(hasCoveredApplicationCode(report, '/workspace/api'), true)
  assert.equal(hasCoveredApplicationCode(report, '/different/api'), false)
  assert.equal(hasCoveredApplicationCode({result: []}, '/workspace/api'), false)
  report.result[0].functions[0].ranges[0].count = 0
  assert.equal(hasCoveredApplicationCode(report, '/workspace/api'), false)
})

for (const [title, mutate] of [
  ['missing file', x => x.finishedFiles.pop()],
  ['duplicate file', x => { x.finishedFiles[1] = x.finishedFiles[0] }],
  ['unexpected file', x => { x.observedFiles[1] = 'other.test.js' }],
  ['partial execution', x => { x.completed = false }],
  ['different commit', x => { x.commit = 'c'.repeat(40) }],
  ['different dependency lock', x => { x.lockHash = 'c'.repeat(64) }],
  ['different V8 checkout root', x => { x.checkoutRoot = '/different/api' }],
  ['native partition disabled', x => { x.stats.parallelRuns = null }],
  ['test failure', x => { x.stats.failedTests = 1 }],
  ['worker failure', x => { x.stats.failedWorkers = 1 }],
  ['timeout', x => { x.stats.timeouts = 1 }],
  ['unexecuted test', x => { x.stats.remainingTests = 1 }]
]) {
  test(`quality gate rejects ${title}`, () => {
    const {receipt, expected} = fixture()
    mutate(receipt)
    assert.throws(() => validateReceipt(receipt, expected))
  })
}

function registryFixture() {
  const namespace = {id: '00000000-0000-0000-0000-000000000001', name: 'prelevements-deau-api', project_id: '8b2f67a8-b474-4596-967f-fe1e0adba1b3', endpoint: 'rg.fr-par.scw.cloud/prelevements-deau-api', region: 'fr-par', status: 'ready', is_public: false}
  const image = {name: namespace.name, namespace_id: namespace.id, status: 'ready', visibility: 'inherit'}
  const environment = {SCW_REGION: 'fr-par', SCW_DEFAULT_PROJECT_ID: namespace.project_id, SCW_REGISTRY_ENDPOINT: namespace.endpoint, SCW_IMAGE_NAME: image.name, SCW_SECRET_KEY: 'synthetic-test-key'}
  const calls = []
  const fetch = async (url, options) => {
    calls.push(url.pathname)
    assert.equal(url.origin, 'https://api.scaleway.com')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers['X-Auth-Token'], environment.SCW_SECRET_KEY)
    assert.equal(options.method, undefined)
    const body = url.pathname.endsWith('/namespaces') ? {total_count: 1, namespaces: [namespace]} : {total_count: 1, images: [image]}
    return {status: 200, json: async () => body}
  }
  return {namespace, image, environment, fetch, calls}
}

test('private cache accepts only the exact private existing API repository using GET', async () => {
  const fixture = registryFixture()
  await checkPrivateRegistry(fixture.environment, fixture.fetch)
  assert.equal(fixture.calls.length, 2)
  fixture.image.visibility = 'private'
  await checkPrivateRegistry(fixture.environment, fixture.fetch)
})

for (const [title, mutate] of [
  ['public namespace', x => { x.namespace.is_public = true }],
  ['public image override', x => { x.image.visibility = 'public' }],
  ['unknown image visibility', x => { delete x.image.visibility }],
  ['wrong project', x => { x.namespace.project_id = 'other-project' }],
  ['wrong registry', x => { x.environment.SCW_REGISTRY_ENDPOINT = 'example.test/public' }],
  ['wrong image name', x => { x.image.name = 'other-image' }],
  ['unavailable namespace', x => { x.namespace.status = 'locked' }]
]) {
  test(`private cache rejects ${title}`, async () => {
    const fixture = registryFixture()
    mutate(fixture)
    await assert.rejects(checkPrivateRegistry(fixture.environment, fixture.fetch))
  })
}

test('all environments gate deployment on quality and image, keep private caches and digest aliases', () => {
  for (const environment of ['testing', 'demo', 'prod']) {
    const workflow = readFileSync(new URL(`../workflows/deploy-${environment}.yml`, import.meta.url), 'utf8')
    assert.match(workflow, /needs: \[quality, image\]/)
    assert.match(workflow, /needs\.quality\.result == 'success' && needs\.image\.result == 'success'/)
    assert.equal(workflow.includes('npm ci'), false)
    assert.equal(workflow.includes('type=gha'), false)
    assert.equal(workflow.includes('DOCKER_BUILD_RECORD_UPLOAD: \'false\''), true)
    assert.equal(workflow.includes(`:buildcache-api-${environment},mode=max`), true)
    assert.equal(workflow.includes('node .github/scripts/check-private-registry.mjs'), true)
    assert.equal(workflow.includes('sh deploy/check-image-size.sh "$IMAGE_REF"'), true)
    assert.equal(workflow.includes('docker buildx imagetools create --tag "$ALIAS_REF" "$IMAGE_REF"'), true)
    assert.ok(workflow.indexOf('node deploy/network/ci-') < workflow.indexOf('docker buildx imagetools create'))
  }
})
