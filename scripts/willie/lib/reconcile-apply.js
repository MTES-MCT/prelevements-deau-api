import {check, digest, rows, unique, stableId, TABLES, writableTables, pointIds, ownerIds, normalizeRow,
  readReconcileState, reviewReconcile} from './reconcile.js'

const quote = name => `"${name.replaceAll('"', '""')}"`
const writable = () => new Set([...writableTables, 'declarants', 'summaries'])

async function assertTransaction(client) {
  const [result] = await rows(client, `SELECT current_setting('transaction_isolation') AS isolation,
    current_setting('transaction_read_only') AS readonly, now()<statement_timestamp() AS explicit`)
  check(result.isolation === 'serializable' && result.readonly === 'off' && result.explicit, 'SERIALIZABLE_REQUIRED')
}

async function lockState(client, manifest, state) {
  for (const id of pointIds(manifest)) await client.query("SELECT pg_advisory_xact_lock(hashtext('volumes-from-index'),hashtext($1))", [id])
  for (const name of ['points', 'users', 'declarants', 'exploitations', 'connectors', 'sources', 'chunks', 'values', 'replacements', 'summaries']) {
    const [table, key] = TABLES[name]
    const ids = state.tables[name].map(row => row[key])
    await client.query(`SELECT ${quote(key)} FROM ${quote(table)} WHERE ${quote(key)}=ANY($1::uuid[]) ORDER BY ${quote(key)} FOR UPDATE`, [ids])
  }
  for (const row of state.tables.identityLocks) await client.query(`SELECT revision FROM "ExploitationIdentityLock"
    WHERE "declarantUserId"=$1 AND "pointPrelevementId"=$2 FOR UPDATE`, [row.declarantUserId, row.pointPrelevementId])
}

async function writeChange(client, change) {
  check(writable().has(change.table), 'TABLE_NOT_WRITABLE')
  const [table, key] = TABLES[change.table]
  let result
  if (!change.after) {
    result = await client.query(`DELETE FROM ${quote(table)} WHERE ${quote(key)}=$1::uuid`, [change.key])
  } else {
    const {__jsonNullFields = [], ...record} = change.after
    check(__jsonNullFields.every(field => change.table === 'sources' && field === 'metadata'), 'JSON_NULL_MARKER_INVALID')
    const columns = Object.keys(record)
    const expression = column => __jsonNullFields.includes(column) ? "'null'::json" : `r.${quote(column)}`
    if (change.before) {
      const mutable = columns.filter(column => column !== key && (digest(change.before[column] ?? null) !== digest(record[column] ?? null)
        || (__jsonNullFields.includes(column) !== (change.before.__jsonNullFields ?? []).includes(column))))
      if (!mutable.length) return
      result = await client.query(`UPDATE ${quote(table)} t SET ${mutable.map(column => `${quote(column)}=${expression(column)}`).join(',')}
        FROM jsonb_populate_record(NULL::${quote(table)},$1::jsonb) r WHERE t.${quote(key)}=$2::uuid`, [JSON.stringify(record), change.key])
    } else {
      result = await client.query(`INSERT INTO ${quote(table)} (${columns.map(quote).join(',')})
        SELECT ${columns.map(expression).join(',')} FROM jsonb_populate_record(NULL::${quote(table)},$1::jsonb) r`, [JSON.stringify(record)])
    }
  }
  check(result.rowCount === 1, 'UNEXPECTED_DELTA')
}

function orderedChanges(changes) {
  const insertOrder = ['sources', 'exploitations', 'connectors', 'chunks', 'replacements', 'values', 'declarants', 'summaries']
  const deleteOrder = ['values', 'summaries', 'replacements', 'chunks', 'connectors', 'sources', 'exploitations']
  return [...changes.filter(row => !row.after).sort((a, b) => deleteOrder.indexOf(a.table) - deleteOrder.indexOf(b.table)),
    ...changes.filter(row => row.after).sort((a, b) => insertOrder.indexOf(a.table) - insertOrder.indexOf(b.table))]
}

