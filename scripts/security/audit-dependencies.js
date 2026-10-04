import {execFile} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

export const AUDIT_EXCEPTION = Object.freeze(JSON.parse(readFileSync(new URL('./npm-audit-exceptions.json', import.meta.url), 'utf8')))
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical']
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = value => Number.isSafeInteger(value) && value >= 0
const ensure = (condition, message) => { if (!condition) throw new Error(message) }

function validateVulnerability(name, vulnerability) {
  ensure(object(vulnerability) && vulnerability.name === name && SEVERITIES.includes(vulnerability.severity)
    && typeof vulnerability.isDirect === 'boolean' && typeof vulnerability.range === 'string'
    && Array.isArray(vulnerability.via) && vulnerability.via.length > 0
    && Array.isArray(vulnerability.nodes) && vulnerability.nodes.length > 0
    && Array.isArray(vulnerability.effects) && vulnerability.effects.every(effect => typeof effect === 'string'),
  `Vulnérabilité mal formée : ${name}.`)
}

function validateAudit(report, exitCode, lockfile) {
  ensure(exitCode === 0 || exitCode === 1, 'npm audit a échoué (code de sortie inattendu).')
  ensure(object(report) && !Object.hasOwn(report, 'error') && report.auditReportVersion === 2
    && object(report.vulnerabilities) && object(report.metadata?.vulnerabilities)
    && object(report.metadata?.dependencies), 'Rapport npm audit v2 complet requis (pas d’erreur réseau ou npm).')
  ensure([2, 3].includes(lockfile?.lockfileVersion) && object(lockfile.packages), 'Lockfile npm avec inventaire des paquets requis.')
  const vulnerabilities = Object.entries(report.vulnerabilities)
  const totals = report.metadata.vulnerabilities
  ensure([...SEVERITIES, 'total'].every(key => integer(totals[key])) && totals.total === vulnerabilities.length
    && SEVERITIES.reduce((sum, key) => sum + totals[key], 0) === totals.total,
  'Totaux des vulnérabilités incohérents.')
  ensure(['prod', 'dev', 'optional', 'peer', 'peerOptional', 'total'].every(key => integer(report.metadata.dependencies[key])),
    'Inventaire des dépendances absent ou invalide.')
  ensure(exitCode === (vulnerabilities.length ? 1 : 0), 'Code de sortie npm incohérent avec les vulnérabilités déclarées.')
  for (const [name, vulnerability] of vulnerabilities) validateVulnerability(name, vulnerability)
  ensure(SEVERITIES.every(severity => vulnerabilities.filter(([, item]) => item.severity === severity).length === totals[severity]),
    'Répartition des sévérités incohérente.')
  return vulnerabilities
}

function developmentNodes(vulnerability, lockfile, policy) {
  return vulnerability.nodes.every(node => typeof node === 'string' && !node.split('/').includes('..')
    && (node === `node_modules/${vulnerability.name}` || node.endsWith(`/node_modules/${vulnerability.name}`))
    && object(lockfile.packages[node]) && lockfile.packages[node].dev === true
    && typeof lockfile.packages[node].version === 'string'
    && (vulnerability.name !== policy.packageName || lockfile.packages[node].version === policy.version))
}

function exemptAdvisory(advisory, vulnerability, policy) {
  return object(advisory) && Number.isSafeInteger(advisory.source) && advisory.source > 0
    && advisory.url === policy.advisoryUrl && advisory.name === policy.packageName
    && advisory.dependency === policy.packageName && vulnerability.name === policy.packageName
    && SEVERITIES.includes(advisory.severity) && typeof advisory.title === 'string' && typeof advisory.range === 'string'
}

/** Refuse unknown evidence. A parent is exempt only when every dependency path
 * ends in the single allowed advisory and every affected lockfile node is dev.
 */
export function evaluateAudit({report, exitCode, lockfile, now = Date.now(), policy = AUDIT_EXCEPTION}) {
  const vulnerabilities = validateAudit(report, exitCode, lockfile)
  ensure(object(policy) && policy.packageName === 'braces' && policy.version === '3.0.3' && policy.developmentOnly === true
    && policy.advisoryUrl === 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm'
    && Number.isFinite(Date.parse(policy.expiresAt)) && Number.isFinite(Number(now)), 'Politique d’exception invalide.')
  const expired = Number(now) >= Date.parse(policy.expiresAt)
  const memo = new Map()
  function exempt(name, visiting = new Set()) {
    if (memo.has(name)) return memo.get(name)
    const vulnerability = Object.hasOwn(report.vulnerabilities, name) ? report.vulnerabilities[name] : null
    if (!vulnerability || visiting.has(name) || expired || !developmentNodes(vulnerability, lockfile, policy)) return false
    const next = new Set([...visiting, name])
    const allowed = vulnerability.via.every(via => typeof via === 'string'
      ? exempt(via, next) : exemptAdvisory(via, vulnerability, policy))
    memo.set(name, allowed)
    return allowed
  }
  const waived = []
  const blocked = []
  for (const [name] of vulnerabilities) (exempt(name) ? waived : blocked).push(name)
  return {ok: blocked.length === 0, waived, blocked, expired, expiresAt: policy.expiresAt,
    totalVulnerablePackages: vulnerabilities.length, advisoryUrl: policy.advisoryUrl}
}

export async function runDependencyAudit({cwd = process.cwd(), now, execute = execFile} = {}) {
  const result = await new Promise(resolve => execute('npm', ['audit', '--include=dev', '--audit-level=low', '--json'],
    {cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 20 * 1024 * 1024}, (error, stdout) => resolve({stdout: stdout ?? '', exitCode: error ? error.code : 0})))
  const destination = path.join(cwd, '.artifacts/security/npm-audit-all.json')
  await mkdir(path.dirname(destination), {recursive: true})
  // Retain the unmodified report even if JSON is invalid, npm failed or the gate
  // refuses an exception. This artifact must never suggest a zero-vulnerability audit.
  await writeFile(destination, result.stdout)
  const report = JSON.parse(result.stdout)
  const lockfile = JSON.parse(await readFile(path.join(cwd, 'package-lock.json'), 'utf8'))
  return evaluateAudit({report, lockfile, exitCode: result.exitCode, now})
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runDependencyAudit()
    if (result.waived.length) console.warn(`::warning::Exception de sécurité TEMPORAIRE : ${result.advisoryUrl}, braces@3.0.3 uniquement en développement ; ${result.waived.length} paquets affectés, expiration ${result.expiresAt}. Rapport brut conservé dans .artifacts/security/npm-audit-all.json.`)
    if (!result.ok) {
      console.error(`Audit BLOQUÉ${result.expired ? ' (exception expirée)' : ''} : ${result.blocked.join(', ')}.`)
      process.exitCode = 1
    } else console.log(`Audit contrôlé : ${result.totalVulnerablePackages} paquet(s) vulnérable(s), ${result.waived.length} paquet(s) couverts par ${result.waived.length ? 'une exception temporaire' : 'aucune exception'}, 0 autre vulnérabilité.`)
  } catch (error) {
    console.error(`Audit BLOQUÉ : ${error.message}`)
    process.exitCode = 1
  }
}
