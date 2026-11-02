import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {check, digest} from './reconcile.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
export const reconcileFiles = ['scripts/willie/reconcile.js', 'scripts/willie/lib/reconcile.js',
  'scripts/willie/lib/reconcile-apply.js', 'scripts/willie/lib/reconcile-cli.js', 'scripts/willie/lib/history.js',
  'scripts/sage-overlap/lib/cli.js', 'scripts/network/prod-database-target.js', 'scripts/network/testing-database-target.js', 'db/connection-options.js']

export async function reconcileCodeHash() {
  const hash = createHash('sha256')
  for (const file of reconcileFiles) hash.update(file).update(await readFile(path.join(root, file)))
  return hash.digest('hex')
}

export function parseReconcileOptions(args) {
  const {values, positionals} = parseArgs({args, allowPositionals: true, options: {
    ...Object.fromEntries(['manifest', 'payload', 'target', 'target-env', 'tunnel-port', 'report',
      'against-report', 'against-receipt', 'backup-proof', 'quiescence-proof'].map(key => [key, {type: 'string'}])),
    apply: {type: 'boolean', default: false}
  }})
  const command = positionals[0] ?? 'review'
  check(positionals.length <= 1 && ['review', 'apply', 'verify', 'rollback'].includes(command), 'COMMAND_INVALID')
  check(['prod', 'testing'].includes(values.target) && values.manifest && values.payload
    && values['target-env'] && values.report, 'ARGUMENTS_REQUIRED')
  check(/^\d+$/.test(values['tunnel-port'] ?? '') && Number(values['tunnel-port']) >= 1024
    && Number(values['tunnel-port']) <= 65535, 'TUNNEL_REQUIRED')
  check(!values.apply || ['apply', 'rollback'].includes(command), 'APPLY_INVALID')
  check(command !== 'rollback' || (values.apply && values['against-receipt']), 'ROLLBACK_RECEIPT_REQUIRED')
  check(!values.apply || values['quiescence-proof'], 'QUIESCENCE_REQUIRED')
  check(command !== 'apply' || !values.apply || (values['against-report'] && values['backup-proof']), 'REVIEW_BACKUP_REQUIRED')
  check((!values['against-receipt'] || command === 'rollback') && (!values['against-report'] || command === 'apply')
    && (!values['backup-proof'] || (command === 'apply' && values.apply))
    && (!values['quiescence-proof'] || values.apply), 'OPTIONS_INCOMPATIBLE')
  const inputs = ['manifest', 'payload', 'target-env', 'against-report', 'against-receipt', 'backup-proof', 'quiescence-proof']
    .map(key => values[key]).filter(Boolean).map(file => path.resolve(file))
  const outputs = [values.report, `${values.report}.before.json`, `${values.report}.prepared.json`].map(file => path.resolve(file))
  check(!outputs.some(file => inputs.includes(file)), 'OUTPUT_OVERWRITES_INPUT')
  return {command, values, port: Number(values['tunnel-port'])}
}

export function assertReconcileReport(report, {target, codeHash, manifestHash, payloadHash}, receipt = false) {
  check(report?.operation === 'willie-reconcile' && report.target === target && report.codeHash === codeHash
    && report.manifestHash === manifestHash && report.payloadHash === payloadHash && report.complete === true
    && !report.blocked?.length && report.applied === receipt && (!receipt || report.status === 'COMMITTED')
    && /^[a-f\d]{64}$/.test(report.stateHash ?? '') && /^[a-f\d]{64}$/.test(report.planHash ?? '')
    && digest(report.before) === report.stateHash, 'REPORT_MISMATCH')
}

export function assertQuiescenceProof(proof, {target, manifestHash}, now = Date.now()) {
  const age = now - Date.parse(proof?.checkedAt)
  check(proof?.target === target && proof.manifestHash === manifestHash && proof.queue === 'pull-updated-data'
    && proof.paused === true && proof.active === 0 && Number.isFinite(age) && age >= 0 && age <= 30 * 60 * 1000,
  'QUIESCENCE_PROOF_INVALID')
}
