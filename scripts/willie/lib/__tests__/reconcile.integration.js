import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {
  digest,
  validateManifest,
  readReconcileState,
  reviewReconcile,
  lockReconcileBeforeTransaction,
  applyReconcile,
  rollbackReconcile
} from '../reconcile.js'
import {requireDisposableDatabase} from '../../../../lib/util/test-helpers/disposable-database.js'

const enabled = process.env.DROPT_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
const window = {start: '2026-01-01', end: '2026-01-04'}
let client

test.before(async () => {
  if (!enabled) return
  requireDisposableDatabase()
  client = new pg.Client({connectionString: process.env.DATABASE_URL})
  await client.connect()
})
test.beforeEach(async () => { if (enabled) await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE') })
test.afterEach.always(async () => { if (enabled) await client.query('ROLLBACK') })
test.after.always(async () => {
  if (client) await client.end()
  await globalThis.prisma?.$disconnect()
  await globalThis.pgPool?.end()
})

const rows = async (sql, params = []) => (await client.query(sql, params)).rows
const row = async (table, id) => (await rows(`SELECT to_jsonb(t) AS item FROM "${table}" t WHERE id=$1`, [id]))[0]?.item
const signed = (value, key) => ({...value, [key]: digest(value)})
const day = (date, value) => ({periodStart: `${date}T00:00:00.000Z`,
  periodEnd: new Date(Date.parse(`${date}T00:00:00.000Z`) + 86400000).toISOString(), value})

function inputs(entries, {retireConnectors = [], transfers = [], series = entries.map(entry => ({
  sourcePointId: entry.sourcePointId, values: [day('2026-01-02', 100)]
}))} = {}) {
  const payload = signed({version: 1, provider: 'willie', window,
    stations: series.map(station => ({rawSha256: digest(station), ...station}))}, 'payloadHash')
  const manifest = signed({version: 1, operation: 'willie-reconcile', createdAt: '2026-11-02T12:00:00.000Z', window,
    conflictPolicy: 'ARCHIVE_WHOLE_ROW', entries, retireConnectors, transfers,
    sourceHashes: {workbook: digest('synthetic workbook')}, payloadHash: payload.payloadHash}, 'manifestHash')
  return {manifest, payload}
}

async function owner() {
  const id = randomUUID()
  await client.query('INSERT INTO "User" (id,role,"updatedAt") VALUES ($1,\'DECLARANT\',now())', [id])
  await client.query('INSERT INTO "Declarant" ("userId","preleveurType") VALUES ($1,\'IRRIGANT\')', [id])
  return id
}

async function fixture({preleveurId, pointId, usageId, rate = 100, stationId = randomUUID(), connector = true} = {}) {
  const result = {preleveurId: preleveurId ?? await owner(), pointId: pointId ?? randomUUID(),
    usageId: usageId ?? randomUUID(), exploitationId: randomUUID(), connectorId: randomUUID(), sourcePointId: stationId, rate}
  if (!pointId) await client.query(`INSERT INTO "PointPrelevement" (id,name,"waterBodyType","flowType","updatedAt")
    VALUES ($1,$2,'SOUTERRAIN','PRELEVEMENT',now())`, [result.pointId, `Point synthétique ${result.pointId}`])
  if (!usageId) await client.query(`INSERT INTO "SandreWaterUse" (id,code,kind,label,"updatedAt")
    VALUES ($1,$2,'USAGE','Usage synthétique',now())`, [result.usageId, `test-${result.usageId.slice(0, 8)}`])
  await client.query(`INSERT INTO "DeclarantPointPrelevement" (id,"declarantUserId","pointPrelevementId","usageId",status,"updatedAt")
    VALUES ($1,$2,$3,$4,'EN_ACTIVITE',now())`, [result.exploitationId, result.preleveurId, result.pointId, result.usageId])
  if (connector) await addConnector(result)
  return result
}

async function addConnector(entry) {
  await client.query(`INSERT INTO "DeclarantPointPrelevementConnector"
    (id,"declarantPointPrelevementId","connectorType","connectorParameters",rate,"updatedAt")
    VALUES ($1,$2,'willie',$3,$4,now())`, [entry.connectorId, entry.exploitationId,
    {sourcePointId: entry.sourcePointId}, entry.rate])
}

function entry(f, overrides = {}) {
  const {connectorId, exploitationId, preleveurId, pointId, sourcePointId, rate} = f
  return {connectorId, exploitationId, preleveurId, pointId, sourcePointId, rate, ...overrides}
}

async function source(f, {provider = 'willie', declaration = false} = {}) {
  const id = randomUUID()
  let declarationId = null
  if (declaration) {
    declarationId = randomUUID()
    await client.query(`INSERT INTO "Declaration"
      (id,code,"declarantUserId","createdByDeclarantUserId",type,"waterWithdrawalType","updatedAt")
      VALUES ($1,$2,$3,$3,'synthetic-ougc','SOUTERRAIN',now())`,
    [declarationId, randomUUID().slice(0, 6), f.preleveurId])
  }
  const metadata = provider === 'willie' ? {connector: 'willie', connectorId: f.connectorId,
    sourcePointId: f.sourcePointId, connectorRate: f.rate, pointId: f.pointId, declarantId: f.preleveurId}
    : {parser: 'synthetic-ougc', author: 'synthetic uploader'}
  await client.query(`INSERT INTO "Source" (id,type,status,"globalInstructionStatus","declarationId",metadata,"updatedAt")
    VALUES ($1,$2,'COMPLETED','VALIDATED',$3,$4,now())`, [id, declaration ? 'DECLARATION' : 'API', declarationId, metadata])
  return {id, declarationId, metadata}
}

async function chunk(f, {source: suppliedSource, provider, declaration, start = '2026-01-02T00:00:00.000Z',
  end = '2026-01-03T00:00:00.000Z', value = 50, exploitationId = f.exploitationId, metric = 'volume', unit = 'm3'} = {}) {
  const s = suppliedSource ?? await source(f, {provider, declaration})
  const id = randomUUID()
  const valueId = randomUUID()
  await client.query(`INSERT INTO "Chunk" (id,"sourceId","pointPrelevementId","preleveurUserId",
    "submittedByDeclarantUserId","exploitationId","usageId","instructionStatus","minDate","maxDate",metadata,"updatedAt")
    VALUES ($1,$2,$3,$4,$4,$5,$6,'VALIDATED',$7,$8,$9,now())`,
  [id, s.id, f.pointId, f.preleveurId, exploitationId, f.usageId, start.slice(0, 10), end.slice(0, 10), s.metadata])
  await client.query(`INSERT INTO "ChunkValue" (id,"chunkId","metricTypeCode",unit,frequency,"periodStart","periodEnd",value,"updatedAt")
    VALUES ($1,$2,$3,$4,'1 day',$5,$6,$7,now())`, [valueId, id, metric, unit, start, end, value])
  return {id, valueId, source: s}
}

async function valuesFor(pointId) {
  return rows(`SELECT v.id,v."chunkId",v."periodStart"::text,v."periodEnd"::text,v.value::text,c.metadata,
    c."exploitationId",c."preleveurUserId",c."sourceId" FROM "ChunkValue" v JOIN "Chunk" c ON c.id=v."chunkId"
    WHERE c."pointPrelevementId"=$1 ORDER BY v.id`, [pointId])
}

async function apply(t, input) {
  const review = await reviewReconcile(client, input.manifest, input.payload)
  t.true(review.complete, JSON.stringify(review.blocked))
  const receipt = await applyReconcile(client, input.manifest, input.payload, review)
  t.true(receipt.verification.ok)
  return {review, receipt}
}

integration('Willie reconcile: deux stations à 100 % restent additives, source partagée isolée et idempotence exacte', async t => {
  const a = await fixture({rate: 50})
  const b = {...a, connectorId: randomUUID(), sourcePointId: randomUUID(), rate: 100}
  // The second station is genuinely new; maintenance must create its connector.
  const previous = await chunk(a, {value: 17, start: '2026-01-01T23:00:00.000Z', end: '2026-01-02T23:00:00.000Z'})
  const index = await chunk(a, {value: 431, metric: 'index'})
  const historic = await chunk(a, {value: 8, start: '2025-06-01T00:00:00.000Z', end: '2025-06-02T00:00:00.000Z'})
  const ougc = await chunk(a, {provider: 'ougc', declaration: true, value: 1000,
    start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z'})
  const foreign = await fixture()
  const shared = await chunk(foreign, {source: ougc.source, value: 600})
  const preserved = {
    source: await row('Source', ougc.source.id), declaration: await row('Declaration', ougc.source.declarationId),
    chunk: await row('Chunk', shared.id), value: await row('ChunkValue', shared.valueId),
    historic: await row('ChunkValue', historic.valueId), index: await row('ChunkValue', index.valueId)
  }
  const input = inputs([entry(a, {rate: 100}), entry(b)], {series: [
    {sourcePointId: a.sourcePointId, values: [day('2026-01-02', 100)]},
    {sourcePointId: b.sourcePointId, values: [day('2026-01-02', 25), day('2026-01-03', 0)]}
  ]})
  await apply(t, input)
  const actual = (await valuesFor(a.pointId)).filter(v => v.id !== index.valueId)
  t.is(actual.filter(v => v.periodStart.startsWith('2026-')).reduce((sum, v) => sum + Number(v.value), 0), 125)
  t.is(actual.filter(v => v.periodStart.startsWith('2026-')).length, 3)
  t.true(actual.some(v => Number(v.value) === 0))
  t.is(await row('ChunkValue', previous.valueId), undefined)
  t.is(await row('ChunkValue', ougc.valueId), undefined)
  const [archive] = await rows('SELECT value,"periodStart"::text,"periodEnd"::text FROM "ChunkValueReplacement" WHERE "replacedChunkValueId"=$1', [ougc.valueId])
  t.is(Number(archive.value), 1000)
  t.is(archive.periodStart, '2026-01-01 00:00:00')
  t.is(archive.periodEnd, '2026-02-01 00:00:00')
  const actualSource = await row('Source', ougc.source.id)
  t.deepEqual({...actualSource, globalInstructionStatus: preserved.source.globalInstructionStatus,
    metadata: Object.fromEntries(Object.entries(actualSource.metadata).filter(([key]) =>
      !['totalWaterVolumeWithdrawn', 'totalWaterVolumeDischarged'].includes(key)))}, preserved.source)
  t.is(actualSource.metadata.totalWaterVolumeWithdrawn, 600)
  t.deepEqual(await row('Declaration', ougc.source.declarationId), preserved.declaration)
  t.deepEqual(await row('Chunk', shared.id), preserved.chunk)
  t.deepEqual(await row('ChunkValue', shared.valueId), preserved.value)
  t.deepEqual(await row('ChunkValue', historic.valueId), preserved.historic)
  t.deepEqual(await row('ChunkValue', index.valueId), preserved.index)
  t.is((await row('DeclarantPointPrelevementConnector', a.connectorId)).rate, 100)
  t.is((await row('DeclarantPointPrelevementConnector', b.connectorId)).rate, 100)
  const state = await readReconcileState(client, input.manifest)
  const again = await apply(t, input)
  t.deepEqual(await readReconcileState(client, input.manifest), state)
  t.is(again.review.stateHash, digest(state))
})

integration('Willie reconcile: retrait ciblé du connecteur, sans détruire les autres stations ni les ressources', async t => {
  const keep = await fixture()
  const retire = await fixture({stationId: keep.sourcePointId, rate: 50})
  const otherStation = {...retire, connectorId: randomUUID(), sourcePointId: randomUUID(), rate: 100}
  await addConnector(otherStation)
  const old = await chunk(retire, {value: 41})
  const untouched = await chunk(otherStation, {value: 23})
  const connectorOnly = await fixture()
  const keepHistory = await chunk(connectorOnly, {value: 7})
  const preserved = {
    point: await row('PointPrelevement', retire.pointId), exploitation: await row('DeclarantPointPrelevement', retire.exploitationId),
    other: await row('ChunkValue', untouched.valueId), history: await row('ChunkValue', keepHistory.valueId)
  }
  const input = inputs([entry(keep)], {retireConnectors: [
    {...entry(retire), archiveValues: true}, {...entry(connectorOnly), archiveValues: false}
  ]})
  await apply(t, input)
  t.is(await row('DeclarantPointPrelevementConnector', retire.connectorId), undefined)
  t.is(await row('DeclarantPointPrelevementConnector', connectorOnly.connectorId), undefined)
  t.is(await row('ChunkValue', old.valueId), undefined)
  t.deepEqual(await row('ChunkValue', untouched.valueId), preserved.other)
  t.deepEqual(await row('ChunkValue', keepHistory.valueId), preserved.history)
  t.deepEqual(await row('PointPrelevement', retire.pointId), preserved.point)
  t.deepEqual({...await row('DeclarantPointPrelevement', retire.exploitationId),
    mostRecentAvailableDate: preserved.exploitation.mostRecentAvailableDate, updatedAt: preserved.exploitation.updatedAt}, preserved.exploitation)
})

integration('Willie reconcile: changement historique de préleveur garde exploitation, source et déposant communs', async t => {
  const f = await fixture()
  const target = await owner()
  const collector = await owner()
  await client.query('INSERT INTO "DeclarantCollecteurExploitation" (id,"collecteurUserId","exploitationId","updatedAt") VALUES ($1,$2,$3,now())',
    [randomUUID(), collector, f.exploitationId])
  const old = await chunk(f, {provider: 'ougc', declaration: true, value: 20,
    start: '2024-06-01T00:00:00.000Z', end: '2024-07-01T00:00:00.000Z'})
  const unassigned = await chunk(f, {source: old.source, exploitationId: null, value: 30,
    start: '2025-06-01T00:00:00.000Z', end: '2025-07-01T00:00:00.000Z'})
  const other = await fixture()
  const outside = await chunk(other, {source: old.source, value: 90})
  const preserved = {
    source: await row('Source', old.source.id), declaration: await row('Declaration', old.source.declarationId),
    outside: await row('Chunk', outside.id), value: await row('ChunkValue', outside.valueId),
    history: await row('ChunkValue', old.valueId), unassigned: await row('ChunkValue', unassigned.valueId)
  }
  const input = inputs([entry(f, {preleveurId: target})], {transfers: [{exploitationId: f.exploitationId,
    pointId: f.pointId, fromPreleveurId: f.preleveurId, toPreleveurId: target, chunkIds: [old.id, unassigned.id]}]})
  const before = await readReconcileState(client, input.manifest)
  const {receipt} = await apply(t, input)
  const exploitation = await row('DeclarantPointPrelevement', f.exploitationId)
  t.is(exploitation.declarantUserId, target)
  t.is(exploitation.id, f.exploitationId)
  for (const id of [old.id, unassigned.id]) {
    const current = await row('Chunk', id)
    t.is(current.preleveurUserId, target)
    t.is(current.exploitationId, f.exploitationId)
    t.is(current.submittedByDeclarantUserId, f.preleveurId)
  }
  t.deepEqual(await row('Source', old.source.id), preserved.source)
  t.deepEqual(await row('Declaration', old.source.declarationId), preserved.declaration)
  t.deepEqual(await row('Chunk', outside.id), preserved.outside)
  t.deepEqual(await row('ChunkValue', outside.valueId), preserved.value)
  t.deepEqual(await row('ChunkValue', old.valueId), preserved.history)
  t.deepEqual(await row('ChunkValue', unassigned.valueId), preserved.unassigned)
  // Exercise the production authorization rule against the actual resulting
  // exploitation and collector links, within the same disposable transaction.
  const {getExploitationRights} = await import('../../../../lib/services/resource-permissions.js')
  const permissionClient = {declarantCollecteurExploitation: {findMany: async ({where}) => rows(
    'SELECT "exploitationId" FROM "DeclarantCollecteurExploitation" WHERE "collecteurUserId"=$1 AND "exploitationId"=ANY($2::uuid[])',
    [where.collecteurUserId, where.exploitationId.in])}}
  for (const [userId, canRead] of [[f.preleveurId, false], [target, true], [collector, true], [other.preleveurId, false]]) {
    const rights = await getExploitationRights({id: userId, role: 'DECLARANT'}, [exploitation], {client: permissionClient})
    t.is(rights.get(f.exploitationId).canRead, canRead)
    t.false(rights.get(f.exploitationId).canEdit)
  }
  const rollback = await rollbackReconcile(client, input.manifest, input.payload, {...receipt, status: 'COMMITTED'})
  t.true(rollback.verification.ok)
  t.deepEqual(await readReconcileState(client, input.manifest), before)
})

integration('Willie reconcile: une valeur canonique m3 déjà correcte garde exactement son identité et son historique', async t => {
  const f = await fixture()
  const unchanged = await chunk(f, {value: 100.0001, unit: 'm3'})
  const input = inputs([entry(f)], {series: [{sourcePointId: f.sourcePointId, values: [day('2026-01-02', 100.0001)]}]})
  const before = await readReconcileState(client, input.manifest)
  const original = await row('ChunkValue', unchanged.valueId)
  const {review} = await apply(t, input)
  t.deepEqual(review.changes, [])
  t.deepEqual(await readReconcileState(client, input.manifest), before)
  t.deepEqual(await row('ChunkValue', unchanged.valueId), original)
})

integration('Willie reconcile: une station sans donnée reste vide, un vrai zéro reste une mesure', async t => {
  const empty = await fixture({connector: false})
  const zero = await fixture({connector: false})
  const input = inputs([entry(empty), entry(zero)], {series: [
    {sourcePointId: empty.sourcePointId, values: []},
    {sourcePointId: zero.sourcePointId, values: [day('2026-01-02', 0)]}
  ]})
  await apply(t, input)
  t.deepEqual(await valuesFor(empty.pointId), [])
  t.is((await valuesFor(zero.pointId)).length, 1)
  t.is(Number((await valuesFor(zero.pointId))[0].value), 0)
  const malformed = inputs([entry(empty)], {series: [{sourcePointId: empty.sourcePointId, values: [day('2026-01-02', null)]}]})
  t.throws(() => validateManifest(malformed.manifest, malformed.payload))
})

integration('Willie reconcile: refuse une revue périmée et les manifestes ou données altérés', async t => {
  const f = await fixture()
  const current = await chunk(f)
  const input = inputs([entry(f)])
  const review = await reviewReconcile(client, input.manifest, input.payload)
  t.true(review.complete, JSON.stringify(review.blocked))
  await client.query('UPDATE "ChunkValue" SET value=51 WHERE id=$1', [current.valueId])
  await t.throwsAsync(applyReconcile(client, input.manifest, input.payload, review))
  t.is(Number((await row('ChunkValue', current.valueId)).value), 51)
  t.throws(() => validateManifest({...input.manifest, conflictPolicy: 'ESTIMATE_REMAINDER'}, input.payload))
  t.throws(() => validateManifest(input.manifest, {...input.payload, stations: []}))
})

integration('Willie reconcile: refuse un transfert historique incomplet ou un chunk appartenant à un autre point', async t => {
  const f = await fixture()
  const target = await owner()
  const old = await chunk(f, {provider: 'ougc', start: '2024-06-01T00:00:00.000Z', end: '2024-07-01T00:00:00.000Z'})
  const omitted = await chunk(f, {provider: 'ougc', exploitationId: null,
    start: '2025-06-01T00:00:00.000Z', end: '2025-07-01T00:00:00.000Z'})
  const other = await fixture()
  const unrelated = await chunk(other)
  for (const chunkIds of [[old.id], [old.id, omitted.id, unrelated.id]]) {
    const input = inputs([entry(f, {preleveurId: target})], {transfers: [{exploitationId: f.exploitationId,
      pointId: f.pointId, fromPreleveurId: f.preleveurId, toPreleveurId: target, chunkIds}]})
    const review = await reviewReconcile(client, input.manifest, input.payload)
    t.false(review.complete)
    await t.throwsAsync(applyReconcile(client, input.manifest, input.payload, review))
  }
  t.is((await row('DeclarantPointPrelevement', f.exploitationId)).declarantUserId, f.preleveurId)
  t.is((await row('Chunk', omitted.id)).preleveurUserId, f.preleveurId)
})

integration('Willie reconcile: refuse les identités inactives, publications compteur et sources encore en traitement', async t => {
  const f = await fixture()
  const current = await chunk(f)
  const input = inputs([entry(f)])
  for (const [sql, id] of [
    ['UPDATE "PointPrelevement" SET "deletedAt"=now() WHERE id=$1', f.pointId],
    ['UPDATE "User" SET "deletedAt"=now() WHERE id=$1', f.preleveurId],
    ['UPDATE "Chunk" SET "calculationStrategy"=\'METER\' WHERE id=$1', current.id],
    ['UPDATE "Source" SET status=\'PROCESSING\' WHERE id=$1', current.source.id]
  ]) {
    await client.query('SAVEPOINT invalid_identity')
    try {
      await client.query(sql, [id])
      const review = await reviewReconcile(client, input.manifest, input.payload)
      t.false(review.complete, sql)
      await t.throwsAsync(applyReconcile(client, input.manifest, input.payload, review))
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT invalid_identity')
      await client.query('RELEASE SAVEPOINT invalid_identity')
    }
  }
})

integration('Willie reconcile: rollback exact des données ciblées et conservation des modifications hors périmètre', async t => {
  const f = await fixture({rate: 50})
  await chunk(f, {value: 31})
  const outside = await fixture()
  const outsideChunk = await chunk(outside, {value: 77})
  const input = inputs([entry(f, {rate: 100})])
  const before = await readReconcileState(client, input.manifest)
  const {receipt} = await apply(t, input)
  await t.throwsAsync(rollbackReconcile(client, input.manifest, input.payload, {...receipt, status: 'PREPARED'}))
  const tampered = structuredClone(receipt)
  tampered.before.tables.values[0].value = '999'
  await t.throwsAsync(rollbackReconcile(client, input.manifest, input.payload, {...tampered, status: 'COMMITTED'}))
  await client.query('SAVEPOINT edited_after_apply')
  try {
    const [value] = await valuesFor(f.pointId)
    await client.query('UPDATE "ChunkValue" SET value=999 WHERE id=$1', [value.id])
    await t.throwsAsync(rollbackReconcile(client, input.manifest, input.payload, {...receipt, status: 'COMMITTED'}))
    t.is(Number((await row('ChunkValue', value.id)).value), 999)
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT edited_after_apply')
    await client.query('RELEASE SAVEPOINT edited_after_apply')
  }
  await client.query('UPDATE "ChunkValue" SET value=78 WHERE id=$1', [outsideChunk.valueId])
  const result = await rollbackReconcile(client, input.manifest, input.payload, {...receipt, status: 'COMMITTED'})
  t.true(result.verification.ok)
  t.deepEqual(await readReconcileState(client, input.manifest), before)
  t.is(Number((await row('ChunkValue', outsideChunk.valueId)).value), 78)
  const second = await rollbackReconcile(client, input.manifest, input.payload, {...receipt, status: 'COMMITTED'})
  t.true(second.verification.ok)
  t.deepEqual(await readReconcileState(client, input.manifest), before)
})

integration('Willie reconcile: erreur transactionnelle annule données, connecteurs, archives et audit', async t => {
  const f = await fixture({rate: 50})
  await chunk(f)
  const input = inputs([entry(f, {rate: 100})])
  const review = await reviewReconcile(client, input.manifest, input.payload)
  t.true(review.complete, JSON.stringify(review.blocked))
  const before = await readReconcileState(client, input.manifest)
  const audit = await rows('SELECT count(*)::int AS n FROM "AuditEvent"')
  const failing = {query: (sql, parameters) => sql.startsWith('INSERT INTO "AuditMutationScope"')
    ? client.query('SELECT 1/0') : client.query(sql, parameters)}
  await t.throwsAsync(applyReconcile(failing, input.manifest, input.payload, review), {code: '22012'})
  t.deepEqual(await readReconcileState(client, input.manifest), before)
  t.deepEqual(await rows('SELECT count(*)::int AS n FROM "AuditEvent"'), audit)
})

integration('Willie reconcile: verrou avant transaction attend le dernier import et refuse la revue devenue périmée', async t => {
  const f = await fixture()
  const previous = await chunk(f)
  const input = inputs([entry(f)])
  const review = await reviewReconcile(client, input.manifest, input.payload)
  await client.query('COMMIT')
  const writer = new pg.Client({connectionString: process.env.DATABASE_URL})
  let acquired
  try {
    await writer.connect()
    await writer.query('BEGIN')
    await writer.query('SELECT pg_advisory_xact_lock(hashtext(\'volumes-from-index\'),hashtext($1))', [f.pointId])
    let locked = false
    acquired = lockReconcileBeforeTransaction(client, input.manifest).then(() => { locked = true })
    await new Promise(resolve => setTimeout(resolve, 40))
    t.false(locked)
    await writer.query('UPDATE "ChunkValue" SET value=91 WHERE id=$1', [previous.valueId])
    await writer.query('COMMIT')
    await acquired
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    t.is(Number((await row('ChunkValue', previous.valueId)).value), 91)
    await t.throwsAsync(applyReconcile(client, input.manifest, input.payload, review))
    t.is(Number((await row('ChunkValue', previous.valueId)).value), 91)
  } finally {
    await writer.query('ROLLBACK').catch(() => {})
    await writer.end()
    await acquired
    await client.query('ROLLBACK')
    await client.query('SELECT pg_advisory_unlock_all()')
    await client.query('BEGIN')
    await client.query('DELETE FROM "Source" WHERE id=$1', [previous.source.id])
    await client.query('DELETE FROM "DeclarantPointPrelevementConnector" WHERE id=$1', [f.connectorId])
    await client.query('DELETE FROM "DeclarantPointPrelevement" WHERE id=$1', [f.exploitationId])
    await client.query('DELETE FROM "ExploitationIdentityLock" WHERE "declarantUserId"=$1 AND "pointPrelevementId"=$2', [f.preleveurId, f.pointId])
    await client.query('DELETE FROM "PointPrelevement" WHERE id=$1', [f.pointId])
    await client.query('DELETE FROM "User" WHERE id=$1', [f.preleveurId])
    await client.query('DELETE FROM "SandreWaterUse" WHERE id=$1', [f.usageId])
    await client.query('COMMIT')
  }
})