async function writeChanges(client, changes) {
  const detached = new Set()
  for (const change of changes.filter(row => row.table === 'exploitations' && row.before && row.after
    && (row.before.declarantUserId !== row.after.declarantUserId || row.before.pointPrelevementId !== row.after.pointPrelevementId))) {
    const linked = await rows(client, 'SELECT id FROM "Chunk" WHERE "exploitationId"=$1 ORDER BY id FOR UPDATE', [change.key])
    for (const row of linked) check(changes.some(item => item.table === 'chunks' && item.key === row.id), 'TRANSFER_DETACH_SCOPE')
    await client.query('UPDATE "Chunk" SET "exploitationId"=NULL WHERE "exploitationId"=$1', [change.key])
    for (const row of linked) detached.add(row.id)
  }
  for (const change of orderedChanges(changes)) {
    await writeChange(client, change.table === 'chunks' && detached.has(change.key) && change.before
      ? {...change, before: {...change.before, exploitationId: null}} : change)
  }
}

async function restoreIdentityLocks(client, state) {
  const points = unique(state.tables.points.map(row => row.id))
  await client.query('DELETE FROM "ExploitationIdentityLock" WHERE "pointPrelevementId"=ANY($1::uuid[])', [points])
  for (const row of state.tables.identityLocks) await client.query(`INSERT INTO "ExploitationIdentityLock"
    ("declarantUserId","pointPrelevementId",revision) VALUES ($1,$2,$3)`, [row.declarantUserId, row.pointPrelevementId, row.revision])
}

async function refreshDerived(client, manifest, plan) {
  if (!plan.changes.length) return
  await client.query('SELECT refresh_chunk_value_summaries($1::uuid[])', [plan.touchedChunks])
  // Only changed chunks are rewritten. A source may span hundreds of other points.
  await client.query(`WITH totals AS (
    SELECT c.id,coalesce(sum(v.value) FILTER(WHERE v."metricTypeCode" IN ('volume','volume_preleve','volume_rejete')),0) AS total,
      coalesce(sum(v.value) FILTER(WHERE v."metricTypeCode" IN ('volume','volume_preleve','volume_rejete')
        AND coalesce(c."flowType",p."flowType",'PRELEVEMENT')='PRELEVEMENT'),0) AS withdrawn,
      coalesce(sum(v.value) FILTER(WHERE v."metricTypeCode" IN ('volume','volume_preleve','volume_rejete')
        AND coalesce(c."flowType",p."flowType",'PRELEVEMENT')='REJET'),0) AS discharged
    FROM "Chunk" c LEFT JOIN "PointPrelevement" p ON p.id=c."pointPrelevementId"
    LEFT JOIN "ChunkValue" v ON v."chunkId"=c.id WHERE c.id=ANY($1::uuid[]) GROUP BY c.id)
    UPDATE "Chunk" c SET metadata=c.metadata::jsonb||jsonb_build_object('totalWaterVolume',t.total,
      'totalWaterVolumeWithdrawn',t.withdrawn,'totalWaterVolumeDischarged',t.discharged)
    FROM totals t WHERE c.id=t.id`, [plan.touchedChunks])
  await client.query(`WITH totals AS (
    SELECT s.id,coalesce(sum(v.value) FILTER(WHERE c."instructionStatus"<>'REJECTED'
      AND v."metricTypeCode" IN ('volume','volume_preleve','volume_rejete')
      AND coalesce(c."flowType",p."flowType",'PRELEVEMENT')='PRELEVEMENT'),0) AS withdrawn,
      coalesce(sum(v.value) FILTER(WHERE c."instructionStatus"<>'REJECTED'
      AND v."metricTypeCode" IN ('volume','volume_preleve','volume_rejete')
      AND coalesce(c."flowType",p."flowType",'PRELEVEMENT')='REJET'),0) AS discharged
    FROM "Source" s LEFT JOIN "Chunk" c ON c."sourceId"=s.id LEFT JOIN "PointPrelevement" p ON p.id=c."pointPrelevementId"
    LEFT JOIN "ChunkValue" v ON v."chunkId"=c.id WHERE s.id=ANY($1::uuid[]) GROUP BY s.id),
    statuses AS (SELECT "sourceId", CASE
      WHEN bool_and("instructionStatus"='PENDING') THEN 'TO_INSTRUCT'
      WHEN bool_and("instructionStatus"='VALIDATED') THEN 'VALIDATED'
      WHEN bool_and("instructionStatus"='REJECTED') THEN 'REJECTED'
      WHEN bool_or("instructionStatus"='PENDING') THEN 'INSTRUCTION_IN_PROGRESS'
      ELSE 'PARTIALLY_VALIDATED' END AS status FROM "Chunk" WHERE "sourceId"=ANY($1::uuid[]) GROUP BY "sourceId")
    UPDATE "Source" s SET metadata=(CASE WHEN jsonb_typeof(s.metadata::jsonb)='object' THEN s.metadata::jsonb ELSE '{}'::jsonb END)
      ||jsonb_build_object('totalWaterVolumeWithdrawn',t.withdrawn,'totalWaterVolumeDischarged',t.discharged),
      "globalInstructionStatus"=coalesce(statuses.status,'TO_INSTRUCT')::"GlobalInstructionStatus"
    FROM totals t LEFT JOIN statuses ON statuses."sourceId"=t.id WHERE s.id=t.id`, [plan.touchedSources])
  const exploitationIds = unique([...manifest.entries, ...manifest.retireConnectors].map(row => row.exploitationId))
  await client.query(`UPDATE "DeclarantPointPrelevement" e SET "mostRecentAvailableDate"=(
    SELECT max(v."periodEnd") FROM "Chunk" c JOIN "Source" s ON s.id=c."sourceId" JOIN "ChunkValue" v ON v."chunkId"=c.id
    WHERE s.status='COMPLETED' AND c."instructionStatus"<>'REJECTED'
      AND (c."exploitationId"=e.id OR (c."exploitationId" IS NULL AND c."pointPrelevementId"=e."pointPrelevementId"
      AND c."preleveurUserId"=e."declarantUserId"))) WHERE e.id=ANY($1::uuid[])`, [exploitationIds])
  // Same activity definition as models/declarant.js, scoped to old/new beneficiaries.
  await client.query(`UPDATE "Declarant" d SET "lastDeclarationAt"=(
    SELECT max(CASE WHEN s.type='DECLARATION' THEN declaration."createdAt" ELSE s."createdAt" END)
    FROM "Source" s LEFT JOIN "Declaration" declaration ON declaration.id=s."declarationId"
    WHERE s.type IN ('DECLARATION','API') AND s.status='COMPLETED' AND (
      EXISTS(SELECT 1 FROM "Chunk" c WHERE c."sourceId"=s.id AND c."instructionStatus"<>'REJECTED'
        AND (c."preleveurUserId"=d."userId" OR c."submittedByDeclarantUserId"=d."userId" OR c."collecteurUserId"=d."userId"))
      OR ((declaration."declarantUserId"=d."userId" OR declaration."createdByDeclarantUserId"=d."userId")
        AND EXISTS(SELECT 1 FROM "Chunk" c WHERE c."sourceId"=s.id AND c."instructionStatus"<>'REJECTED'))
    )) WHERE d."userId"=ANY($1::uuid[])`, [ownerIds(manifest)])
}

