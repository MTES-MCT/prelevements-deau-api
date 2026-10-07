import test from 'ava'
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {AUDIT_EXCEPTIONS, evaluateAudit, runDependencyAudit} from '../audit-dependencies.js'

const AUDIT_EXCEPTION = AUDIT_EXCEPTIONS.find(policy => policy.packageName === 'braces')
const beforeExpiry = Date.parse(AUDIT_EXCEPTION.expiresAt) - 1
const advisory = () => ({source: 1240992, name: 'braces', dependency: 'braces', title: 'Synthetic advisory',
  url: AUDIT_EXCEPTION.advisoryUrl, severity: 'high', range: '<=3.0.3'})
const vulnerability = (name, via) => ({name, severity: 'high', isDirect: false, range: '*', via,
  nodes: [`node_modules/${name}`], effects: []})
function fixture() {
  const vulnerabilities = {braces: vulnerability('braces', [advisory()]),
    micromatch: vulnerability('micromatch', ['braces']), parent: vulnerability('parent', ['micromatch'])}
  const report = {auditReportVersion: 2, vulnerabilities, metadata: {
    vulnerabilities: {info: 0, low: 0, moderate: 0, high: 3, critical: 0, total: 3},
    dependencies: {prod: 0, dev: 3, optional: 0, peer: 0, peerOptional: 0, total: 3}}}
  const lockfile = {lockfileVersion: 3, packages: Object.fromEntries(Object.keys(vulnerabilities)
    .map(name => [`node_modules/${name}`, {version: name === 'braces' ? '3.0.3' : '1.0.0', dev: true}]))}
  return {report, lockfile, exitCode: 1, now: beforeExpiry}
}

function sprintfFixture() {
  const policy = AUDIT_EXCEPTIONS.find(policy => policy.packageName === 'sprintf-js')
  const vulnerabilities = {
    'sprintf-js': vulnerability('sprintf-js', [{...advisory(), name: 'sprintf-js', dependency: 'sprintf-js',
      url: policy.advisoryUrl, severity: 'moderate', range: '<=1.1.3'}]),
    argparse: vulnerability('argparse', ['sprintf-js']),
    'js-yaml': vulnerability('js-yaml', ['argparse']),
    supertap: vulnerability('supertap', ['js-yaml']),
    ava: vulnerability('ava', ['supertap'])
  }
  const input = fixture()
  input.report.vulnerabilities = vulnerabilities
  input.report.metadata.vulnerabilities = {info: 0, low: 0, moderate: 5, high: 0, critical: 0, total: 5}
  input.report.metadata.dependencies.dev = 5
  input.report.metadata.dependencies.total = 5
  input.lockfile.packages = Object.fromEntries(Object.values(vulnerabilities).map(row => {
    row.severity = 'moderate'
    return [`node_modules/${row.name}`, {version: row.name === 'sprintf-js' ? '1.0.3' : '1.0.0', dev: true}]
  }))
  return input
}

test('sprintf-js exception covers only the locked development advisory and its complete parent chain', t => {
  const input = sprintfFixture()
  const result = evaluateAudit(input)
  t.true(result.ok)
  t.deepEqual(result.waived, ['sprintf-js', 'argparse', 'js-yaml', 'supertap', 'ava'])
  t.deepEqual(result.exceptions.filter(policy => policy.applied).map(policy => policy.packageName), ['sprintf-js'])
  t.is(result.exceptions.find(policy => policy.packageName === 'sprintf-js').expiresAt, '2026-10-14T22:00:00Z')
})

test('sprintf-js expires at the end of October 14 in Paris without inheriting the earlier braces deadline', t => {
  for (const now of ['2026-10-10T22:00:00Z', '2026-10-14T21:59:59.999Z']) {
    t.true(evaluateAudit({...sprintfFixture(), now: Date.parse(now)}).ok)
  }
  const result = evaluateAudit({...sprintfFixture(), now: Date.parse('2026-10-14T22:00:00Z')})
  t.false(result.ok)
  t.true(result.expired)
  t.deepEqual(result.waived, [])
})

