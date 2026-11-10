import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

// This image has no npm dependencies. Do not add a dummy package or relax the
// application's npm inventory gate: validate the standalone scanner separately.
export function evaluateScannerImage({report, image, exitCode, now = Date.now()}) {
  assert.equal(exitCode, 0, 'Trivy must succeed without any vulnerability or unsupported OS')
  assert.match(image, /(?:^|@)sha256:[a-f0-9]{64}$/)
  assert.equal(report?.SchemaVersion, 2)
  assert.equal(report.ArtifactType, 'container_image')
  assert.equal(report.ArtifactName, image, 'Audit must describe the exact candidate digest')
  assert.equal(typeof report.Trivy?.Version, 'string')
  assert(report.Trivy.Version.length > 0)
  const createdAt = Date.parse(report.CreatedAt)
  assert(Number.isFinite(createdAt) && createdAt <= now + 300_000 && now - createdAt <= 24 * 60 * 60 * 1000,
    'A fresh audit is required')
  assert(!Object.hasOwn(report, 'Error'))
  assert.equal(report.Metadata?.OS?.Family, 'alpine')
  assert.equal(typeof report.Metadata.OS.Name, 'string')
  assert([undefined, false].includes(report.Metadata.OS.EOSL))
  assert(Array.isArray(report.Results) && report.Results.length > 0)
  assert(report.Results.some(result => result.Class === 'os-pkgs' && result.Type === 'alpine'))
  let packages = 0
  for (const result of report.Results) {
    assert(result && typeof result.Target === 'string' && typeof result.Class === 'string' && typeof result.Type === 'string')
    assert(!Object.hasOwn(result, 'Error'))
    assert(Array.isArray(result.Packages) && result.Packages.length > 0, 'Package inventory is required')
    assert(result.Vulnerabilities === undefined || (Array.isArray(result.Vulnerabilities) && result.Vulnerabilities.length === 0),
      'All vulnerability severities block this scanner image')
    for (const dependency of result.Packages) {
      assert(dependency && typeof dependency.Name === 'string' && typeof dependency.Version === 'string')
    }
    packages += result.Packages.length
  }
  return {ok: true, packages, vulnerabilities: 0}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 5)
    const report = JSON.parse(await readFile(process.argv[2], 'utf8'))
    console.log(JSON.stringify(evaluateScannerImage({report, image: process.argv[3], exitCode: Number(process.argv[4])})))
  } catch (error) {
    console.error(`Scanner image audit failed: ${error.message}`)
    process.exitCode = 1
  }
}
