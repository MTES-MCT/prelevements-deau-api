import test from 'ava'
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {AUDIT_EXCEPTION, evaluateAudit, runDependencyAudit} from '../audit-dependencies.js'

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
