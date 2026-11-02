import {readFile} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {MINIMATCH_EXCEPTION} from './minimatch-exception.js'

const CVE = 'CVE-2026-118764'
const GHSA = 'https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249'
const PACKAGE_PATHS = {
  'app/node_modules/minimatch/package.json': '3.1.5',
  'app/node_modules/readdir-glob/node_modules/minimatch/package.json': '5.1.9'
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const ensure = (condition, message) => { if (!condition) throw new Error(message) }

function exempt(result, vulnerability, now) {
  return Number(now) < Date.parse(MINIMATCH_EXCEPTION.expiresAt)
    && result.Class === 'lang-pkgs' && result.Type === 'node-pkg'
    && vulnerability.VulnerabilityID === CVE && vulnerability.PkgName === 'minimatch'
    && vulnerability.Severity === 'MEDIUM' && vulnerability.FixedVersion === '11.0.1'
    && Object.hasOwn(PACKAGE_PATHS, vulnerability.PkgPath)
    && PACKAGE_PATHS[vulnerability.PkgPath] === vulnerability.InstalledVersion
    && vulnerability.DataSource?.ID === 'ghsa' && Array.isArray(vulnerability.References) && vulnerability.References.includes(GHSA)
    && result.Packages.some(pkg => pkg.Name === 'minimatch' && pkg.Version === vulnerability.InstalledVersion
      && pkg.FilePath === vulnerability.PkgPath)
}

export function evaluateImageAudit({report, imageRef, exitCode, now = Date.now()}) {
  ensure(exitCode === 0 || exitCode === 2, 'Le scanner a échoué ou le système est en fin de support.')
  ensure(typeof imageRef === 'string' && /(?:^|@)sha256:[a-f0-9]{64}$/.test(imageRef), 'Digest d’image requis.')
  ensure(Number.isFinite(Number(now)), 'Horodatage invalide.')
  ensure(object(report) && report.SchemaVersion === 2 && report.ArtifactType === 'container_image'
    && report.ArtifactName === imageRef && typeof report.Trivy?.Version === 'string'
    && Number.isFinite(Date.parse(report.CreatedAt)) && !Object.hasOwn(report, 'Error')
    && object(report.Metadata?.OS) && typeof report.Metadata.OS.Family === 'string'
    && [undefined, false].includes(report.Metadata.OS.EOSL)
    && Array.isArray(report.Results) && report.Results.length > 0, 'Rapport Trivy complet de cette image requis.')
  ensure(report.Results.some(result => result.Class === 'os-pkgs' && result.Type === report.Metadata.OS.Family)
    && report.Results.some(result => result.Class === 'lang-pkgs' && result.Type === 'node-pkg'), 'Inventaires système et Node.js requis.')
  const waived = []
  const blocked = []
  const seen = new Set()
  for (const result of report.Results) {
    ensure(object(result) && typeof result.Target === 'string' && typeof result.Class === 'string'
      && typeof result.Type === 'string' && Array.isArray(result.Packages) && result.Packages.length > 0
      && !Object.hasOwn(result, 'Error') && (result.Vulnerabilities === undefined || Array.isArray(result.Vulnerabilities)),
    'Résultat Trivy mal formé.')
    for (const vulnerability of result.Vulnerabilities ?? []) {
      ensure(object(vulnerability) && typeof vulnerability.VulnerabilityID === 'string'
        && typeof vulnerability.PkgName === 'string' && typeof vulnerability.InstalledVersion === 'string'
        && typeof vulnerability.Severity === 'string', 'Vulnérabilité Trivy mal formée.')
      const key = `${result.Target}:${vulnerability.PkgPath ?? vulnerability.PkgName}:${vulnerability.VulnerabilityID}`
      ensure(!seen.has(key), 'Vulnérabilité Trivy dupliquée.')
      seen.add(key)
      const destination = exempt(result, vulnerability, now) ? waived : blocked
      destination.push(vulnerability)
    }
  }
  ensure(exitCode === (seen.size ? 2 : 0), 'Code de sortie Trivy incohérent avec le rapport.')
  return {ok: blocked.length === 0, waived, blocked, total: seen.size}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    ensure(process.argv.length === 5, 'Arguments du contrôle Trivy invalides.')
    const report = JSON.parse(await readFile(process.argv[2], 'utf8'))
    const result = evaluateImageAudit({report, imageRef: process.argv[3], exitCode: Number(process.argv[4])})
    if (result.waived.length) console.warn(`::warning::Exception TEMPORAIRE ${CVE} / ${MINIMATCH_EXCEPTION.advisoryUrl} : ${result.waived.length} alerte(s) minimatch sur les chemins verrouillés ; expiration ${MINIMATCH_EXCEPTION.expiresAt}. Rapport Trivy brut conservé.`)
    if (!result.ok) throw new Error(`${result.blocked.length} alerte(s) hors exception : ${result.blocked.map(v => `${v.VulnerabilityID} ${v.PkgName}@${v.InstalledVersion}`).join(', ')}`)
    console.log(`Image contrôlée : ${result.total} alerte(s), ${result.waived.length} couverte(s) par la dérogation temporaire, 0 autre alerte.`)
  } catch (error) {
    console.error(`Scan image BLOQUÉ : ${error.message}`)
    process.exitCode = 1
  }
}
