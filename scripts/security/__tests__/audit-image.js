import test from 'ava'
import {execFile} from 'node:child_process'
import {mkdtemp, mkdir, writeFile, readFile, copyFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {evaluateImageAudit} from '../audit-image.js'

const execute = promisify(execFile)
const imageRef = `registry.example.test/api@sha256:${'a'.repeat(64)}`
const now = Date.parse('2026-11-02T12:00:00Z')
const root = fileURLToPath(new URL('../../../', import.meta.url))
function fixture() {
  const Packages = [
    {Name: 'minimatch', Version: '3.1.5', FilePath: 'app/node_modules/minimatch/package.json'},
    {Name: 'minimatch', Version: '5.1.9', FilePath: 'app/node_modules/readdir-glob/node_modules/minimatch/package.json'}
  ]
  const Vulnerabilities = Packages.map(pkg => ({VulnerabilityID: 'CVE-2026-118764', PkgName: pkg.Name,
    PkgPath: pkg.FilePath, InstalledVersion: pkg.Version, FixedVersion: '11.0.1', Severity: 'MEDIUM',
    DataSource: {ID: 'ghsa'}, References: ['https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249']}))
  return {imageRef, exitCode: 2, now, report: {SchemaVersion: 2, ArtifactType: 'container_image', ArtifactName: imageRef,
    CreatedAt: '2026-11-02T12:00:00Z', Trivy: {Version: '0.74.0'}, Metadata: {OS: {Family: 'alpine', Name: '3.24.2'}}, Results: [
      {Target: `${imageRef} (alpine 3.24.2)`, Class: 'os-pkgs', Type: 'alpine', Packages: [{Name: 'musl', Version: '1.2'}]},
      {Target: 'Node.js', Class: 'lang-pkgs', Type: 'node-pkg', Packages, Vulnerabilities}
    ]}}
}

test('image exception accepts exactly the two reviewed paths without changing the raw report', t => {
  const input = fixture()
  const before = structuredClone(input)
  const result = evaluateImageAudit(input)
  t.true(result.ok)
  t.is(result.total, 2)
  t.is(result.waived.length, 2)
  t.deepEqual(input, before)
})

test('image exception expires at Paris midnight and a clean image still passes afterwards', t => {
  t.true(evaluateImageAudit({...fixture(), now: Date.parse('2026-11-08T22:59:59.999Z')}).ok)
  const input = {...fixture(), now: Date.parse('2026-11-08T23:00:00Z')}
  const result = evaluateImageAudit(input)
  t.false(result.ok)
  t.is(result.blocked.length, 2)
  input.report.Results[1].Vulnerabilities = []
  input.exitCode = 0
  t.true(evaluateImageAudit(input).ok)
})

test('different CVE, package, version, path, severity, source or GHSA remains blocked', t => {
  const variants = [
    vulnerability => { vulnerability.VulnerabilityID = 'CVE-2026-OTHER' },
    vulnerability => { vulnerability.PkgName = 'other' },
    vulnerability => { vulnerability.PkgPath = 'app/node_modules/other/node_modules/minimatch/package.json' },
    vulnerability => { vulnerability.InstalledVersion = '3.1.4' },
    vulnerability => { vulnerability.Severity = 'HIGH' },
    vulnerability => { vulnerability.FixedVersion = '12.0.0' },
    vulnerability => { vulnerability.DataSource.ID = 'nvd' },
    vulnerability => { vulnerability.References = [] },
    vulnerability => { vulnerability.References = 'https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249' }
  ]
  for (const mutate of variants) {
    const input = fixture()
    mutate(input.report.Results[1].Vulnerabilities[0])
    t.false(evaluateImageAudit(input).ok)
  }
  const input = fixture()
  input.report.Results[0].Vulnerabilities = [{VulnerabilityID: 'CVE-OS', PkgName: 'musl', InstalledVersion: '1.2', Severity: 'LOW'}]
  t.false(evaluateImageAudit(input).ok)
  input.report.Results[1].Packages[0].Version = 'different'
  t.is(evaluateImageAudit(input).blocked.length, 2)
})

test('scanner errors, EOL even with vulnerabilities, malformed reports and wrong images fail closed', t => {
  const variants = [
    input => { input.exitCode = 1 }, input => { input.exitCode = 127 }, input => { input.exitCode = 0 },
    input => { input.report.Metadata.OS.EOSL = true }, input => { input.report.Metadata.OS.EOSL = 'unknown' },
    input => { input.report.ArtifactName = 'other-image' }, input => { input.imageRef = 'api:latest' },
    input => { input.report.SchemaVersion = 1 }, input => { delete input.report.CreatedAt },
    input => { delete input.report.Metadata.OS }, input => { delete input.report.Results },
    input => { input.report.Results = [] }, input => { input.report.Results.pop() },
    input => { input.report.Results[1].Packages = [] }, input => { input.report.Results[1].Vulnerabilities = {} },
    input => { input.report.Results[1].Vulnerabilities.push(input.report.Results[1].Vulnerabilities[0]) },
    input => { input.report.Results[1].Vulnerabilities = [] },
    input => { input.report.Results[1].Vulnerabilities[0].Severity = null },
    input => { input.now = Number.NaN }
  ]
  for (const mutate of variants) {
    const input = fixture()
    mutate(input)
    t.throws(() => evaluateImageAudit(input))
  }
})

async function scanFixture(t, status) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pe-image-scan-test-'))
  t.teardown(() => rm(cwd, {recursive: true, force: true}))
  await mkdir(path.join(cwd, 'bin'))
  await mkdir(path.join(cwd, 'scripts/security'), {recursive: true})
  await copyFile(path.join(root, 'scripts/security/audit-image.js'), path.join(cwd, 'scripts/security/audit-image.js'))
  await copyFile(path.join(root, 'scripts/security/minimatch-exception.js'), path.join(cwd, 'scripts/security/minimatch-exception.js'))
  const fakeScanner = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.writeFileSync('arguments.json', JSON.stringify(args))
if (${status} === 0 || ${status} === 2) {
  const report = ${JSON.stringify(fixture().report)}
  if (${status} === 0) report.Results[1].Vulnerabilities = []
  fs.writeFileSync(args[args.indexOf('--output') + 1], JSON.stringify(report))
}
process.exit(${status})
`
  await writeFile(path.join(cwd, 'bin/trivy'), fakeScanner, {mode: 0o700})
  return {cwd, env: {...process.env, PATH: `${cwd}/bin:${process.env.PATH}`}}
}

test('shell scanner keeps EOL blocking, scans the digest and preserves its raw report', async t => {
  const options = await scanFixture(t, 0)
  await execute('bash', [path.join(root, '.github/scripts/scan-image.sh'), imageRef], options)
  const args = JSON.parse(await readFile(path.join(options.cwd, 'arguments.json'), 'utf8'))
  t.deepEqual(args, ['image', '--scanners', 'vuln', '--format', 'json', '--timeout', '15m', '--exit-code', '2',
    '--exit-on-eol', '1', '--output', '.artifacts/security/image-audit.json', imageRef])
  const raw = await readFile(path.join(options.cwd, '.artifacts/security/image-audit.json'), 'utf8')
  const expected = fixture().report
  expected.Results[1].Vulnerabilities = []
  t.is(raw, JSON.stringify(expected))
})

test('failed scanner cannot reuse a stale report or accept a mutable image tag', async t => {
  const options = await scanFixture(t, 1)
  const directory = path.join(options.cwd, '.artifacts/security')
  await mkdir(directory, {recursive: true})
  await writeFile(path.join(directory, 'image-audit.json'), JSON.stringify(fixture().report))
  await t.throwsAsync(execute('bash', [path.join(root, '.github/scripts/scan-image.sh'), imageRef], options))
  await t.throwsAsync(readFile(path.join(directory, 'image-audit.json')))
  await t.throwsAsync(execute('bash', [path.join(root, '.github/scripts/scan-image.sh'), 'api:latest'], options))
})
