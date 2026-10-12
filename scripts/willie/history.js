import process from 'node:process'
import {readFile, access} from 'node:fs/promises'
import pg from 'pg'
import {validateScope, reviewHistory, applyHistory, rollbackHistory, lockHistoryBeforeTransaction} from './lib/history.js'
import {parseHistoryOptions, historyCodeHash, assertHistoryReport} from './lib/history-cli.js'
import {assertPrivateOutput, writePrivateJson, verifyBackupProof, connectionOptions, assertTarget} from '../sage-overlap/lib/cli.js'

process.umask(0o077)
let client
let transaction = false
try {
  const options = parseHistoryOptions(process.argv.slice(2))
  const {command, values} = options
  const scope = JSON.parse(await readFile(values.scope, 'utf8'))
  validateScope(scope)
  const codeHash = await historyCodeHash()
  const identity = {target: values.target, codeHash, scopeHash: scope.scopeHash}
  const againstFile = command === 'rollback' ? values['against-receipt'] : values['against-report']
  const against = againstFile ? JSON.parse(await readFile(againstFile, 'utf8')) : null
  if (values.apply) {
    assertHistoryReport(against, identity, command === 'rollback')
    if (command === 'apply') await verifyBackupProof(values['backup-proof'], values.target, against)
  }
  await assertPrivateOutput(values.report)
  for (const output of [values.report, `${values.report}.before.json`, `${values.report}.prepared.json`]) {
    try { await access(output); throw new Error('WILLIE_OUTPUT_EXISTS') } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  client = new pg.Client({...await connectionOptions(options), application_name: 'willie-history',
    options: `-c statement_timeout=180000 -c lock_timeout=10000${values.apply ? '' : ' -c default_transaction_read_only=on'}`})
  await client.connect()
  await assertTarget(client, values.target)
  if (values.apply) await lockHistoryBeforeTransaction(client, scope)
  await client.query(values.apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  transaction = true
  await assertTarget(client, values.target)
  let result
  if (values.apply) {
    const before = await reviewHistory(client, scope)
    if (command === 'apply' && (!before.complete || before.stateHash !== against.stateHash || before.planHash !== against.planHash)) throw new Error('WILLIE_STATE_CHANGED')
    const backupPath = `${values.report}.before.json`
    await writePrivateJson(backupPath, {...identity, stateHash: before.stateHash, before: before.before, savedAt: new Date().toISOString()})
    result = command === 'rollback' ? await rollbackHistory(client, scope, against) : await applyHistory(client, scope, against)
    result = {...result, ...identity, backupPath, status: 'PREPARED', preparedAt: new Date().toISOString()}
    await writePrivateJson(`${values.report}.prepared.json`, result)
    await client.query('COMMIT')
    transaction = false
    result = {...result, status: 'COMMITTED', committedAt: new Date().toISOString()}
    await writePrivateJson(values.report, result)
  } else {
    result = await reviewHistory(client, scope)
    if (command === 'verify') result = {...result, complete: result.complete && result.changes.length === 0, ok: result.complete && result.changes.length === 0}
    result = {...result, ...identity, applied: false, checkedAt: new Date().toISOString()}
    await client.query('ROLLBACK')
    transaction = false
    await writePrivateJson(values.report, result)
  }
  console.log(JSON.stringify({command, target: values.target, applied: values.apply, complete: result.complete,
    summary: result.summary, blocked: result.blocked?.map(row => row.code), report: values.report}))
  if (!result.complete) process.exitCode = 1
} catch (error) {
  if (transaction) await client?.query('ROLLBACK').catch(() => {})
  console.error(JSON.stringify({error: /^[A-Z0-9_]{1,100}$/.test(error.message ?? '') ? error.message
    : /^[A-Z0-9_]{1,100}$/.test(error.code ?? '') ? error.code : 'WILLIE_HISTORY_FAILED'}))
  process.exitCode = 1
} finally {
  await client?.end()
}