test('sprintf-js runtime paths, different versions and unknown advisory causes remain blocked', t => {
  for (const key of ['sprintf-js', 'argparse', 'js-yaml', 'supertap', 'ava']) {
    const input = sprintfFixture()
    input.lockfile.packages[`node_modules/${key}`].dev = false
    t.true(evaluateAudit(input).blocked.includes(key))
  }
  for (const change of ['missing', 'version', 'additional-runtime', 'unknown-advisory', 'mixed-parent', 'unknown-parent']) {
    const input = sprintfFixture()
    if (change === 'missing') delete input.lockfile.packages['node_modules/sprintf-js']
    if (change === 'version') input.lockfile.packages['node_modules/sprintf-js'].version = '1.1.3'
    if (change === 'additional-runtime') {
      input.report.vulnerabilities['sprintf-js'].nodes.push('node_modules/other/node_modules/sprintf-js')
      input.lockfile.packages['node_modules/other/node_modules/sprintf-js'] = {version: '1.0.3', dev: false}
    }
    if (change === 'unknown-advisory') input.report.vulnerabilities['sprintf-js'].via[0].url = 'https://github.com/advisories/GHSA-other'
    if (change === 'mixed-parent') input.report.vulnerabilities.ava.via.push({...advisory(), name: 'ava', dependency: 'ava'})
    if (change === 'unknown-parent') input.report.vulnerabilities.ava.via.push('unreported-dependency')
    t.false(evaluateAudit(input).ok)
  }
})

test('parents with both advisory branches require both exceptions to remain valid', t => {
  const input = fixture()
  const sprintf = sprintfFixture()
  Object.assign(input.report.vulnerabilities, sprintf.report.vulnerabilities)
  Object.assign(input.lockfile.packages, sprintf.lockfile.packages)
  input.report.vulnerabilities.parent.via.push('ava')
  input.report.metadata.vulnerabilities.moderate = 5
  input.report.metadata.vulnerabilities.total = 8
  input.report.metadata.dependencies.dev = 8
  input.report.metadata.dependencies.total = 8
  t.true(evaluateAudit(input).ok)
  const result = evaluateAudit({...input, now: Date.parse('2026-10-10T22:00:00Z')})
  t.false(result.ok)
  t.deepEqual(result.blocked, ['braces', 'micromatch', 'parent'])
  t.deepEqual(result.waived, ['sprintf-js', 'argparse', 'js-yaml', 'supertap', 'ava'])
  input.report.vulnerabilities.ava.via.push({...advisory(), name: 'ava', dependency: 'ava'})
  t.true(evaluateAudit(input).blocked.includes('parent'))
})

test('policy entries cannot extend deadlines, widen versions, cover runtime or accept another advisory', t => {
  const variants = [
    policy => { policy.expiresAt = '2026-10-15T22:00:00Z' },
    policy => { policy.version = '1.1.3' },
    policy => { policy.developmentOnly = false },
    policy => { policy.advisoryUrl = 'https://github.com/advisories/GHSA-other' },
    policy => { policy.packageName = 'other' }
  ]
  for (const alter of variants) {
    const policies = structuredClone(AUDIT_EXCEPTIONS)
    alter(policies[1])
    t.throws(() => evaluateAudit({...sprintfFixture(), policies}), {message: 'Politique d’exception invalide.'})
  }
  t.throws(() => evaluateAudit({...sprintfFixture(), policies: [...AUDIT_EXCEPTIONS, AUDIT_EXCEPTIONS[1]]}))
})

test('only the exact development advisory and exclusively affected parents are temporarily waived', t => {
  const input = fixture()
  const before = structuredClone(input)
  const result = evaluateAudit(input)
  t.true(result.ok)
  t.deepEqual(result.waived, ['braces', 'micromatch', 'parent'])
  t.is(result.totalVulnerablePackages, 3)
  t.deepEqual(input, before)
})

test('expiration is exclusive: allowed one millisecond before, blocked at the exact Paris midnight boundary', t => {
  t.true(evaluateAudit({...fixture(), now: Date.parse('2026-10-10T21:59:59.999Z')}).ok)
  for (const now of [Date.parse('2026-10-10T22:00:00Z'), Date.parse('2026-10-11T00:00:00Z')]) {
    const result = evaluateAudit({...fixture(), now})
    t.false(result.ok)
    t.true(result.expired)
    t.deepEqual(result.waived, [])
  }
})

test('another advisory, a mixed dependency chain or unknown graph node is never waived', t => {
  for (const change of ['advisory', 'mixed', 'unknown', 'prototype']) {
    const input = fixture()
    if (change === 'advisory') input.report.vulnerabilities.braces.via[0].url = 'https://github.com/advisories/GHSA-other'
    if (change === 'mixed') input.report.vulnerabilities.micromatch.via.push({...advisory(), url: 'https://github.com/advisories/GHSA-new'})
    if (change === 'unknown') input.report.vulnerabilities.parent.via.push('missing-package')
    if (change === 'prototype') input.report.vulnerabilities.parent.via.push('toString')
    t.false(evaluateAudit(input).ok)
  }
})

