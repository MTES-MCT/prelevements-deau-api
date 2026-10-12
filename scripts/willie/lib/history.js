import {createHash} from 'node:crypto'

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(JSON.parse(JSON.stringify(value))))).digest('hex')
const assert = (condition, code) => { if (!condition) throw new Error(code) }
const unique = values => [...new Set(values)].sort()
const rows = async (client, sql, parameters = []) => (await client.query(sql, parameters)).rows
const rawRows = async (client, table, where, parameters) => (await rows(client,
  `SELECT to_jsonb(t) AS row FROM "${table}" t WHERE ${where} ORDER BY t.id`, parameters)).map(item => item.row)
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const stableId = key => {
  const hash = digest(`willie-history:${key}`)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

export function validateScope(scope) {
  const {scopeHash, ...payload} = scope ?? {}
  assert(scopeHash === digest(payload) && scope.version === 1 && scope.connector === 'willie'
    && Array.isArray(scope.entries) && scope.entries.length > 0 && scope.entries.length <= 100,
  'WILLIE_SCOPE_INVALID')
  assert(unique(scope.entries.map(row => row.connectorId)).length === scope.entries.length, 'WILLIE_SCOPE_DUPLICATE')
  for (const entry of scope.entries) {
    assert(['connectorId', 'exploitationId', 'preleveurId', 'pointId'].every(key => uuid.test(entry[key]))
      && typeof entry.sourcePointId === 'string' && entry.sourcePointId.trim() === entry.sourcePointId && entry.sourcePointId.length > 0
      && Number.isFinite(entry.rate) && entry.rate > 0 && entry.rate <= 100, 'WILLIE_SCOPE_ENTRY_INVALID')
  }
}

async function fingerprint(client, table, predicate, parameters) {
  const [result] = await rows(client, `SELECT count(*)::int AS count,
    md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY t.id),'')) AS hash FROM "${table}" t WHERE ${predicate}`, parameters)
  return result
}

export async function readHistoryState(client, scope) {
  validateScope(scope)
  const connectorIds = scope.entries.map(entry => entry.connectorId)
  const pointIds = unique(scope.entries.map(entry => entry.pointId))
  const ownerIds = unique(scope.entries.map(entry => entry.preleveurId))
  const connectors = await rows(client, `SELECT id,"declarantPointPrelevementId","connectorType",rate,
    "connectorParameters"->>'sourcePointId' AS "sourcePointId","connectorParameters"->>'stationId' AS "stationId",
    md5(to_jsonb(t)::text) AS hash FROM "DeclarantPointPrelevementConnector" t
    WHERE id=ANY($1::uuid[]) OR "declarantPointPrelevementId"=ANY($2::uuid[]) ORDER BY id`,
  [connectorIds, unique(scope.entries.map(entry => entry.exploitationId))])
  const exploitations = await rawRows(client, 'DeclarantPointPrelevement',
    't."pointPrelevementId"=ANY($1::uuid[]) AND t."declarantUserId"=ANY($2::uuid[])', [pointIds, ownerIds])
  const points = await rows(client, 'SELECT id,"deletedAt",md5(to_jsonb(t)::text) AS hash FROM "PointPrelevement" t WHERE id=ANY($1::uuid[]) ORDER BY id', [pointIds])
  const users = await rows(client, `SELECT u.id,u.role,u."deletedAt",d."declarantRole",md5(to_jsonb(u)::text) AS "userHash",
    md5(to_jsonb(d)::text) AS "declarantHash" FROM "User" u JOIN "Declarant" d ON d."userId"=u.id
    WHERE u.id=ANY($1::uuid[]) ORDER BY u.id`, [ownerIds])
  const sources = await rows(client, `SELECT s.id,s.type,s.status,s."globalInstructionStatus",
    s.metadata->>'connector' AS connector,s.metadata->>'connectorId' AS "connectorId",
    s.metadata->>'sourcePointId' AS "sourcePointId",s.metadata->>'connectorRate' AS rate,
    s.metadata->>'declarantId' AS "preleveurId",s.metadata->>'pointId' AS "pointId",
    md5(to_jsonb(s)::text) AS hash FROM "Source" s
    WHERE s.metadata->>'connectorId'=ANY($1::text[]) OR (s.metadata->>'connector'='willie'
      AND EXISTS(SELECT 1 FROM "Chunk" c WHERE c."sourceId"=s.id AND c."pointPrelevementId"=ANY($2::uuid[]))) ORDER BY s.id`, [connectorIds, pointIds])
  const sourceIds = sources.map(row => row.id)
  const chunks = await rawRows(client, 'Chunk', 't."sourceId"=ANY($1::uuid[])', [sourceIds])
  const chunkIds = chunks.map(row => row.id)
  const values = await fingerprint(client, 'ChunkValue',
    't."chunkId" IN (SELECT id FROM "Chunk" WHERE "pointPrelevementId"=ANY($1::uuid[])) OR t."chunkId"=ANY($2::uuid[])', [pointIds, chunkIds])
  const otherChunks = await fingerprint(client, 'Chunk', 't."pointPrelevementId"=ANY($1::uuid[]) AND NOT(t.id=ANY($2::uuid[]))', [pointIds, chunkIds])
  const replacements = await fingerprint(client, 'ChunkValueReplacement', 't."pointPrelevementId"=ANY($1::uuid[]) OR t."replacedChunkId"=ANY($2::uuid[]) OR t."replacementChunkId"=ANY($2::uuid[])', [pointIds, chunkIds])
  const identityLocks = (await rows(client, `SELECT to_jsonb(t) AS row FROM "ExploitationIdentityLock" t
    WHERE "pointPrelevementId"=ANY($1::uuid[]) AND "declarantUserId"=ANY($2::uuid[])
    ORDER BY "pointPrelevementId","declarantUserId"`, [pointIds, ownerIds])).map(row => row.row)
  return {connectors, exploitations, points, users, sources, chunks, values, otherChunks, replacements, identityLocks}
}

function checkIdentities(scope, state, block) {
  for (const entry of scope.entries) {
    const connector = state.connectors.find(row => row.id === entry.connectorId)
    const exploitation = state.exploitations.find(row => row.id === entry.exploitationId)
    const owner = state.users.find(row => row.id === entry.preleveurId)
    const point = state.points.find(row => row.id === entry.pointId)
    if (!connector || connector.connectorType !== 'willie' || connector.declarantPointPrelevementId !== entry.exploitationId
      || (connector.sourcePointId && connector.stationId && connector.sourcePointId !== connector.stationId)
      || String(connector.sourcePointId ?? connector.stationId) !== entry.sourcePointId || connector.rate !== entry.rate) {
      block('WILLIE_CONNECTOR_IDENTITY', {connectorId: entry.connectorId})
    }
    if (!exploitation || exploitation.declarantUserId !== entry.preleveurId || exploitation.pointPrelevementId !== entry.pointId) {
      block('WILLIE_EXPLOITATION_IDENTITY', {exploitationId: entry.exploitationId})
    }
    if (!owner || owner.deletedAt || owner.role !== 'DECLARANT' || owner.declarantRole !== 'PRELEVEUR'
      || !point || point.deletedAt) block('WILLIE_RESOURCE_INACTIVE', {connectorId: entry.connectorId})
  }
}

function checkSource(source, entry) {
  return source.type === 'API' && source.status === 'COMPLETED' && source.connector === 'willie'
    && source.sourcePointId === entry.sourcePointId && Number(source.rate) === entry.rate
    && (!source.preleveurId || source.preleveurId === entry.preleveurId) && (!source.pointId || source.pointId === entry.pointId)
}

function chunkIdentityMatches(chunk, entry) {
  return chunk.calculationStrategy === 'GENERIC' && chunk.compteurId === null
    && chunk.preleveurUserId === entry.preleveurId && chunk.pointPrelevementId === entry.pointId
    && chunk.submittedByDeclarantUserId === entry.preleveurId && chunk.collecteurUserId === null
    && chunk.metadata?.connector === 'willie' && chunk.metadata?.connectorId === entry.connectorId
    && Number(chunk.metadata?.connectorRate) === entry.rate
}

function resolveChunk(chunk, entry, state) {
  if (!chunkIdentityMatches(chunk, entry)) return 'WILLIE_CHUNK_IDENTITY'
  const candidates = state.exploitations.filter(exploitation => exploitation.declarantUserId === chunk.preleveurUserId
    && exploitation.pointPrelevementId === chunk.pointPrelevementId
    && (!exploitation.startDate || exploitation.startDate <= chunk.maxDate)
    && (!exploitation.endDate || exploitation.endDate >= chunk.minDate))
  if (candidates.length !== 1 || candidates[0].id !== entry.exploitationId) return 'WILLIE_EXPLOITATION_AMBIGUOUS'
  const exploitation = candidates[0]
  if (chunk.minDate > chunk.maxDate || (exploitation.startDate && exploitation.startDate > chunk.minDate)
    || (exploitation.endDate && exploitation.endDate < chunk.maxDate)) return 'WILLIE_PERIOD_NOT_CONTAINED'
  if (chunk.exploitationId !== null && chunk.exploitationId !== entry.exploitationId) return 'WILLIE_ALREADY_ASSIGNED_ELSEWHERE'
  return null
}

export async function reviewHistory(client, scope) {
  const before = await readHistoryState(client, scope)
  const blocked = []
  const block = (code, details = {}) => blocked.push({code, ...details})
  checkIdentities(scope, before, block)
  const sourceMap = new Map(before.sources.map(source => [source.id, source]))
  const entries = new Map(scope.entries.map(entry => [entry.connectorId, entry]))
  for (const source of before.sources) {
    const entry = entries.get(source.connectorId)
    if (!entry || !checkSource(source, entry)) block('WILLIE_SOURCE_IDENTITY', {sourceId: source.id})
  }
  const changes = []
  for (const chunk of before.chunks) {
    const source = sourceMap.get(chunk.sourceId)
    const entry = entries.get(source.connectorId)
    if (!entry || !checkSource(source, entry)) continue
    const reason = resolveChunk(chunk, entry, before)
    if (reason) block(reason, {chunkId: chunk.id})
    else if (chunk.exploitationId === null) changes.push({chunkId: chunk.id, exploitationId: entry.exploitationId,
      pointId: entry.pointId, preleveurId: entry.preleveurId, connectorId: entry.connectorId})
  }
  const stateHash = digest(before)
  const planHash = digest({scopeHash: scope.scopeHash, stateHash, changes})
  return {operation: 'willie-history', scopeHash: scope.scopeHash, complete: blocked.length === 0, blocked, before, stateHash, planHash, changes,
    summary: {connectors: scope.entries.length, points: unique(scope.entries.map(row => row.pointId)).length,
      chunks: before.chunks.length, changes: changes.length, changedPoints: unique(changes.map(row => row.pointId)).length,
      alreadyAssigned: before.chunks.filter(row => row.exploitationId !== null).length, values: before.values.count}}
}

async function assertTransaction(client) {
  const [transaction] = await rows(client, 'SELECT current_setting(\'transaction_isolation\') AS isolation,current_setting(\'transaction_read_only\') AS "readOnly",now() < statement_timestamp() AS explicit')
  assert(transaction.isolation === 'serializable' && transaction.readOnly === 'off' && transaction.explicit, 'WILLIE_SERIALIZABLE_REQUIRED')
}

// Acquire before BEGIN: a SERIALIZABLE snapshot taken before waiting for an
// ingestion lock could otherwise miss that ingestion's newly committed rows.
// The dedicated CLI connection releases these session locks when it closes.
export async function lockHistoryBeforeTransaction(client, scope) {
  validateScope(scope)
  for (const pointId of unique(scope.entries.map(row => row.pointId))) {
    await client.query('SELECT pg_advisory_lock(hashtext(\'volumes-from-index\'),hashtext($1))', [pointId])
  }
}

async function lockHistory(client, scope, review) {
  for (const pointId of unique(scope.entries.map(row => row.pointId))) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext(\'volumes-from-index\'),hashtext($1))', [pointId])
  }
  for (const [table, ids] of [
    ['PointPrelevement', scope.entries.map(row => row.pointId)], ['User', scope.entries.map(row => row.preleveurId)],
    ['DeclarantPointPrelevement', review.before.exploitations.map(row => row.id)],
    ['DeclarantPointPrelevementConnector', review.before.connectors.map(row => row.id)],
    ['Source', review.before.sources.map(row => row.id)], ['Chunk', review.before.chunks.map(row => row.id)]
  ]) await client.query(`SELECT id FROM "${table}" WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [unique(ids)])
  // Serializes concurrent exploitation creation as well as changes of identity.
  for (const row of review.before.identityLocks) await client.query(`SELECT revision FROM "ExploitationIdentityLock"
    WHERE "declarantUserId"=$1 AND "pointPrelevementId"=$2 FOR UPDATE`, [row.declarantUserId, row.pointPrelevementId])
  await client.query(`SELECT v.id FROM "ChunkValue" v JOIN "Chunk" c ON c.id=v."chunkId"
    WHERE c."pointPrelevementId"=ANY($1::uuid[]) ORDER BY v.id FOR SHARE OF v`, [unique(scope.entries.map(row => row.pointId))])
}

function expectedState(review, changes, restore = false) {
  const mappings = new Map(changes.map(change => [change.chunkId, restore ? null : change.exploitationId]))
  return {...review.before, chunks: review.before.chunks.map(chunk => mappings.has(chunk.id)
    ? {...chunk, exploitationId: mappings.get(chunk.id)} : chunk)}
}

async function auditHistory(client, scope, review, rollback = false) {
  if (!review.changes.length) return null
  const id = stableId(`${rollback ? 'rollback' : 'apply'}:${scope.scopeHash}:${review.planHash}`)
  await client.query(`INSERT INTO "AuditEvent" (id,"occurredAt","completedAt","updatedAt",outcome,"actionType","actionCategory","actorType",
    "actorLabel","targetType","targetId","requestId","httpMethod",route,"statusCode",metadata)
    VALUES ($1,now(),now(),now(),'SUCCESS',$2,'MAINTENANCE','ANONYMOUS','Maintenance historique Willie','IMPORT',$3,$4,'CLI',
      'scripts/willie/history',200,$5::jsonb)`, [id, rollback ? 'WILLIE.HISTORY_ROLLED_BACK' : 'WILLIE.HISTORY_LINKED', scope.scopeHash,
    `willie-history:${id}`, JSON.stringify({scopeHash: scope.scopeHash, planHash: review.planHash, changes: review.changes.length, maintenance: true})])
  for (const change of review.changes) {
    const mutationId = stableId(`${id}:${change.chunkId}`)
    const previous = {exploitationId: rollback ? change.exploitationId : null}
    const next = {exploitationId: rollback ? null : change.exploitationId}
    await client.query(`INSERT INTO "AuditMutation" (id,"auditEventId",operation,"entityType","entityId",before,after,"changedFields","redactedFields",metadata)
      VALUES ($1,$2,'UPDATE','Chunk',$3,$4::jsonb,$5::jsonb,ARRAY['exploitationId'],ARRAY[]::text[],$6::jsonb)`,
    [mutationId, id, change.chunkId, JSON.stringify(previous), JSON.stringify(next), JSON.stringify({scopeHash: scope.scopeHash, connectorId: change.connectorId})])
    for (const [resourceType, resourceId] of [['POINT_PRELEVEMENT', change.pointId], ['DECLARANT', change.preleveurId], ['EXPLOITATION', change.exploitationId]]) {
      await client.query('INSERT INTO "AuditMutationScope" (id,"auditMutationId","resourceType","resourceId") VALUES ($1,$2,$3,$4)',
        [stableId(`${mutationId}:${resourceType}`), mutationId, resourceType, resourceId])
    }
  }
  return id
}

async function mutate(client, scope, review, rollback = false) {
  await client.query('SAVEPOINT willie_history')
  try {
    for (const change of review.changes) {
      const result = await client.query('UPDATE "Chunk" SET "exploitationId"=$2 WHERE id=$1 AND "exploitationId" IS NOT DISTINCT FROM $3::uuid',
        [change.chunkId, rollback ? null : change.exploitationId, rollback ? change.exploitationId : null])
      assert(result.rowCount === 1, 'WILLIE_UNEXPECTED_DELTA')
    }
    const after = await reviewHistory(client, scope)
    const expected = rollback ? review.before : expectedState(review, review.changes)
    assert(after.stateHash === digest(expected), 'WILLIE_POSTCONDITION_FAILED')
    const auditEventId = await auditHistory(client, scope, review, rollback)
    await client.query('RELEASE SAVEPOINT willie_history')
    return {operation: rollback ? 'willie-history-rollback' : 'willie-history', ...(!rollback ? review : {}),
      applied: true, complete: true, restored: rollback, scopeHash: scope.scopeHash, auditEventId,
      summary: {...review.summary, changes: review.changes.length},
      verification: {ok: true, valuesUnchanged: true, outsideUnchanged: true, review: after}}
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT willie_history')
    await client.query('RELEASE SAVEPOINT willie_history')
    throw error
  }
}

export async function applyHistory(client, scope, expected) {
  await assertTransaction(client)
  assert(expected?.complete && expected.operation === 'willie-history' && expected.scopeHash === scope.scopeHash, 'WILLIE_REVIEW_REQUIRED')
  await lockHistory(client, scope, expected)
  const current = await reviewHistory(client, scope)
  assert(current.complete && current.stateHash === expected.stateHash && current.planHash === expected.planHash, 'WILLIE_STATE_CHANGED')
  return mutate(client, scope, current)
}

export async function rollbackHistory(client, scope, receipt) {
  await assertTransaction(client)
  assert(receipt?.status === 'COMMITTED' && receipt.applied === true && receipt.complete === true
    && receipt.operation === 'willie-history' && receipt.scopeHash === scope.scopeHash && receipt.verification?.ok === true,
  'WILLIE_COMMITTED_RECEIPT_REQUIRED')
  assert(receipt.stateHash === digest(receipt.before)
    && receipt.planHash === digest({scopeHash: receipt.scopeHash, stateHash: receipt.stateHash, changes: receipt.changes})
    && receipt.verification.review.stateHash === digest(expectedState(receipt, receipt.changes)), 'WILLIE_RECEIPT_INVALID')
  await lockHistory(client, scope, receipt.verification.review)
  const current = await reviewHistory(client, scope)
  if (current.stateHash === receipt.stateHash) {
    const id = stableId(`rollback:${scope.scopeHash}:${receipt.planHash}`)
    const evidence = await rows(client, 'SELECT id FROM "AuditEvent" WHERE id=$1 AND "actionType"=\'WILLIE.HISTORY_ROLLED_BACK\'', [id])
    assert(!receipt.changes.length || evidence.length === 1, 'WILLIE_ROLLBACK_EVIDENCE_REQUIRED')
    return {operation: 'willie-history-rollback', scopeHash: scope.scopeHash, applied: true, complete: true, restored: true,
      summary: {changes: 0}, verification: {ok: true, valuesUnchanged: true, outsideUnchanged: true, review: current}}
  }
  assert(current.stateHash === receipt.verification.review.stateHash, 'WILLIE_ROLLBACK_STATE_CHANGED')
  return mutate(client, scope, receipt, true)
}
