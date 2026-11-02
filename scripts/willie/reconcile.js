import process from 'node:process'
import {readFile, access} from 'node:fs/promises'
import pg from 'pg'
import {validateManifest, reviewReconcile, applyReconcile, rollbackReconcile, lockReconcileBeforeTransaction, check} from './lib/reconcile.js'
import {parseReconcileOptions, reconcileCodeHash, assertReconcileReport, assertQuiescenceProof} from './lib/reconcile-cli.js'
import {assertPrivateOutput, writePrivateJson, verifyBackupProof, connectionOptions, assertTarget} from '../sage-overlap/lib/cli.js'

process.umask(0o077)
let client
let transaction = false
try {
  const options = parseReconcileOptions(process.argv.slice(2))
  const {command, values} = options
  const manifest = JSON.parse(await readFile(values.manifest, 'utf8'))
  const payload = JSON.parse(await readFile(values.payload, 'utf8'))
  validateManifest(manifest, payload)
  const identity = {target: values.target, codeHash: await reconcileCodeHash(), manifestHash: manifest.manifestHash,
    payloadHash: payload.payloadHash}
  const againstFile = command === 'rollback' ? values['against-receipt'] : values['against-report']
  const against = againstFile ? JSON.parse(await readFile(againstFile, 'utf8')) : null
  if (values.apply) {
    assertReconcileReport(against, identity, command === 'rollback')
    if (command === 'apply') await verifyBackupProof(values['backup-proof'], values.target, against)
    assertQuiescenceProof(JSON.parse(await readFile(values['quiescence-proof'], 'utf8')), identity)
  }
  await assertPrivateOutput(values.report)
  for (const output of [values.report, `${values.report}.before.json`, `${values.report}.prepared.json`]) {
    try { await access(output); throw new Error('WILLIE_RECONCILE_OUTPUT_EXISTS') } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  client = new pg.Client({...await connectionOptions(options), application_name: 'willie-reconcile',
    options: `-c statement_timeout=180000 -c lock_timeout=10000${values.apply ? '' : ' -c default_transaction_read_only=on'}`})
  await client.connect()
  await assertTarget(client, values.target)
  // Session locks precede BEGIN so a writer that was already running cannot leave us with a stale snapshot.
  if (values.apply) await lockReconcileBeforeTransaction(client, manifest)
  await client.query(values.apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  transaction = true
  await assertTarget(client, values.target)
  let result
  if (values.apply) {
    assertQuiescenceProof(JSON.parse(await readFile(values['quiescence-proof'], 'utf8')), identity)
    const before = await reviewReconcile(client, manifest, payload)
    if (command === 'apply') check(before.complete && before.stateHash === against.stateHash && before.planHash === against.planHash, 'STATE_CHANGED')
    const backupPath = `${values.report}.before.json`
    await writePrivateJson(backupPath, {...identity, stateHash: before.stateHash, before: before.before, savedAt: new Date().toISOString()})
    result = command === 'rollback' ? await rollbackReconcile(client, manifest, payload, against) : await applyReconcile(client, manifest, payload, against)
    result = {...result, ...identity, backupPath, status: 'PREPARED', preparedAt: new Date().toISOString()}
    await writePrivateJson(`${values.report}.prepared.json`, result)
    await client.query('COMMIT')
    transaction = false
    result = {...result, status: 'COMMITTED', committedAt: new Date().toISOString()}
    await writePrivateJson(values.report, result)
  } else {
    result = await reviewReconcile(client, manifest, payload)
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
    : /^[A-Z0-9_]{1,100}$/.test(error.code ?? '') ? error.code : 'WILLIE_RECONCILE_FAILED'}))
  process.exitCode = 1
} finally {
  await client?.end()
}