function comparableState(state, plan, manifest) {
  const result = structuredClone(state)
  const chunkIds = new Set(plan.touchedChunks)
  const sourceIds = new Set(plan.touchedSources)
  const exploitationIds = new Set([...manifest.entries, ...manifest.retireConnectors].map(row => row.exploitationId))
  for (const row of result.tables.chunks) if (chunkIds.has(row.id)) {
    for (const key of ['totalWaterVolume', 'totalWaterVolumeWithdrawn', 'totalWaterVolumeDischarged']) delete row.metadata[key]
  }
  for (const row of result.tables.sources) if (sourceIds.has(row.id)) {
    if (!row.metadata || typeof row.metadata !== 'object') row.metadata = {}
    if (row.metadata && typeof row.metadata === 'object') {
      delete row.metadata.totalWaterVolumeWithdrawn; delete row.metadata.totalWaterVolumeDischarged
    }
    delete row.globalInstructionStatus
    delete row.__jsonNullFields
  }
  for (const row of result.tables.exploitations) if (exploitationIds.has(row.id)) delete row.mostRecentAvailableDate
  for (const row of result.tables.declarants) delete row.lastDeclarationAt
  result.tables.summaries = result.tables.summaries.filter(row => !chunkIds.has(row.chunkId))
  for (const [name, list] of Object.entries(result.tables)) {
    const [, key] = TABLES[name]
    if (key) list.sort((a, b) => String(a[key]).localeCompare(String(b[key]), 'en'))
  }
  return result
}

