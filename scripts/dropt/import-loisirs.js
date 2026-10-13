import process from 'node:process'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import pg from 'pg'
import {digest} from './lib/epidropt.js'
import {prepareLoisirsManifest, validateLoisirsManifest} from './lib/loisirs-source.js'
import {readLoisirsState, planLoisirs, applyLoisirsPlan} from './lib/loisirs-apply.js'
import {preserveAepInput, fileSha256, saveAepManifest} from './lib/aep-cli.js'
import {assertPrivateOutput, writePrivateJson, connectionOptions, assertTarget, verifyBackupProof} from '../sage-overlap/lib/cli.js'

process.umask(0o077)
const scriptsDirectory = fileURLToPath(new URL('../', import.meta.url))
function assertPreserved(before, after) {
  for (const name of ['PointPrelevement', 'Declarant', 'User', 'PointPrelevementZone', 'SandreWaterUse', 'CollectionResponse',
    'MeterAllocation', 'DeclarantCollecteurExploitation', 'DeclarantPointPrelevementConnector', 'DeclarantPointPrelevementSecondaryUsage']) {
    if (digest(before.tables[name]) !== digest(after.tables[name])) throw new Error('LOISIRS_UNEXPECTED_CHANGE')
  }
}

let client
try {
  const {positionals, values} = parseArgs({allowPositionals: true, options: {
    ...Object.fromEntries(['input', 'source', 'previous-manifest', 'decisions', 'target', 'target-env', 'tunnel-port', 'report', 'against-report', 'backup-proof'].map(key => [key, {type: 'string'}])),
    apply: {type: 'boolean', default: false}
  }})
  const command = positionals[0]
  if (positionals.length !== 1 || !['prepare', 'review', 'apply', 'verify'].includes(command) || !values.input) throw new Error('LOISIRS_ARGUMENTS_INVALID')
  const input = path.resolve(values.input)
  if (command === 'prepare') {
    if (!values.source || !values['previous-manifest'] || !values.decisions || values.apply
      || ['target', 'target-env', 'tunnel-port', 'report', 'against-report', 'backup-proof'].some(key => values[key])) throw new Error('LOISIRS_PREPARE_ARGUMENTS_INVALID')
    const sourceFile = await preserveAepInput(values.source, input)
    const previousManifestFile = await preserveAepInput(values['previous-manifest'], input)
    const decisionsFile = await preserveAepInput(values.decisions, input)
    const decisions = JSON.parse(await readFile(decisionsFile, 'utf8'))
    const manifest = await prepareLoisirsManifest({epidroptFile: sourceFile, previousManifestFile, decisions})
    await saveAepManifest(input, manifest)
    await writePrivateJson(path.join(input, 'mapping/sources.json'), {
      source: {name: path.basename(sourceFile), sha256: await fileSha256(sourceFile)},
      previousManifest: {name: path.basename(previousManifestFile), sha256: await fileSha256(previousManifestFile)},
      decisions: {name: path.basename(decisionsFile), sha256: await fileSha256(decisionsFile)}, manifestHash: manifest.manifestHash
    }, {replace: true})
    console.log(JSON.stringify({command, manifestHash: manifest.manifestHash, points: manifest.points.length, declarants: manifest.declarants.length, exploitations: manifest.exploitations.length}))
  } else {
    const port = Number(values['tunnel-port'])
    if (!['testing', 'prod'].includes(values.target) || !values['target-env'] || !values.report
      || !/^\d+$/.test(values['tunnel-port'] ?? '') || !Number.isInteger(port) || port < 1024 || port > 65535
      || ['source', 'previous-manifest', 'decisions'].some(key => values[key])
      || (values.apply && command !== 'apply')
      || (values.apply && (!values['against-report'] || !values['backup-proof']))
      || (!values.apply && (values['against-report'] || values['backup-proof']))) throw new Error('LOISIRS_REMOTE_ARGUMENTS_INVALID')
    await assertPrivateOutput(values.report)
    const manifest = JSON.parse(await readFile(path.join(input, 'mapping/manifest.json'), 'utf8'))
    validateLoisirsManifest(manifest)
    const sources = JSON.parse(await readFile(path.join(input, 'mapping/sources.json'), 'utf8'))
    if (sources.manifestHash !== manifest.manifestHash) throw new Error('LOISIRS_SOURCE_MANIFEST_MISMATCH')
    for (const source of [sources.source, sources.previousManifest, sources.decisions]) {
      if (path.basename(source.name) !== source.name || await fileSha256(path.join(input, 'raw', source.name)) !== source.sha256) throw new Error('LOISIRS_SOURCE_CHANGED')
    }
    // Rebuild from the preserved evidence on every run, including production.
    const rebuilt = await prepareLoisirsManifest({epidroptFile: path.join(input, 'raw', sources.source.name),
      previousManifestFile: path.join(input, 'raw', sources.previousManifest.name),
      decisions: JSON.parse(await readFile(path.join(input, 'raw', sources.decisions.name), 'utf8'))})
    if (rebuilt.manifestHash !== manifest.manifestHash) throw new Error('LOISIRS_SOURCE_REBUILD_MISMATCH')
    const codeFiles = ['dropt/import-loisirs.js', 'dropt/lib/loisirs-source.js', 'dropt/lib/loisirs-apply.js', 'dropt/lib/epidropt.js',
      'dropt/lib/reconciliation.js', 'dropt/lib/reviewed-inputs.js', 'dropt/lib/aep-cli.js', 'sage-overlap/lib/cli.js',
      'network/prod-database-target.js', 'network/testing-database-target.js', '../db/connection-options.js',
      '../lib/services/import-aliases.js', '../package-lock.json']
    const codeHash = digest(await Promise.all(codeFiles.map(async name => [name, await fileSha256(path.join(scriptsDirectory, name))])))
    const expected = values.apply ? JSON.parse(await readFile(values['against-report'], 'utf8')) : null
    if (expected && (expected.operation !== 'import-dropt-loisirs' || expected.target !== values.target
      || expected.manifestHash !== manifest.manifestHash || expected.codeHash !== codeHash || expected.applied !== false
      || !expected.complete || expected.blocked.length)) throw new Error('LOISIRS_REVIEW_MISMATCH')
    if (values.apply) await verifyBackupProof(values['backup-proof'], values.target, expected)
    client = new pg.Client(await connectionOptions({values, port}))
    await client.connect()
    await client.query(values.apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await assertTarget(client, values.target)
    if (values.apply) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('dropt-referential'),hashtext('epidropt'))")
      await client.query('SELECT id FROM "PointPrelevement" WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [manifest.points.map(row => row.id)])
      await client.query('SELECT "userId" FROM "Declarant" WHERE "userId"=ANY($1::uuid[]) ORDER BY "userId" FOR UPDATE', [manifest.declarants.map(row => row.id)])
      await client.query('SELECT id FROM "DeclarantPointPrelevement" WHERE "pointPrelevementId"=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [manifest.points.map(row => row.id)])
    }
    const before = await readLoisirsState(client, manifest)
    const plan = planLoisirs(manifest, before)
    const report = {operation: 'import-dropt-loisirs', command, target: values.target, codeHash, manifestHash: manifest.manifestHash,
      checkedAt: new Date().toISOString(), applied: false, complete: plan.blocked.length === 0, ...plan, stateHash: before.stateHash, before}
    if (expected && (before.stateHash !== expected.stateHash || plan.planHash !== expected.planHash)) throw new Error('LOISIRS_STATE_CHANGED')
    if (values.apply) {
      await applyLoisirsPlan(client, plan)
      const after = await readLoisirsState(client, manifest)
      const replay = planLoisirs(manifest, after)
      if (replay.blocked.length || replay.changes.length) throw new Error('LOISIRS_VERIFY_FAILED')
      assertPreserved(before, after)
      Object.assign(report, {after, applied: true, transactionStatus: 'PREPARED', replayChanges: 0})
      await writePrivateJson(values.report, report)
      await client.query('COMMIT')
      report.transactionStatus = 'COMMITTED'
      await writePrivateJson(values.report, report, {replace: true})
    } else {
      await client.query('ROLLBACK')
      if (command === 'verify' && plan.changes.length) report.complete = false
      await writePrivateJson(values.report, report)
    }
    console.log(JSON.stringify({operation: report.operation, command, applied: report.applied, complete: report.complete,
      changes: plan.changes.map(row => row.action), blocked: plan.blocked, report: path.resolve(values.report)}))
    if (!report.complete) process.exitCode = 1
  }
} catch (error) {
  await client?.query('ROLLBACK').catch(() => {})
  console.error(JSON.stringify({error: /^[A-Z0-9_]{1,100}$/.test(error.message ?? '') ? error.message : error.code ?? 'LOISIRS_IMPORT_FAILED'}))
  process.exitCode = 1
} finally {
  await client?.end()
}
