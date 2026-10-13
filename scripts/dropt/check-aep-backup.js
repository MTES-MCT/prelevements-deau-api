import process from 'node:process'
import path from 'node:path'
import {parseArgs, parseEnv} from 'node:util'
import {readFile} from 'node:fs/promises'
import pg from 'pg'
import {digest} from './lib/aep-source.js'
import {fileSha256} from './lib/aep-cli.js'
import {writePrivateJson, assertPrivateOutput} from '../sage-overlap/lib/cli.js'

// Only a fresh, isolated restoration database can receive these source rows.
// Production is never a supported destination for this command.
process.umask(0o077)
let client
try {
  const {values, positionals} = parseArgs({allowPositionals: true, options: Object.fromEntries(
    ['against-report', 'backup', 'schema-dump', 'restore-env', 'report'].map(key => [key, {type: 'string'}]))})
  if (positionals.length || Object.keys(values).length !== 5) throw new Error('AEP_BACKUP_ARGUMENTS_INVALID')
  const files = Object.values(values).map(file => path.resolve(file))
  if (new Set(files).size !== files.length) throw new Error('AEP_BACKUP_PATH_COLLISION')
  await assertPrivateOutput(values.backup)
  await assertPrivateOutput(values.report)
  const review = JSON.parse(await readFile(values['against-report'], 'utf8'))
  if (review.operation !== 'import-dropt-aep' || !['prod', 'testing'].includes(review.target)
    || !review.complete || review.applied !== false || review.blocked?.length) throw new Error('AEP_BACKUP_REVIEW_INVALID')
  const schemaDumpSha256 = await fileSha256(values['schema-dump'])
  const tables = review.before?.tables
  // This backup workflow supports the initial import into absent identities.
  // Reused identities require a separately reviewed backup scope.
  for (const table of ['User', 'Declarant', 'DeclarantContactEmail', 'UserEmailIdentity', 'UserEmailAlias',
    'UserEmailVerification', 'DeclarantPointPrelevement', 'DeclarantZone']) {
    if (!Array.isArray(tables?.[table]) || tables[table].length) throw new Error('AEP_BACKUP_SCOPE_NOT_EMPTY')
  }
  const selected = ['Zone', 'PointPrelevement', 'PointPrelevementZone', 'ExternalReference']
  for (const table of selected) if (!Array.isArray(tables?.[table])) throw new Error('AEP_BACKUP_TABLE_MISSING')
  const backup = {version: 1, target: review.target, manifestHash: review.manifestHash, codeHash: review.codeHash,
    stateHash: review.stateHash, schemaDumpSha256, before: review.before, createdAt: new Date().toISOString()}
  await writePrivateJson(values.backup, backup)
  // Read the actual persisted backup, not the object still in memory.
  const saved = JSON.parse(await readFile(values.backup, 'utf8'))
  const environment = parseEnv(await readFile(values['restore-env'], 'utf8'))
  const url = new URL(environment.DATABASE_URL)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.port !== '55445' || url.pathname !== '/aep_backup_restore' || url.search || url.hash
    || decodeURIComponent(url.username) !== 'postgres') throw new Error('AEP_RESTORE_TARGET_INVALID')
  client = new pg.Client({connectionString: url.toString(), application_name: 'aep-backup-restore-check'})
  await client.connect()
  const identity = (await client.query('SELECT current_database() db, current_user AS role')).rows[0]
  if (identity.db !== 'aep_backup_restore' || identity.role !== 'postgres') throw new Error('AEP_RESTORE_IDENTITY_INVALID')
  await client.query('BEGIN')
  for (const table of selected) {
    const count = (await client.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n
    if (count) throw new Error('AEP_RESTORE_NOT_EMPTY')
  }
  const restored = {}
  for (const table of selected) {
    for (const item of saved.before.tables[table]) {
      const row = {...item}
      if (Object.hasOwn(row, 'coordinatesEWKB')) {
        row.coordinates = row.coordinatesEWKB
        delete row.coordinatesEWKB
      }
      delete row.coordinateValues
      await client.query(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, [JSON.stringify(row)])
    }
    const projection = table === 'PointPrelevement'
      ? "to_jsonb(t) - 'coordinates' || jsonb_build_object('coordinatesEWKB', encode(ST_AsEWKB(t.coordinates), 'hex'), 'coordinateValues', CASE WHEN t.coordinates IS NULL THEN NULL ELSE jsonb_build_array(ST_X(t.coordinates), ST_Y(t.coordinates)) END)"
      : table === 'Zone' ? "to_jsonb(t) - 'coordinates' || jsonb_build_object('coordinatesEWKB', encode(ST_AsEWKB(t.coordinates), 'hex'))" : 'to_jsonb(t)'
    const rows = (await client.query(`SELECT ${projection} AS row FROM "${table}" t ORDER BY id`)).rows.map(record => record.row)
    const expected = [...saved.before.tables[table]].sort((a, b) => a.id.localeCompare(b.id))
    if (digest(rows) !== digest(expected)) throw new Error('AEP_RESTORE_MISMATCH')
    restored[table] = {count: rows.length, sha256: digest(rows)}
  }
  await client.query('COMMIT')
  const proof = {version: 1, target: saved.target, manifestHash: saved.manifestHash, codeHash: saved.codeHash,
    stateHash: saved.stateHash, backupFile: path.resolve(values.backup), backupSha256: await fileSha256(values.backup),
    schemaDumpFile: path.resolve(values['schema-dump']), schemaDumpSha256, restoreMatched: true,
    restoredAt: new Date().toISOString(), restored}
  await writePrivateJson(values.report, proof)
  console.log(JSON.stringify({restoreMatched: true, target: proof.target, tables: Object.fromEntries(Object.entries(restored).map(([key, row]) => [key, row.count])), proof: values.report}))
} catch (error) {
  await client?.query('ROLLBACK').catch(() => {})
  console.error(JSON.stringify({error: /^[A-Z0-9_]{1,100}$/.test(error.message ?? '') ? error.message : error.code ?? 'AEP_BACKUP_CHECK_FAILED'}))
  process.exitCode = 1
} finally {
  await client?.end()
}