function expectedState(review) {
  const expected = structuredClone(review.before)
  for (const change of review.changes) {
    const [, key] = TABLES[change.table]
    expected.tables[change.table] = expected.tables[change.table].filter(row => row[key] !== change.key)
    if (change.after) expected.tables[change.table].push(change.after)
    if (change.table === 'exploitations' && change.after && (!change.before
      || ['declarantUserId', 'pointPrelevementId', 'countingCode', 'status', 'startDate', 'endDate']
        .some(key => digest(change.before[key] ?? null) !== digest(change.after[key] ?? null)))) {
      const row = expected.tables.identityLocks.find(item => item.declarantUserId === change.after.declarantUserId
        && item.pointPrelevementId === change.after.pointPrelevementId)
      if (row) row.revision = Number(row.revision) + 1
      else expected.tables.identityLocks.push({declarantUserId: change.after.declarantUserId,
        pointPrelevementId: change.after.pointPrelevementId, revision: 1})
    }
  }
  expected.tables.identityLocks.sort((a, b) => a.declarantUserId.localeCompare(b.declarantUserId, 'en')
    || a.pointPrelevementId.localeCompare(b.pointPrelevementId, 'en'))
  return expected
}

async function audit(client, manifest, plan, rollback = false) {
  if (!plan.changes.length) return null
  const id = stableId(`${rollback ? 'rollback' : 'apply'}:${manifest.manifestHash}:${plan.planHash}`)
  await client.query(`INSERT INTO "AuditEvent" (id,"occurredAt","completedAt","updatedAt",outcome,"actionType","actionCategory","actorType",
    "actorLabel","targetType","targetId","requestId","httpMethod",route,"statusCode",metadata)
    VALUES ($1,now(),now(),now(),'SUCCESS',$2,'MAINTENANCE','ANONYMOUS','Maintenance raccordements Willie','IMPORT',$3,$4,'CLI',
      'scripts/willie/reconcile',200,$5::jsonb)`, [id, rollback ? 'WILLIE.RECONCILIATION_ROLLED_BACK' : 'WILLIE.RECONCILED',
    manifest.manifestHash, `willie-reconcile:${id}`, JSON.stringify({manifestHash: manifest.manifestHash,
      payloadHash: manifest.payloadHash, planHash: plan.planHash, ...plan.summary, maintenance: true})])
  for (const change of plan.changes.filter(row => ['exploitations', 'connectors', 'chunks'].includes(row.table))) {
    const mutationId = stableId(`${id}:${change.table}:${change.key}`)
    const [table] = TABLES[change.table]
    const before = rollback ? change.after : change.before
    const after = rollback ? change.before : change.after
    const changedFields = unique([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]).filter(key => digest(before?.[key] ?? null) !== digest(after?.[key] ?? null))
    await client.query(`INSERT INTO "AuditMutation" (id,"auditEventId",operation,"entityType","entityId",before,after,"changedFields","redactedFields",metadata)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::text[],ARRAY[]::text[],$9::jsonb)`, [mutationId, id,
      !before ? 'CREATE' : !after ? 'DELETE' : 'UPDATE', table, change.key, before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null, changedFields, JSON.stringify({manifestHash: manifest.manifestHash})])
    const binding = [...manifest.entries, ...manifest.retireConnectors].find(row =>
      row.connectorId === change.key || row.exploitationId === change.key || row.exploitationId === (after ?? before)?.exploitationId)
    const chunk = change.table === 'chunks' ? (after ?? before) : null
    const scopes = [['POINT_PRELEVEMENT', binding?.pointId ?? chunk?.pointPrelevementId],
      ['DECLARANT', binding?.preleveurId ?? chunk?.preleveurUserId], ['EXPLOITATION', binding?.exploitationId ?? chunk?.exploitationId]]
    for (const [resourceType, resourceId] of scopes) if (resourceId) await client.query(`INSERT INTO "AuditMutationScope"
      (id,"auditMutationId","resourceType","resourceId") VALUES ($1,$2,$3,$4)`, [stableId(`${mutationId}:${resourceType}`), mutationId, resourceType, resourceId])
  }
  return id
}

