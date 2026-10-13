import process from 'node:process'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {readFile} from 'node:fs/promises'
import pg from 'pg'
import {digest} from './lib/epidropt.js'
import {prepareLoisirsManifest, validateLoisirsManifest} from './lib/loisirs-source.js'
import {fileSha256} from './lib/aep-cli.js'
import {getDroptOperationClient} from './lib/production-identities.js'
import {assertPrivateOutput, writePrivateJson, connectionOptions, assertTarget} from '../sage-overlap/lib/cli.js'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const uuidPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i

export function parseLoisirsLoginOptions(args) {
  const {positionals, values} = parseArgs({args, allowPositionals: true, options: {
    ...Object.fromEntries(['input', 'owner', 'target', 'target-env', 'tunnel-port', 'report', 'against-report', 'backup-proof'].map(key => [key, {type: 'string'}])),
    apply: {type: 'boolean', default: false}
  }})
  if (positionals.length || !values.input || !uuidPattern.test(values.owner) || !['testing', 'prod'].includes(values.target)
    || !values['target-env'] || !values.report || !/^\d+$/.test(values['tunnel-port'] ?? '')
    || Number(values['tunnel-port']) < 1024 || Number(values['tunnel-port']) > 65535) throw new Error('LOISIRS_LOGIN_ARGUMENTS_INVALID')
  if (values.apply ? !values['against-report'] || !values['backup-proof'] : values['against-report'] || values['backup-proof']) throw new Error('LOISIRS_LOGIN_REVIEW_BACKUP_REQUIRED')
  if ([values['target-env'], values['against-report'], values['backup-proof']].filter(Boolean)
    .some(filename => path.resolve(filename) === path.resolve(values.report))) throw new Error('LOISIRS_LOGIN_OUTPUT_COLLISION')
  return values
}

export function buildLoisirsLoginManifest(manifest, ownerId) {
  validateLoisirsManifest(manifest)
  const owners = manifest.declarants.filter(row => row.id === ownerId)
  const exploitations = manifest.exploitations.filter(row => row.declarantId === ownerId)
  if (owners.length !== 1 || owners[0].emails.length !== 1 || !exploitations.length) throw new Error('LOISIRS_LOGIN_OWNER_INVALID')
  const payload = {formatVersion: manifest.formatVersion, scope: manifest.scope,
    inputs: {...manifest.inputs, loisirsManifestHash: manifest.manifestHash},
    points: manifest.points.filter(row => exploitations.some(exploitation => exploitation.pointId === row.id)),
    declarants: owners, exploitations, meters: [], allocations: [], issues: []}
  return structuredClone({...payload, manifestHash: digest(payload)})
}

async function preservedManifest(input) {
  const manifest = JSON.parse(await readFile(path.join(input, 'mapping/manifest.json'), 'utf8'))
  validateLoisirsManifest(manifest)
  const sources = JSON.parse(await readFile(path.join(input, 'mapping/sources.json'), 'utf8'))
  if (sources.manifestHash !== manifest.manifestHash) throw new Error('LOISIRS_LOGIN_SOURCE_CHANGED')
  for (const source of [sources.source, sources.previousManifest, sources.decisions]) {
    if (typeof source?.name !== 'string' || path.basename(source.name) !== source.name
      || await fileSha256(path.join(input, 'raw', source.name)) !== source.sha256) throw new Error('LOISIRS_LOGIN_SOURCE_CHANGED')
  }
  const rebuilt = await prepareLoisirsManifest({epidroptFile: path.join(input, 'raw', sources.source.name),
    previousManifestFile: path.join(input, 'raw', sources.previousManifest.name),
    decisions: JSON.parse(await readFile(path.join(input, 'raw', sources.decisions.name), 'utf8'))})
  if (rebuilt.manifestHash !== manifest.manifestHash) throw new Error('LOISIRS_LOGIN_REBUILD_MISMATCH')
  return manifest
}

async function loginCodeHash() {
  const files = ['scripts/dropt/enable-loisirs-login.js', 'scripts/dropt/lib/enable-logins.js', 'scripts/dropt/lib/loisirs-source.js',
    'scripts/dropt/lib/epidropt.js', 'scripts/dropt/lib/reconciliation.js', 'scripts/dropt/lib/reviewed-inputs.js',
    'scripts/dropt/lib/apply-epidropt.js', 'scripts/dropt/lib/production-identities.js', 'scripts/dropt/lib/aep-cli.js',
    'scripts/sage-overlap/lib/cli.js', 'scripts/network/prod-database-target.js', 'scripts/network/testing-database-target.js',
    'db/connection-options.js', 'lib/models/user.js', 'lib/util/email.js', 'lib/services/import-aliases.js']
  return digest(await Promise.all(files.map(async filename => [filename, await fileSha256(path.join(repository, filename))])))
}

