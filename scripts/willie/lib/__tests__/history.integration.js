import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {digest, reviewHistory, applyHistory, rollbackHistory, lockHistoryBeforeTransaction} from '../history.js'
import {requireDisposableDatabase} from '../../../../lib/util/test-helpers/disposable-database.js'

const enabled = process.env.DROPT_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
let client
test.before(async () => {
  if (!enabled) return
  requireDisposableDatabase()
  client = new pg.Client({connectionString: process.env.DATABASE_URL})
  await client.connect()
})
test.beforeEach(async () => { if (enabled) await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE') })
test.afterEach.always(async () => { if (enabled) await client.query('ROLLBACK') })
test.after.always(async () => { if (client) await client.end() })

async function fixture() {
  const ids = Object.fromEntries(['user', 'point', 'exploitation', 'connector', 'usage', 'oldSource', 'newSource', 'otherSource', 'oldChunk', 'newChunk', 'otherChunk'].map(key => [key, randomUUID()]))
  await client.query('INSERT INTO "User" (id,role,"updatedAt") VALUES ($1,\'DECLARANT\',now())', [ids.user])
  await client.query('INSERT INTO "Declarant" ("userId","preleveurType") VALUES ($1,\'IRRIGANT\')', [ids.user])
  await client.query('INSERT INTO "PointPrelevement" (id,name,"waterBodyType","flowType","updatedAt") VALUES ($1,$2,\'SOUTERRAIN\',\'PRELEVEMENT\',now())', [ids.point, `Synthetic Willie ${ids.point}`])
  await client.query('INSERT INTO "SandreWaterUse" (id,code,kind,label,"updatedAt") VALUES ($1,$2,\'USAGE\',\'Synthétique\',now())', [ids.usage, `test-${ids.usage.slice(0, 8)}`])
  await client.query('INSERT INTO "DeclarantPointPrelevement" (id,"declarantUserId","pointPrelevementId","usageId",status,"updatedAt") VALUES ($1,$2,$3,$4,\'EN_ACTIVITE\',now())', [ids.exploitation, ids.user, ids.point, ids.usage])
  await client.query('INSERT INTO "DeclarantPointPrelevementConnector" (id,"declarantPointPrelevementId","connectorType","connectorParameters",rate,"updatedAt") VALUES ($1,$2,\'willie\',$3,100,now())', [ids.connector, ids.exploitation, JSON.stringify({sourcePointId: 'synthetic-station'})])
  const metadata = {connector: 'willie', connectorId: ids.connector, connectorRate: 100, sourcePointId: 'synthetic-station', pointId: ids.point, declarantId: ids.user}
  for (const [sourceId, chunkId, exploitationId, provider] of [[ids.oldSource, ids.oldChunk, null, 'willie'],
    [ids.newSource, ids.newChunk, ids.exploitation, 'willie'], [ids.otherSource, ids.otherChunk, null, 'other']]) {
    await client.query('INSERT INTO "Source" (id,type,status,metadata,"updatedAt") VALUES ($1,\'API\',\'COMPLETED\',$2,now())',
      [sourceId, JSON.stringify(provider === 'willie' ? metadata : {connector: 'other'})])
    await client.query(`INSERT INTO "Chunk" (id,"sourceId","pointPrelevementId","preleveurUserId","submittedByDeclarantUserId","exploitationId","usageId",
      "instructionStatus","minDate","maxDate",metadata,"updatedAt") VALUES ($1,$2,$3,$4,$4,$5,$6,'VALIDATED','2026-01-01','2026-01-02',$7,now())`,
    [chunkId, sourceId, ids.point, ids.user, exploitationId, ids.usage, JSON.stringify(provider === 'willie' ? metadata : {connector: 'other'})])
    await client.query(`INSERT INTO "ChunkValue" (id,"chunkId","metricTypeCode",unit,frequency,"periodStart","periodEnd",value,"updatedAt")
      VALUES ($1,$2,'volume','m³','1 day','2026-01-01','2026-01-02',42.1234,now())`, [randomUUID(), chunkId])
  }
  const payload = {version: 1, connector: 'willie', entries: [{connectorId: ids.connector, exploitationId: ids.exploitation,
    preleveurId: ids.user, pointId: ids.point, sourcePointId: 'synthetic-station', rate: 100}]}
  return {...ids, scope: {...payload, scopeHash: digest(payload)}}
}

async function appliedFixture() {
  const f = await fixture()
  const before = await reviewHistory(client, f.scope)
  const receipt = JSON.parse(JSON.stringify({...await applyHistory(client, f.scope, before), status: 'COMMITTED'}))
  return {...f, before, receipt}
}

integration('Willie rattache seulement NULL, conserve toutes valeurs et autres sources, puis rejoue zéro', async t => {
  const f = await fixture()
  const before = await reviewHistory(client, f.scope)
  t.true(before.complete)
  t.is(before.changes.length, 1)
  const result = await applyHistory(client, f.scope, before)
  t.true(result.verification.ok)
  t.is(result.verification.review.changes.length, 0)
  t.deepEqual(result.verification.review.before.values, before.before.values)
  t.deepEqual(result.verification.review.before.otherChunks, before.before.otherChunks)
  const original = before.before.chunks.find(row => row.id === f.oldChunk)
  t.deepEqual(result.verification.review.before.chunks.find(row => row.id === f.oldChunk), {...original, exploitationId: f.exploitation})
  const replay = await applyHistory(client, f.scope, result.verification.review)
  t.is(replay.summary.changes, 0)
  t.is(replay.auditEventId, null)
  t.is((await client.query('SELECT count(*)::int AS n FROM "AuditEvent" WHERE metadata->>\'scopeHash\'=$1', [f.scope.scopeHash])).rows[0].n, 1)
  t.is((await client.query('SELECT count(*)::int AS n FROM "AuditMutationScope" WHERE "auditMutationId" IN (SELECT id FROM "AuditMutation" WHERE "auditEventId"=$1)', [result.auditEventId])).rows[0].n, 3)
})

integration('Willie refuse source, connecteur, préleveur ou PP incohérent sans mutation', async t => {
  const f = await fixture()
  for (const [sql, parameters, expected] of [
    ['UPDATE "Source" SET metadata=metadata||\'{"connector":"other"}\'::jsonb WHERE id=$1', [f.oldSource], 'WILLIE_SOURCE_IDENTITY'],
    ['UPDATE "Source" SET status=\'PENDING\' WHERE id=$1', [f.oldSource], 'WILLIE_SOURCE_IDENTITY'],
    ['UPDATE "DeclarantPointPrelevementConnector" SET rate=50 WHERE id=$1', [f.connector], 'WILLIE_CONNECTOR_IDENTITY'],
    ['UPDATE "Chunk" SET "preleveurUserId"=NULL WHERE id=$1', [f.oldChunk], 'WILLIE_CHUNK_IDENTITY'],
    ['UPDATE "Chunk" SET metadata=metadata||\'{"connectorId":"00000000-0000-4000-8000-000000000000"}\'::jsonb WHERE id=$1', [f.oldChunk], 'WILLIE_CHUNK_IDENTITY'],
    ['UPDATE "PointPrelevement" SET "deletedAt"=now() WHERE id=$1', [f.point], 'WILLIE_RESOURCE_INACTIVE']
  ]) {
    await client.query('SAVEPOINT mismatch')
    await client.query(sql, parameters)
    const review = await reviewHistory(client, f.scope)
    t.false(review.complete)
    t.true(review.blocked.some(row => row.code === expected))
    await t.throwsAsync(applyHistory(client, f.scope, review), {message: 'WILLIE_REVIEW_REQUIRED'})
    await client.query('ROLLBACK TO SAVEPOINT mismatch')
    await client.query('RELEASE SAVEPOINT mismatch')
  }
})

integration('Willie refuse METER et périodes incompatibles ou exploitations ambiguës', async t => {
  const f = await fixture()
  for (const [sql, parameters, code] of [
    ['UPDATE "Chunk" SET "calculationStrategy"=\'METER\' WHERE id=$1', [f.oldChunk], 'WILLIE_CHUNK_IDENTITY'],
    ['UPDATE "DeclarantPointPrelevement" SET "startDate"=\'2026-01-02\' WHERE id=$1', [f.exploitation], 'WILLIE_PERIOD_NOT_CONTAINED'],
    ['INSERT INTO "DeclarantPointPrelevement" (id,"declarantUserId","pointPrelevementId","usageId",status,"updatedAt") VALUES ($1,$2,$3,$4,\'ABANDONNEE\',now())', [randomUUID(), f.user, f.point, f.usage], 'WILLIE_EXPLOITATION_AMBIGUOUS']
  ]) {
    await client.query('SAVEPOINT incompatible')
    await client.query(sql, parameters)
    const review = await reviewHistory(client, f.scope)
    t.false(review.complete)
    t.true(review.blocked.some(row => row.code === code))
    await client.query('ROLLBACK TO SAVEPOINT incompatible')
    await client.query('RELEASE SAVEPOINT incompatible')
  }
})

integration('Willie refuse toute dérive depuis la revue, y compris valeurs ou source étrangère', async t => {
  const f = await fixture()
  const original = await reviewHistory(client, f.scope)
  for (const [sql, parameters] of [
    ['UPDATE "ChunkValue" SET value=value+1 WHERE "chunkId"=$1', [f.oldChunk]],
    ['UPDATE "Chunk" SET metadata=\'{"external":true}\' WHERE id=$1', [f.otherChunk]],
    ['UPDATE "Source" SET metadata=metadata||\'{"other":true}\'::jsonb WHERE id=$1', [f.oldSource]]
  ]) {
    await client.query('SAVEPOINT stale')
    await client.query(sql, parameters)
    const changed = await reviewHistory(client, f.scope)
    await t.throwsAsync(applyHistory(client, f.scope, original), {message: 'WILLIE_STATE_CHANGED'})
    t.is((await reviewHistory(client, f.scope)).stateHash, changed.stateHash)
    await client.query('ROLLBACK TO SAVEPOINT stale')
    await client.query('RELEASE SAVEPOINT stale')
  }
})

integration('Willie rollback exact garde les audits et accepte son propre rejeu à zéro', async t => {
  const f = await appliedFixture()
  const result = await rollbackHistory(client, f.scope, f.receipt)
  t.true(result.restored)
  t.is(result.verification.review.stateHash, f.before.stateHash)
  t.is((await client.query('SELECT count(*)::int AS n FROM "AuditEvent" WHERE id=$1', [f.receipt.auditEventId])).rows[0].n, 1)
  const replay = await rollbackHistory(client, f.scope, f.receipt)
  t.is(replay.summary.changes, 0)
  t.is((await reviewHistory(client, f.scope)).stateHash, f.before.stateHash)
})

integration('Willie rollback refuse reçu non committé, modifié et données modifiées depuis application', async t => {
  const f = await appliedFixture()
  await t.throwsAsync(rollbackHistory(client, f.scope, {...f.receipt, status: 'PREPARED'}), {message: 'WILLIE_COMMITTED_RECEIPT_REQUIRED'})
  await t.throwsAsync(rollbackHistory(client, f.scope, {...f.receipt, changes: []}), {message: 'WILLIE_RECEIPT_INVALID'})
  await client.query('UPDATE "ChunkValue" SET value=value+1 WHERE "chunkId"=$1', [f.oldChunk])
  const state = await reviewHistory(client, f.scope)
  await t.throwsAsync(rollbackHistory(client, f.scope, f.receipt), {message: 'WILLIE_ROLLBACK_STATE_CHANGED'})
  t.is((await reviewHistory(client, f.scope)).stateHash, state.stateHash)
})

integration('Willie toute erreur SQL annule mutations et audits même si le caller continue', async t => {
  const f = await fixture()
  const before = await reviewHistory(client, f.scope)
  const failing = {query: (sql, parameters) => sql.startsWith('INSERT INTO "AuditMutationScope"') ? client.query('SELECT 1/0') : client.query(sql, parameters)}
  await t.throwsAsync(applyHistory(failing, f.scope, before), {code: '22012'})
  t.is((await reviewHistory(client, f.scope)).stateHash, before.stateHash)
  t.is((await client.query('SELECT count(*)::int AS n FROM "AuditEvent" WHERE metadata->>\'scopeHash\'=$1', [f.scope.scopeHash])).rows[0].n, 0)
})

integration('Willie review fonctionne en transaction lecture seule et apply exige SERIALIZABLE RW', async t => {
  const f = await fixture()
  await client.query('ROLLBACK')
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const review = await reviewHistory(client, f.scope)
  t.false(review.complete)
  await t.throwsAsync(applyHistory(client, f.scope, review), {message: 'WILLIE_SERIALIZABLE_REQUIRED'})
})

integration('Willie verrou avant BEGIN attend ingestion concurrente et refuse sa vieille simulation', async t => {
  const f = await fixture()
  const original = await reviewHistory(client, f.scope)
  await client.query('COMMIT')
  const writer = new pg.Client({connectionString: process.env.DATABASE_URL})
  let acquired
  try {
    await writer.connect()
    await writer.query('BEGIN')
    await writer.query('SELECT pg_advisory_xact_lock(hashtext(\'volumes-from-index\'),hashtext($1))', [f.point])
    let locked = false
    acquired = lockHistoryBeforeTransaction(client, f.scope).then(() => { locked = true })
    await new Promise(resolve => setTimeout(resolve, 40))
    t.false(locked)
    await writer.query(`INSERT INTO "ChunkValue" (id,"chunkId","metricTypeCode",unit,frequency,"periodStart","periodEnd",value,"updatedAt")
      VALUES ($1,$2,'volume','m³','1 day','2026-01-01','2026-01-02',10,now())`, [randomUUID(), f.oldChunk])
    await writer.query('COMMIT')
    await acquired
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    const current = await reviewHistory(client, f.scope)
    t.is(current.before.values.count, original.before.values.count + 1)
    await t.throwsAsync(applyHistory(client, f.scope, original), {message: 'WILLIE_STATE_CHANGED'})
    t.is((await reviewHistory(client, f.scope)).changes.length, 1)
  } finally {
    await writer.query('ROLLBACK').catch(() => {})
    await writer.end()
    await acquired
    await client.query('ROLLBACK')
    await client.query('SELECT pg_advisory_unlock(hashtext(\'volumes-from-index\'),hashtext($1))', [f.point])
    await client.query('BEGIN')
    await client.query('DELETE FROM "ChunkValue" WHERE "chunkId"=ANY($1::uuid[])', [[f.oldChunk, f.newChunk, f.otherChunk]])
    await client.query('DELETE FROM "Chunk" WHERE id=ANY($1::uuid[])', [[f.oldChunk, f.newChunk, f.otherChunk]])
    await client.query('DELETE FROM "Source" WHERE id=ANY($1::uuid[])', [[f.oldSource, f.newSource, f.otherSource]])
    await client.query('DELETE FROM "DeclarantPointPrelevementConnector" WHERE id=$1', [f.connector])
    await client.query('DELETE FROM "DeclarantPointPrelevement" WHERE id=$1', [f.exploitation])
    await client.query('DELETE FROM "ExploitationIdentityLock" WHERE "declarantUserId"=$1 AND "pointPrelevementId"=$2', [f.user, f.point])
    await client.query('DELETE FROM "PointPrelevement" WHERE id=$1', [f.point])
    await client.query('DELETE FROM "User" WHERE id=$1', [f.user])
    await client.query('DELETE FROM "SandreWaterUse" WHERE id=$1', [f.usage])
    await client.query('COMMIT')
  }
})