export async function applyReconcile(client, manifest, payload, expected) {
  await assertTransaction(client)
  check(expected?.complete && expected.operation === 'willie-reconcile' && expected.manifestHash === manifest.manifestHash
    && expected.payloadHash === payload.payloadHash && expected.stateHash === digest(expected.before), 'REVIEW_REQUIRED')
  await lockState(client, manifest, expected.before)
  const current = await reviewReconcile(client, manifest, payload)
  check(current.complete && current.stateHash === expected.stateHash && current.planHash === expected.planHash, 'STATE_CHANGED')
  await client.query('SAVEPOINT willie_reconcile')
  try {
    await writeChanges(client, current.changes)
    await refreshDerived(client, manifest, current)
    const verification = await reviewReconcile(client, manifest, payload)
    check(verification.complete && verification.changes.length === 0, 'REPLAY_NOT_EMPTY')
    check(digest(comparableState(verification.before, current, manifest)) === digest(comparableState(expectedState(current), current, manifest)), 'OUTSIDE_CHANGED')
    const auditEventId = await audit(client, manifest, current)
    await client.query('RELEASE SAVEPOINT willie_reconcile')
    return {...current, applied: true, complete: true, after: verification.before, afterHash: verification.stateHash,
      auditEventId, verification: {ok: true, replayChanges: 0, outsideUnchanged: true}}
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT willie_reconcile')
    await client.query('RELEASE SAVEPOINT willie_reconcile')
    throw error
  }
}

export async function rollbackReconcile(client, manifest, payload, receipt) {
  await assertTransaction(client)
  check(receipt?.status === 'COMMITTED' && receipt.operation === 'willie-reconcile' && receipt.applied && receipt.complete
    && receipt.manifestHash === manifest.manifestHash && receipt.payloadHash === payload.payloadHash
    && receipt.stateHash === digest(receipt.before) && receipt.afterHash === digest(receipt.after), 'COMMITTED_RECEIPT_REQUIRED')
  await lockState(client, manifest, receipt.after)
  const current = await readReconcileState(client, manifest)
  const auditId = stableId(`rollback:${manifest.manifestHash}:${receipt.planHash}`)
  if (digest(current) === receipt.stateHash) {
    const evidence = await rows(client, 'SELECT id FROM "AuditEvent" WHERE id=$1', [auditId])
    check(!receipt.changes.length || evidence.length === 1, 'ROLLBACK_EVIDENCE_REQUIRED')
    return {operation: 'willie-reconcile-rollback', applied: true, complete: true, summary: {changes: 0}, verification: {ok: true}}
  }
  check(digest(current) === receipt.afterHash, 'ROLLBACK_STATE_CHANGED')
  const changes = []
  for (const table of writable()) {
    const [, key] = TABLES[table]
    const before = new Map(current.tables[table].map(row => [row[key], row]))
    const after = new Map(receipt.before.tables[table].map(row => [row[key], row]))
    for (const id of unique([...before.keys(), ...after.keys()])) {
      if (digest(before.get(id) ?? null) !== digest(after.get(id) ?? null)) changes.push({table, key: id, before: before.get(id) ?? null, after: after.get(id) ?? null})
    }
  }
  await client.query('SAVEPOINT willie_reconcile_rollback')
  try {
    // Restore summaries last: value triggers invalidate them during restoration.
    await writeChanges(client, changes.filter(row => row.table !== 'summaries'))
    await restoreIdentityLocks(client, receipt.before)
    const summaries = (await rows(client, 'SELECT to_jsonb(s) AS row FROM "ChunkValueSummary" s WHERE "chunkId"=ANY($1::uuid[])',
      [receipt.before.tables.chunks.map(row => row.id)])).map(row => normalizeRow(row.row))
    const present = new Map(summaries.map(row => [row.chunkId, row]))
    for (const row of receipt.before.tables.summaries) await writeChange(client, {table: 'summaries', key: row.chunkId, before: present.get(row.chunkId) ?? null, after: row})
    const originalSummaries = new Set(receipt.before.tables.summaries.map(row => row.chunkId))
    for (const row of summaries) if (!originalSummaries.has(row.chunkId)) await writeChange(client, {table: 'summaries', key: row.chunkId, before: row, after: null})
    const restored = await readReconcileState(client, manifest)
    check(digest(restored) === receipt.stateHash, 'ROLLBACK_POSTCONDITION_FAILED')
    const auditEventId = await audit(client, manifest, receipt, true)
    await client.query('RELEASE SAVEPOINT willie_reconcile_rollback')
    return {operation: 'willie-reconcile-rollback', applied: true, complete: true, manifestHash: manifest.manifestHash,
      auditEventId, summary: {changes: changes.length}, verification: {ok: true, restoredHash: digest(restored)}}
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT willie_reconcile_rollback')
    await client.query('RELEASE SAVEPOINT willie_reconcile_rollback')
    throw error
  }
}
