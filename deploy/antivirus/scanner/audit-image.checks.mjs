import test from 'node:test'
import assert from 'node:assert/strict'
import {evaluateScannerImage} from './audit-image.mjs'

const image = `sha256:${'a'.repeat(64)}`
function fixture() {
  return {SchemaVersion: 2, ArtifactType: 'container_image', ArtifactName: image, CreatedAt: new Date().toISOString(),
    Trivy: {Version: '0.74.0'}, Metadata: {OS: {Family: 'alpine', Name: '3.24.4', EOSL: false}},
    Results: [{Target: image, Class: 'os-pkgs', Type: 'alpine', Packages: [{Name: 'zlib', Version: '1.4-r0'}]}]}
}

test('standalone scanner image passes with a real OS inventory and zero npm dependencies', () => {
  assert.deepEqual(evaluateScannerImage({report: fixture(), image, exitCode: 0}), {ok: true, packages: 1, vulnerabilities: 0})
})

test('all vulnerabilities block, including low severity and findings without a fix', () => {
  const report = fixture()
  report.Results[0].Vulnerabilities = [{VulnerabilityID: 'TEST-001', Severity: 'LOW', FixedVersion: ''}]
  assert.throws(() => evaluateScannerImage({report, image, exitCode: 0}))
  assert.throws(() => evaluateScannerImage({report, image, exitCode: 2}))
})

test('wrong image, incomplete inventory, scanner failure and stale reports fail closed', () => {
  const changes = [
    report => {report.ArtifactName = 'some-tag'},
    report => {report.Results = []},
    report => {report.Results[0].Packages = []},
    report => {report.Results[0].Error = 'scanner failed'},
    report => {report.Metadata.OS.EOSL = true},
    report => {report.CreatedAt = '2020-01-01T00:00:00Z'},
    report => {report.Trivy = {}}
  ]
  for (const change of changes) {
    const report = fixture()
    change(report)
    assert.throws(() => evaluateScannerImage({report, image, exitCode: 0}))
  }
  for (const exitCode of [1, 2, 3, NaN]) assert.throws(() => evaluateScannerImage({report: fixture(), image, exitCode}))
})
