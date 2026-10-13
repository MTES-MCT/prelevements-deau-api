import {createHash} from 'node:crypto'
import {reviewAep} from './aep-apply.js'
import {digest as sourceDigest} from './aep-source.js'

const digest = value => sourceDigest(JSON.parse(JSON.stringify(value)))
const assert = (condition, code) => { if (!condition) throw new Error(code) }
const quote = value => `"${value.replaceAll('"', '""')}"`
const kinds = {declarants: ['Declarant', 'userId'], points: ['PointPrelevement', 'id'],
  exploitations: ['DeclarantPointPrelevement', 'id'], retirements: ['PointPrelevement', 'id']}
const keyOf = table => table === 'Declarant' ? 'userId' : 'id'
const same = (left, right) => digest(left) === digest(right)
const stableId = key => {
  const hash = createHash('sha256').update(`dropt-aep:${key}`).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

function validateReceipt(manifest, receipt) {
  assert(receipt?.status === 'COMMITTED' && receipt.applied === true && receipt.complete === true
    && receipt.operation === 'import-dropt-aep' && receipt.manifestHash === manifest.manifestHash
    && receipt.verification?.ok === true && receipt.verification?.review?.complete === true,
  'AEP_ROLLBACK_COMMITTED_RECEIPT_REQUIRED')
  const after = receipt.verification.review
  assert(receipt.stateHash === digest(receipt.before) && after.stateHash === digest(after.before)
    && after.manifestHash === manifest.manifestHash && after.changes.length === 0
    && receipt.planHash === digest({manifestHash: receipt.manifestHash, stateHash: receipt.stateHash,
      pins: receipt.pins, changes: receipt.changes})
    && Array.isArray(receipt.before.identityLocks) && Array.isArray(after.before.identityLocks),
  'AEP_ROLLBACK_RECEIPT_INVALID')
  validateChanges(manifest, receipt)
}

function validateChanges(manifest, receipt) {
  const after = receipt.verification.review
  const seen = new Set()
  for (const change of receipt.changes) {
    const mapping = kinds[change.kind]
    assert(mapping && !seen.has(`${change.kind}:${change.id}`), 'AEP_ROLLBACK_CHANGE_INVALID')
    seen.add(`${change.kind}:${change.id}`)
    const [table, key] = mapping
    const previous = receipt.before.tables[table].find(row => row[key] === change.id)
    const created = after.before.tables[table].find(row => row[key] === change.id)
    assert(created, 'AEP_ROLLBACK_CHANGE_INVALID')
    if (change.kind === 'retirements') {
      assert(change.action === 'RETIRE' && previous?.deletedAt === null && created.deletedAt
        && receipt.pins.retirements.some(pin => pin.id === change.id), 'AEP_ROLLBACK_CHANGE_INVALID')
    } else {
      assert(change.action === 'CREATE' && !previous && manifest[change.kind].some(row => row.id === change.id),
        'AEP_ROLLBACK_CHANGE_INVALID')
    }
  }
}

function deletionPlan(receipt) {
  const before = receipt.before.tables
  const after = receipt.verification.review.before.tables
  const ids = kind => receipt.changes.filter(change => change.kind === kind).map(change => change.id)
  const users = ids('declarants')
  const points = ids('points')
  const plan = {
    DeclarantPointPrelevement: after.DeclarantPointPrelevement.filter(row => ids('exploitations').includes(row.id)),
    DeclarantZone: after.DeclarantZone.filter(row => users.includes(row.declarantUserId)),
    ExternalReference: after.ExternalReference.filter(row => users.includes(row.declarantUserId) || points.includes(row.pointPrelevementId)),
    DeclarantContactEmail: after.DeclarantContactEmail.filter(row => users.includes(row.declarantUserId)),
    PointPrelevementZone: after.PointPrelevementZone.filter(row => points.includes(row.pointPrelevementId)),
    PointPrelevement: after.PointPrelevement.filter(row => points.includes(row.id)),
    Declarant: after.Declarant.filter(row => users.includes(row.userId)),
    User: after.User.filter(row => users.includes(row.id))
  }
  for (const [table, records] of Object.entries(plan)) {
    assert(records.every(row => !before[table].some(previous => previous[keyOf(table)] === row[keyOf(table)])),
      'AEP_ROLLBACK_PREEXISTING_ROW')
  }
  return plan
}

async function lockRows(client, receipt, plan) {
  // FOR UPDATE blocks concurrent inserts that acquire a foreign-key key-share lock.
  for (const table of ['User', 'Declarant', 'PointPrelevement', 'DeclarantPointPrelevement', 'ExternalReference',
    'DeclarantZone', 'DeclarantContactEmail', 'PointPrelevementZone']) {
    const key = keyOf(table)
    const ids = plan[table].map(row => row[key])
    if (table === 'PointPrelevement') ids.push(...receipt.pins.retirements.map(row => row.id))
    if (table === 'ExternalReference') ids.push(...receipt.pins.retirements.map(row => row.referenceId))
    await client.query(`SELECT ${quote(key)} FROM ${quote(table)} WHERE ${quote(key)}=ANY($1::uuid[]) ORDER BY ${quote(key)} FOR UPDATE`, [ids])
  }
}

async function assertNoForeignAttachments(client, plan) {
  const userIds = plan.User.map(row => row.id)
  const {rows: [unconstrained]} = await client.query(`SELECT
    EXISTS(SELECT 1 FROM "DeclarationProcessingEvent" WHERE "createdByUserId"=ANY($1::uuid[]))
    OR EXISTS(SELECT 1 FROM "DeclarantZone" WHERE "createdByUserId"=ANY($1::uuid[])
      AND NOT(id=ANY($2::uuid[]))) AS attached`, [userIds, plan.DeclarantZone.map(row => row.id)])
  assert(!unconstrained.attached, 'AEP_ROLLBACK_FOREIGN_ATTACHMENT')
  // Inspect every incoming FK, including CASCADE and SET NULL relationships that
  // would otherwise silently remove or alter records outside this import.
  const {rows: references} = await client.query(`SELECT n.nspname AS schema,c.relname AS table,
    target.relname AS target,a.attname AS column,referenced.attname AS "targetColumn",
    cardinality(fk.conkey) AS width
    FROM pg_constraint fk JOIN pg_class c ON c.oid=fk.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_class target ON target.oid=fk.confrelid JOIN pg_namespace tn ON tn.oid=target.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=fk.conkey[1]
    JOIN pg_attribute referenced ON referenced.attrelid=target.oid AND referenced.attnum=fk.confkey[1]
    WHERE fk.contype='f' AND tn.nspname=current_schema() AND target.relname=ANY($1::text[])
    ORDER BY n.nspname,c.relname,a.attname`, [Object.keys(plan)])
  for (const ref of references) {
    const targets = plan[ref.target].map(row => row[ref.targetColumn])
    if (!targets.length) continue
    assert(ref.width === 1, 'AEP_ROLLBACK_UNSUPPORTED_FOREIGN_KEY')
    const {rows} = await client.query(`SELECT to_jsonb(t) AS row FROM ${quote(ref.schema)}.${quote(ref.table)} t
      WHERE ${quote(ref.column)}::text=ANY($1::text[])`, [targets])
    const allowed = plan[ref.table] ?? []
    assert(rows.every(({row}) => ref.schema === 'public' && allowed.some(expected => same(expected, row))),
      'AEP_ROLLBACK_FOREIGN_ATTACHMENT')
  }
}

async function auditFingerprint(client, manifestHash) {
  const result = {}
  for (const [table, where] of [
    ['AuditEvent', 't.metadata->>\'manifestHash\'=$1'],
    ['AuditMutation', 't."auditEventId" IN (SELECT id FROM "AuditEvent" WHERE metadata->>\'manifestHash\'=$1)'],
    ['AuditMutationScope', 't."auditMutationId" IN (SELECT m.id FROM "AuditMutation" m JOIN "AuditEvent" e ON e.id=m."auditEventId" WHERE e.metadata->>\'manifestHash\'=$1)']
  ]) {
    const {rows: [row]} = await client.query(`SELECT count(*)::int AS count,
      md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]')) AS hash FROM "${table}" t WHERE ${where}`, [manifestHash])
    result[table] = row
  }
  return result
}

async function restoreIdentityLocks(client, receipt, plan) {
  const current = receipt.verification.review.before.identityLocks
  for (const row of current) {
    if (!plan.DeclarantPointPrelevement.some(exploitation => exploitation.declarantUserId === row.declarantUserId
      && exploitation.pointPrelevementId === row.pointPrelevementId)) continue
    const previous = receipt.before.identityLocks.find(old => old.declarantUserId === row.declarantUserId
      && old.pointPrelevementId === row.pointPrelevementId)
    if (previous) {
      await client.query('UPDATE "ExploitationIdentityLock" SET revision=$3 WHERE "declarantUserId"=$1 AND "pointPrelevementId"=$2',
        [row.declarantUserId, row.pointPrelevementId, previous.revision])
    } else {
      await client.query('DELETE FROM "ExploitationIdentityLock" WHERE "declarantUserId"=$1 AND "pointPrelevementId"=$2',
        [row.declarantUserId, row.pointPrelevementId])
    }
  }
}

async function restoreRows(client, receipt, plan) {
  for (const [table, records] of Object.entries(plan)) {
    if (!records.length) continue
    const result = await client.query(`DELETE FROM ${quote(table)} WHERE ${quote(keyOf(table))}=ANY($1::uuid[])`,
      [records.map(row => row[keyOf(table)])])
    assert(result.rowCount === records.length, 'AEP_ROLLBACK_DELETE_COUNT_CHANGED')
  }
  await restoreIdentityLocks(client, receipt, plan)
  for (const change of receipt.changes.filter(change => change.kind === 'retirements')) {
    const previous = receipt.before.tables.PointPrelevement.find(row => row.id === change.id)
    const referenceId = receipt.pins.retirements.find(pin => pin.id === change.id).referenceId
    const reference = receipt.before.tables.ExternalReference.find(row => row.id === referenceId)
    assert(reference, 'AEP_ROLLBACK_REFERENCE_MISSING')
    // Pass timestamp strings directly to PostgreSQL to preserve microseconds.
    const pointResult = await client.query('UPDATE "PointPrelevement" SET "deletedAt"=$2::timestamp,"updatedAt"=$3::timestamp WHERE id=$1',
      [change.id, previous.deletedAt, previous.updatedAt])
    const refResult = await client.query('UPDATE "ExternalReference" SET metadata=$2::jsonb WHERE id=$1',
      [referenceId, JSON.stringify(reference.metadata)])
    assert(pointResult.rowCount === 1 && refResult.rowCount === 1, 'AEP_ROLLBACK_RESTORE_COUNT_CHANGED')
  }
}

async function recordRollbackAudit(client, manifest, receipt) {
  for (const change of receipt.changes) {
    const id = stableId(`rollback-audit:${manifest.manifestHash}:${change.kind}:${change.id}`)
    const [table, key] = kinds[change.kind]
    const previous = receipt.verification.review.before.tables[table].find(row => row[key] === change.id)
    const restored = receipt.before.tables[table].find(row => row[key] === change.id) ?? null
    await client.query(`INSERT INTO "AuditEvent" (id,"occurredAt","completedAt","updatedAt",outcome,"actionType","actionCategory",
      "actorType","actorLabel","targetType","targetId","requestId","httpMethod",route,"statusCode",metadata)
      VALUES ($1,now(),now(),now(),'SUCCESS','AEP.ROLLED_BACK','IMPORT','ANONYMOUS','Maintenance retour arrière AEP',
      $2,$3,$4,'CLI','scripts/dropt/import-aep/rollback',200,$5::jsonb)`,
    [id, table, change.id, `dropt-aep-rollback:${manifest.manifestHash}`, JSON.stringify({rollbackOfManifestHash: manifest.manifestHash, maintenance: true})])
    await client.query(`INSERT INTO "AuditMutation" (id,"auditEventId",operation,"entityType","entityId",before,after,"changedFields","redactedFields",metadata)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::text[],ARRAY[]::text[],$9::jsonb)`,
    [stableId(`mutation:${id}`), id, restored ? 'UPDATE' : 'DELETE', table, change.id, JSON.stringify(previous), JSON.stringify(restored),
      restored ? ['deletedAt', 'updatedAt'] : Object.keys(previous), JSON.stringify({rollbackOfManifestHash: manifest.manifestHash})])
  }
}

export async function rollbackAep(client, manifest, receipt) {
  const {rows: [transaction]} = await client.query('SELECT current_setting(\'transaction_isolation\') AS isolation,current_setting(\'transaction_read_only\') AS "readOnly",now() < statement_timestamp() AS "explicitTransaction"')
  assert(transaction.isolation === 'serializable' && transaction.readOnly === 'off' && transaction.explicitTransaction,
    'AEP_SERIALIZABLE_TRANSACTION_REQUIRED')
  validateReceipt(manifest, receipt)
  await client.query('SELECT pg_advisory_xact_lock(hashtext(\'dropt-referential\'),hashtext(\'epidropt\'))')
  const plan = deletionPlan(receipt)
  await lockRows(client, receipt, plan)
  const current = await reviewAep(client, manifest)
  assert(current.complete && current.stateHash === receipt.verification.review.stateHash, 'AEP_ROLLBACK_STATE_CHANGED')
  await assertNoForeignAttachments(client, plan)
  const auditsBefore = await auditFingerprint(client, manifest.manifestHash)
  await client.query('SAVEPOINT dropt_aep_rollback')
  try {
    await restoreRows(client, receipt, plan)
    const after = await reviewAep(client, manifest)
    assert(after.stateHash === receipt.stateHash, 'AEP_ROLLBACK_POSTCONDITION_FAILED')
    assert(same(auditsBefore, await auditFingerprint(client, manifest.manifestHash)), 'AEP_ROLLBACK_AUDIT_CHANGED')
    await recordRollbackAudit(client, manifest, receipt)
    await client.query('RELEASE SAVEPOINT dropt_aep_rollback')
    return {operation: 'rollback-dropt-aep', manifestHash: manifest.manifestHash, complete: true, restored: true,
      beforeStateHash: current.stateHash, afterStateHash: after.stateHash, originalAudits: auditsBefore,
      summary: {changes: receipt.changes.length, deleted: Object.fromEntries(Object.entries(plan).map(([table, records]) => [table, records.length])),
        restoredPoints: receipt.changes.filter(change => change.kind === 'retirements').length}, verification: {ok: true, review: after}}
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT dropt_aep_rollback')
    await client.query('RELEASE SAVEPOINT dropt_aep_rollback')
    throw error
  }
}