const successful = result => result.complete && result.counts.selected === 1 && result.counts.blocked === 0
  && result.counts.preserved === 0 && result.counts.enabled + result.counts.unchanged === 1

export async function runLoisirsLogin(args) {
  process.umask(0o077)
  const values = parseLoisirsLoginOptions(args)
  await assertPrivateOutput(values.report)
  const manifest = await preservedManifest(path.resolve(values.input))
  const selected = buildLoisirsLoginManifest(manifest, values.owner)
  const metadata = {operation: 'enable-loisirs-login', target: values.target, ownerId: values.owner,
    sourceManifestHash: manifest.manifestHash, manifestHash: selected.manifestHash, codeHash: await loginCodeHash()}
  const expected = values.apply ? JSON.parse(await readFile(values['against-report'], 'utf8')) : undefined
  if (expected && (Object.entries(metadata).some(([key, value]) => expected[key] !== value)
    || expected.applied !== false || !expected.complete || !successful(expected.result))) throw new Error('LOISIRS_LOGIN_REVIEW_MISMATCH')
  if (values.apply) await verifyLoisirsLoginBackup(values['backup-proof'], metadata, expected)
  if (globalThis.pgPool || globalThis.prisma) throw new Error('LOISIRS_LOGIN_EXISTING_CLIENT_REFUSED')
  const pool = new pg.Pool({...await connectionOptions({values, port: Number(values['tunnel-port'])}), max: 2,
    application_name: 'dropt-loisirs-enable-login'})
  globalThis.pgPool = pool
  process.env.APP_ENV = values.target
  let prisma
  try {
    ;({prisma} = await import('../../db/prisma.js'))
    const {enableManifestLogins} = await import('./lib/enable-logins.js')
    const guarded = await getDroptOperationClient(prisma, selected, {target: values.target, operation: 'enable-logins'})
    const client = new Proxy(guarded, {get(target, property) {
      if (property === '$transaction') return (execute, options) => target.$transaction(async tx => {
        await assertTarget(tx, values.target)
        const result = await execute(tx)
        if (!successful(result)) throw new Error('LOISIRS_LOGIN_NOT_ENABLED')
        if (values.apply) await writePrivateJson(values.report, {...metadata, checkedAt: new Date().toISOString(),
          applied: true, complete: true, transactionStatus: 'PREPARED', result})
        return result
      }, {...options, isolationLevel: 'Serializable'})
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }})
    const result = await enableManifestLogins(client, selected, {scope: 'all', reviewedSharedContactOwnerIds: [values.owner],
      apply: values.apply, expectedReport: expected?.result})
    const report = {...metadata, checkedAt: new Date().toISOString(), applied: values.apply, complete: successful(result),
      transactionStatus: values.apply ? 'COMMITTED' : 'ROLLED_BACK', result}
    await writePrivateJson(values.report, report, {replace: values.apply})
    console.log(JSON.stringify({operation: metadata.operation, applied: report.applied, complete: report.complete,
      counts: result.counts, report: path.resolve(values.report)}))
    if (!report.complete) process.exitCode = 1
    return report
  } finally {
    await prisma?.$disconnect()
    await pool.end()
  }
}

// Native backup schema is deliberately validated here before any DB connection.
export async function verifyLoisirsLoginBackup(filename, metadata, expected) {
  const proof = JSON.parse(await readFile(filename, 'utf8'))
  if (proof.target !== metadata.target || proof.restoreMatched !== true || !Number.isFinite(Date.parse(proof.restoredAt))
    || proof.ownerId !== metadata.ownerId || proof.manifestHash !== metadata.sourceManifestHash
    || proof.loginStateHash !== expected.result.entries[0]?.stateHash
    || !path.isAbsolute(proof.backupFile ?? '') || !/^[a-f\d]{64}$/.test(proof.backupSha256 ?? '')) throw new Error('LOISIRS_LOGIN_BACKUP_INVALID')
  if (await fileSha256(proof.backupFile) !== proof.backupSha256) throw new Error('LOISIRS_LOGIN_BACKUP_HASH_INVALID')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runLoisirsLogin(process.argv.slice(2))
  } catch (error) {
    console.error(JSON.stringify({error: /^[A-Z0-9_]{1,100}$/.test(error.message ?? '') ? error.message : error.code ?? 'LOISIRS_LOGIN_FAILED'}))
    process.exitCode = 1
  }
}