test('runtime nodes, missing nodes and different installed braces versions block the exception', t => {
  for (const key of ['braces', 'micromatch', 'parent']) {
    const input = fixture()
    input.lockfile.packages[`node_modules/${key}`].dev = false
    const result = evaluateAudit(input)
    t.false(result.ok)
    t.true(result.blocked.includes(key))
  }
  for (const change of ['missing', 'version', 'additional-runtime']) {
    const input = fixture()
    if (change === 'missing') delete input.lockfile.packages['node_modules/braces']
    if (change === 'version') input.lockfile.packages['node_modules/braces'].version = '3.0.2'
    if (change === 'additional-runtime') {
      input.report.vulnerabilities.braces.nodes.push('node_modules/other/node_modules/braces')
      input.lockfile.packages['node_modules/other/node_modules/braces'] = {version: '3.0.3', dev: false}
    }
    t.false(evaluateAudit(input).ok)
  }
})

test('cycles do not turn an unproven dependency graph into an exception', t => {
  const input = fixture()
  input.report.vulnerabilities.braces.via.push('parent')
  t.false(evaluateAudit(input).ok)
})

test('malformed reports, npm errors, unexpected exit codes and inconsistent counters fail closed', t => {
  const variants = [
    input => { input.exitCode = 0 },
    input => { input.exitCode = 2 },
    input => { input.exitCode = 'ENOENT' },
    input => { input.report.error = {code: 'EAI_AGAIN'} },
    input => { input.report.auditReportVersion = 1 },
    input => { delete input.report.metadata },
    input => { delete input.report.metadata.dependencies.dev },
    input => { input.report.metadata.vulnerabilities.total = 0 },
    input => { input.report.metadata.vulnerabilities.high = 2; input.report.metadata.vulnerabilities.low = 1 },
    input => { input.report.vulnerabilities.parent.via = [] },
    input => { input.report.vulnerabilities.parent.nodes = [] },
    input => { input.report.vulnerabilities.parent.name = 'unknown' },
    input => { input.lockfile = {} }
  ]
  for (const alter of variants) {
    const input = fixture()
    alter(input)
    t.throws(() => evaluateAudit(input))
  }
})

test('a truly empty audit passes without using the exception, including after its expiry', t => {
  const input = fixture()
  input.exitCode = 0
  input.report.vulnerabilities = {}
  input.report.metadata.vulnerabilities.high = 0
  input.report.metadata.vulnerabilities.total = 0
  const result = evaluateAudit({...input, now: Date.parse(AUDIT_EXCEPTION.expiresAt)})
  t.true(result.ok)
  t.deepEqual(result.waived, [])
  t.throws(() => evaluateAudit({...input, exitCode: 1}))
})

test('runner executes the unfiltered audit and archives its exact raw report before evaluating it', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pe-audit-test-'))
  t.teardown(() => rm(cwd, {recursive: true, force: true}))
  const input = fixture()
  const raw = JSON.stringify(input.report, null, 2) + '\n'
  await writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify(input.lockfile))
  const execute = (command, args, options, callback) => {
    t.is(command, 'npm')
    t.deepEqual(args, ['audit', '--include=dev', '--audit-level=low', '--json'])
    t.is(options.cwd, cwd)
    callback({code: 1}, raw)
  }
  const result = await runDependencyAudit({cwd, execute, now: beforeExpiry})
  t.true(result.ok)
  t.is(await readFile(path.join(cwd, '.artifacts/security/npm-audit-all.json'), 'utf8'), raw)
})

test('runner archives malformed/network output and rejects instead of treating it as a clean audit', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pe-audit-invalid-test-'))
  t.teardown(() => rm(cwd, {recursive: true, force: true}))
  const raw = 'network failure, not JSON\n'
  await t.throwsAsync(runDependencyAudit({cwd, execute: (command, args, options, callback) => callback({code: 1}, raw)}))
  t.is(await readFile(path.join(cwd, '.artifacts/security/npm-audit-all.json'), 'utf8'), raw)
})

test.serial('expiration is evaluated after npm returns, including an audit crossing the deadline', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pe-audit-expiry-test-'))
  t.teardown(() => rm(cwd, {recursive: true, force: true}))
  const input = fixture()
  await writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify(input.lockfile))
  const originalNow = Date.now
  let returned = false
  try {
    Date.now = () => returned ? Date.parse(AUDIT_EXCEPTION.expiresAt) : beforeExpiry
    const result = await runDependencyAudit({cwd, execute: (command, args, options, callback) => {
      t.is(options.timeout, 120_000)
      returned = true
      callback({code: 1}, JSON.stringify(input.report))
    }})
    t.false(result.ok)
    t.true(result.expired)
  } finally { Date.now = originalNow }
})
