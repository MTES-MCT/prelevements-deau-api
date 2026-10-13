import process from 'node:process'
import path from 'node:path'
import {readFile, access} from 'node:fs/promises'
import pg from 'pg'
import {prepareAepManifest, digest} from './lib/aep-source.js'
import {reviewAep, applyAep, verifyAep} from './lib/aep-apply.js'
import {rollbackAep} from './lib/aep-rollback.js'
import {parseAepOptions, aepCodeHash, preserveAepInput, saveAepManifest, loadAepManifest, assertAepReviewedReport} from './lib/aep-cli.js'
import {assertPrivateOutput, writePrivateJson, verifyBackupProof, connectionOptions, assertTarget} from '../sage-overlap/lib/cli.js'

process.umask(0o077)
let client
let transaction = false
let options
try {
  options = parseAepOptions(process.argv.slice(2))
  const {command, values, input} = options
  await assertPrivateOutput(path.join(input, 'mapping/manifest.json'))
  if (command === 'prepare') {
    const aepFile = await preserveAepInput(values['aep-file'], input)
    const legacyFile = await preserveAepInput(values['legacy-file'], input)
    const decisions = JSON.parse(await readFile(values.decisions, 'utf8'))
    const manifest = await prepareAepManifest({aepFile, legacyFile, decisions})
    await saveAepManifest(input, manifest)
    console.log(JSON.stringify({command, manifestHash: manifest.manifestHash,
      counts: Object.fromEntries(['declarants', 'points', 'exploitations', 'retirements', 'issues'].map(key => [key, manifest[key].length]))}))
  } else {
    await assertPrivateOutput(values.report)
    try { await access(values.report); throw new Error('AEP_REPORT_ALREADY_EXISTS') } catch (error) { if (error.code !== 'ENOENT') throw error }
    const manifest = await loadAepManifest(input, digest)
    const codeHash = await aepCodeHash()
    const against = values['against-report'] ? JSON.parse(await readFile(values['against-report'], 'utf8')) : undefined
    if (values.apply && command === 'apply') {
      assertAepReviewedReport(against, {target: values.target, codeHash, manifestHash: manifest.manifestHash})
      await verifyBackupProof(values['backup-proof'], values.target, against)
    }
    if (command === 'rollback' && (against?.target !== values.target || against?.status !== 'COMMITTED'
      || against?.manifestHash !== manifest.manifestHash || against?.codeHash !== codeHash)) throw new Error('AEP_ROLLBACK_RECEIPT_MISMATCH')
    client = new pg.Client({...await connectionOptions(options), application_name: 'dropt-aep-import',
      options: `-c statement_timeout=60000 -c lock_timeout=5000${values.apply ? '' : ' -c default_transaction_read_only=on'}`})
    await client.connect()
    await assertTarget(client, values.target)
    await client.query(values.apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    transaction = true
    await assertTarget(client, values.target)
    let result
    if (values.apply) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('dropt-referential'), hashtext('epidropt'))")
      const live = await reviewAep(client, manifest)
      if (command === 'apply' && (!live.complete || live.blocked.length || live.stateHash !== against.stateHash || live.planHash !== against.planHash)) throw new Error('AEP_STATE_CHANGED')
      const backupPath = `${values.report}.before.json`
      await writePrivateJson(backupPath, {target: values.target, manifestHash: manifest.manifestHash, codeHash, stateHash: live.stateHash, before: live.before})
      result = command === 'rollback' ? await rollbackAep(client, manifest, against) : await applyAep(client, manifest, live)
      const verification = command === 'rollback' ? result.verification : await verifyAep(client, manifest)
      if (command === 'apply' && (!verification.ok || !verification.complete)) throw new Error('AEP_VERIFICATION_FAILED')
      result = {...result, verification, target: values.target, codeHash, backupPath, status: 'PREPARED', preparedAt: new Date().toISOString()}
      await writePrivateJson(values.report, result)
      await client.query('COMMIT')
      transaction = false
      result = {...result, status: 'COMMITTED', committedAt: new Date().toISOString()}
      await writePrivateJson(values.report, result, {replace: true})
    } else {
      result = command === 'verify' ? await verifyAep(client, manifest) : await reviewAep(client, manifest)
      result = {...result, target: values.target, codeHash, applied: false, checkedAt: new Date().toISOString()}
      await client.query('ROLLBACK')
      transaction = false
      await writePrivateJson(values.report, result)
    }
    console.log(JSON.stringify({command, target: values.target, applied: values.apply, complete: result.complete,
      ok: result.ok ?? result.verification?.ok, summary: result.summary, blocked: result.blocked?.map(item => item.code), report: values.report}))
    if (result.complete === false || result.ok === false) process.exitCode = 1
  }
} catch (error) {
  if (transaction) await client?.query('ROLLBACK').catch(() => {})
  const safeCode = /^[A-Z0-9_]{1,100}$/.test(error.message ?? '') ? error.message
    : /^[A-Z0-9_]{1,100}$/.test(error.code ?? '') ? error.code : 'AEP_OPERATION_FAILED'
  console.error(JSON.stringify({error: safeCode}))
  process.exitCode = 1
} finally {
  await client?.end()
}
