import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'

const root = fileURLToPath(new URL('../../../', import.meta.url))
export const historyFiles = ['scripts/willie/history.js', 'scripts/willie/lib/history.js', 'scripts/willie/lib/history-cli.js',
  'scripts/sage-overlap/lib/cli.js', 'scripts/network/prod-database-target.js', 'scripts/network/testing-database-target.js', 'db/connection-options.js']

export async function historyCodeHash() {
  const hash = createHash('sha256')
  for (const file of historyFiles) hash.update(file).update(await readFile(path.join(root, file)))
  return hash.digest('hex')
}

function validateWrites(command, values) {
  if (values.apply && !['apply', 'rollback'].includes(command)) throw new Error('WILLIE_APPLY_INVALID')
  if (command === 'rollback' && (!values.apply || !values['against-receipt'])) throw new Error('WILLIE_ROLLBACK_RECEIPT_REQUIRED')
  if (command === 'apply' && values.apply && (!values['against-report'] || !values['backup-proof'])) throw new Error('WILLIE_REVIEW_BACKUP_REQUIRED')
  if ((values['against-receipt'] && command !== 'rollback') || (values['against-report'] && command !== 'apply')
    || (values['backup-proof'] && (command !== 'apply' || !values.apply))) throw new Error('WILLIE_OPTIONS_INCOMPATIBLE')
}

export function parseHistoryOptions(args) {
  const {values, positionals} = parseArgs({args, allowPositionals: true, options: {
    ...Object.fromEntries(['scope', 'target', 'target-env', 'tunnel-port', 'report', 'against-report', 'against-receipt', 'backup-proof']
      .map(key => [key, {type: 'string'}])), apply: {type: 'boolean', default: false}
  }})
  const command = positionals[0] ?? 'review'
  if (positionals.length > 1 || !['review', 'apply', 'verify', 'rollback'].includes(command)) throw new Error('WILLIE_COMMAND_INVALID')
  if (!['prod', 'testing'].includes(values.target) || !values.scope || !values['target-env'] || !values.report) throw new Error('WILLIE_ARGUMENTS_REQUIRED')
  if (!/^\d+$/.test(values['tunnel-port'] ?? '') || Number(values['tunnel-port']) < 1024 || Number(values['tunnel-port']) > 65535) throw new Error('WILLIE_TUNNEL_REQUIRED')
  validateWrites(command, values)
  const inputs = [values.scope, values['target-env'], values['against-report'], values['against-receipt'], values['backup-proof']].filter(Boolean).map(file => path.resolve(file))
  const outputs = [values.report, `${values.report}.before.json`, `${values.report}.prepared.json`].map(file => path.resolve(file))
  if (outputs.some(file => inputs.includes(file))) throw new Error('WILLIE_OUTPUT_OVERWRITES_INPUT')
  return {command, values, port: Number(values['tunnel-port'])}
}

export function assertHistoryReport(report, {target, codeHash, scopeHash}, receipt = false) {
  if (!report || report.operation !== 'willie-history' || report.target !== target || report.codeHash !== codeHash
    || report.scopeHash !== scopeHash || report.complete !== true || report.blocked?.length
    || report.applied !== receipt || (receipt && report.status !== 'COMMITTED')
    || !/^[a-f\d]{64}$/.test(report.stateHash ?? '') || !/^[a-f\d]{64}$/.test(report.planHash ?? '')) throw new Error('WILLIE_REPORT_MISMATCH')
}
