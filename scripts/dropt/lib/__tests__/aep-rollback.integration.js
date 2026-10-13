import test from 'ava'
import process from 'node:process'
import {createHash, randomUUID} from 'node:crypto'
import pg from 'pg'
import {reviewAep, applyAep} from '../aep-apply.js'
import {rollbackAep} from '../aep-rollback.js'
import {requireDisposableDatabase} from '../../../../lib/util/test-helpers/disposable-database.js'

const enabled = process.env.DROPT_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const sign = manifest => { const {manifestHash: _hash, ...payload} = manifest; return {...payload, manifestHash: digest(payload)} }
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
  const suffix = randomUUID()
  const zoneCodes = ['reg-75', 'dep-33', 'sage-SAGE05003']
  const zones = []
  for (const [index, type] of ['REGION', 'DEPARTEMENT', 'SAGE'].entries()) {
    const id = randomUUID()
    await client.query('INSERT INTO "Zone" (id,code,name,type,"managedResourceType",coordinates,"updatedAt") VALUES ($1,$2,$3,$4,$5,ST_GeomFromText(\'MULTIPOLYGON(((0 44.4,0.4 44.4,0.4 44.7,0 44.7,0 44.4)))\',4326),now())',
      [id, zoneCodes[index], `Zone AEP test ${suffix}`, type, type === 'SAGE' ? 'SOUTERRAIN' : null])
    zones.push(id)
  }
  const usage = await client.query('SELECT id FROM "SandreWaterUse" WHERE code=\'5\'')
  if (!usage.rowCount) await client.query('INSERT INTO "SandreWaterUse" (id,code,kind,label,"updatedAt") VALUES ($1,\'5\',\'USAGE\',\'AEP synthétique\',now())', [randomUUID()])
  const oldId = randomUUID()
  const oldRef = randomUUID()
  const bss = `BSS-TEST-${suffix}`
  const oldSource = `dropt-epidropt:point:${suffix}`
  await client.query('INSERT INTO "PointPrelevement" (id,name,"codeBSS","sourceId","waterBodyType","flowType","updatedAt",coordinates) VALUES ($1,\'1\',$2,$3,\'SOUTERRAIN\',\'PRELEVEMENT\',now(),ST_SetSRID(ST_MakePoint(0.2,44.5),4326))', [oldId, bss, oldSource])
  await client.query('INSERT INTO "ExternalReference" (id,provider,scope,kind,"externalId","pointPrelevementId",metadata) VALUES ($1,\'epidropt\',\'epidropt\',\'POINT\',\'1\',$2,\'{"source":"fixture"}\')', [oldRef, oldId])
  for (const zoneId of zones) await client.query('INSERT INTO "PointPrelevementZone" (id,"pointPrelevementId","zoneId") VALUES ($1,$2,$3)', [randomUUID(), oldId, zoneId])
  const ownerId = randomUUID()
  const pointId = randomUUID()
  const exploitationId = randomUUID()
  const email = `${suffix}@example.test`
  const manifest = sign({formatVersion: 1, scope: 'dropt-aep',
    declarants: [{id: ownerId, key: `owner:${suffix}`, sourceId: `dropt-aep:preleveur:${suffix}`, email,
      data: {siret: '12345678900012', socialReason: `AEP test ${suffix}`, declarantRole: 'PRELEVEUR', declarantType: 'LEGAL_PERSON', preleveurType: 'GESTIONNAIRE_AEP', quickDeclarationEnabled: true, declarationNotificationsEnabled: false}}],
    points: [{id: pointId, key: `point:${suffix}`, sourceId: `dropt-aep:point:${suffix}`, coordinates: [0.2, 44.5],
      data: {name: `Captage test ${suffix}`, waterBodyType: 'SOUTERRAIN', flowType: 'PRELEVEMENT', pointKind: 'PHYSIQUE', collectionMode: 'MANUAL', codeBSS: bss}}],
    exploitations: [{id: exploitationId, sourceId: `dropt-aep:exploitation:${suffix}`, pointId, declarantId: ownerId, usageCode: '5',
      data: {status: 'EN_ACTIVITE', excludeFromQuickDeclaration: false, startDate: null, endDate: null}}],
    retirements: [{name: '1', codeBSS: bss, sourcePrefix: 'dropt-epidropt:point:', replacementKey: `point:${suffix}`}]
  })
  return {manifest, oldId, oldRef, ownerId, pointId, exploitationId, email, zones}
}

async function appliedFixture() {
  const f = await fixture()
  await client.query('UPDATE "PointPrelevement" SET "updatedAt"=\'2026-01-02 03:04:05.123456\'::timestamp WHERE id=$1', [f.oldId])
  const stamp = (await client.query('SELECT to_char("updatedAt",\'YYYY-MM-DD HH24:MI:SS.US\') AS stamp FROM "PointPrelevement" WHERE id=$1', [f.oldId])).rows[0].stamp
  const original = await reviewAep(client, f.manifest)
  const receipt = JSON.parse(JSON.stringify({...await applyAep(client, f.manifest, original), status: 'COMMITTED'}))
  return {...f, original, receipt, stamp}
}

const auditRows = async manifestHash => (await client.query(`SELECT to_jsonb(e) AS row FROM "AuditEvent" e
  WHERE metadata->>'manifestHash'=$1 ORDER BY id`, [manifestHash])).rows

integration('rollback AEP restaure exactement points, métadonnées, dates et verrous ; conserve les audits', async t => {
  const f = await appliedFixture()
  const originalAudits = await auditRows(f.manifest.manifestHash)
  t.is(originalAudits.length, 4)
  const result = await rollbackAep(client, f.manifest, f.receipt)
  t.true(result.complete)
  t.true(result.restored)
  t.is(result.afterStateHash, f.original.stateHash)
  t.is((await reviewAep(client, f.manifest)).stateHash, f.original.stateHash)
  t.deepEqual(await auditRows(f.manifest.manifestHash), originalAudits)
  t.is((await client.query('SELECT count(*)::int AS n FROM "User" WHERE id=$1', [f.ownerId])).rows[0].n, 0)
  t.is((await client.query('SELECT count(*)::int AS n FROM "UserEmailIdentity" WHERE email=$1', [f.email])).rows[0].n, 0)
  t.is((await client.query('SELECT count(*)::int AS n FROM "ExploitationIdentityLock" WHERE "declarantUserId"=$1', [f.ownerId])).rows[0].n, 0)
  t.is((await client.query('SELECT to_char("updatedAt",\'YYYY-MM-DD HH24:MI:SS.US\') AS stamp FROM "PointPrelevement" WHERE id=$1', [f.oldId])).rows[0].stamp, f.stamp)
  t.is((await client.query('SELECT count(*)::int AS n FROM "AuditEvent" WHERE metadata->>\'rollbackOfManifestHash\'=$1', [f.manifest.manifestHash])).rows[0].n, 4)
  t.deepEqual(result.summary, {changes: 4, restoredPoints: 1, deleted: {DeclarantPointPrelevement: 1, DeclarantZone: 3,
    ExternalReference: 2, DeclarantContactEmail: 1, PointPrelevementZone: 3, PointPrelevement: 1, Declarant: 1, User: 1}})
  await t.throwsAsync(rollbackAep(client, f.manifest, f.receipt), {message: 'AEP_ROLLBACK_STATE_CHANGED'})
  t.is((await reviewAep(client, f.manifest)).stateHash, f.original.stateHash)
})

integration('rollback refuse une simulation, un reçu altéré ou un autre manifeste avant écriture', async t => {
  const f = await appliedFixture()
  for (const change of [{status: 'PREPARED'}, {applied: false}, {complete: false}, {manifestHash: 'a'.repeat(64)}]) {
    await t.throwsAsync(rollbackAep(client, f.manifest, {...f.receipt, ...change}), {message: 'AEP_ROLLBACK_COMMITTED_RECEIPT_REQUIRED'})
  }
  for (const change of [{stateHash: 'b'.repeat(64)}, {planHash: 'b'.repeat(64)}, {changes: []}]) {
    await t.throwsAsync(rollbackAep(client, f.manifest, {...f.receipt, ...change}), {message: 'AEP_ROLLBACK_RECEIPT_INVALID'})
  }
  t.is((await reviewAep(client, f.manifest)).stateHash, f.receipt.verification.review.stateHash)
})

integration('rollback refuse un réglage, une métadonnée ou un verrou changés, sans suppression partielle', async t => {
  const f = await appliedFixture()
  for (const [sql, values] of [
    ['UPDATE "DeclarantPointPrelevement" SET "excludeFromQuickDeclaration"=true WHERE id=$1', [f.exploitationId]],
    ['UPDATE "PointPrelevement" SET comment=\'modification synthétique\' WHERE id=$1', [f.pointId]],
    ['UPDATE "ExternalReference" SET metadata=metadata||\'{"manual":true}\'::jsonb WHERE id=$1', [f.oldRef]],
    ['UPDATE "ExploitationIdentityLock" SET revision=revision+1 WHERE "declarantUserId"=$1', [f.ownerId]]
  ]) {
    await client.query('SAVEPOINT changed')
    await client.query(sql, values)
    const changedHash = (await reviewAep(client, f.manifest)).stateHash
    await t.throwsAsync(rollbackAep(client, f.manifest, f.receipt), {message: 'AEP_ROLLBACK_STATE_CHANGED'})
    t.is((await reviewAep(client, f.manifest)).stateHash, changedHash)
    await client.query('ROLLBACK TO SAVEPOINT changed')
    await client.query('RELEASE SAVEPOINT changed')
  }
})

integration('rollback refuse jeton, session ou document ajoutés après application', async t => {
  const f = await appliedFixture()
  const cases = [
    ['INSERT INTO "AuthToken" (id,token,"userId","expiresAt") VALUES ($1,$2,$3,now()+interval \'1 hour\')', [randomUUID(), 'synthetic-auth-only', f.ownerId]],
    ['INSERT INTO "SessionToken" (id,token,role,"userId","expiresAt") VALUES ($1,$2,\'DECLARANT\',$3,now()+interval \'1 hour\')', [randomUUID(), 'synthetic-session-only', f.ownerId]],
    ['INSERT INTO "ResourceDocument" (id,"declarantUserId",filename,"storageKey","updatedAt") VALUES ($1,$2,\'synthetic.pdf\',$3,now())', [randomUUID(), f.ownerId, randomUUID()]]
  ]
  for (const [sql, parameters] of cases) {
    await client.query('SAVEPOINT attachment')
    await client.query(sql, parameters)
    const changedHash = (await reviewAep(client, f.manifest)).stateHash
    await t.throwsAsync(rollbackAep(client, f.manifest, f.receipt), {message: 'AEP_ROLLBACK_STATE_CHANGED'})
    t.is((await reviewAep(client, f.manifest)).stateHash, changedHash)
    await client.query('ROLLBACK TO SAVEPOINT attachment')
    await client.query('RELEASE SAVEPOINT attachment')
  }
})

integration('rollback refuse compteur affecté et données METER sans modifier leur allocation', async t => {
  const f = await appliedFixture()
  const compteurId = randomUUID()
  const allocationId = randomUUID()
  await client.query('INSERT INTO "Compteur" (id,"updatedAt") VALUES ($1,now())', [compteurId])
  await client.query('INSERT INTO "MeterAllocation" (id,"compteurId","exploitationId","sourceId",provider,scope) VALUES ($1,$2,$3,$4,\'synthetic\',\'synthetic\')', [allocationId, compteurId, f.exploitationId, `synthetic:${allocationId}`])
  await t.throwsAsync(rollbackAep(client, f.manifest, f.receipt), {message: 'AEP_ROLLBACK_STATE_CHANGED'})
  t.is((await client.query('SELECT "exploitationId" FROM "MeterAllocation" WHERE id=$1', [allocationId])).rows[0].exploitationId, f.exploitationId)
})

integration('rollback bloque aussi les FK CASCADE hors inventaire métier : activité mensuelle et export', async t => {
  const f = await appliedFixture()
  const attachments = [
    ['INSERT INTO "UserMonthlyActivity" (month,"userId",role) VALUES (\'2026-10\',$1,\'DECLARANT\')', [f.ownerId]],
    ['INSERT INTO "DataExport" (id,"requestedByUserId","requestedByRole","updatedAt") VALUES ($1,$2,\'DECLARANT\',now())', [randomUUID(), f.ownerId]]
  ]
  for (const [sql, parameters] of attachments) {
    await client.query('SAVEPOINT outside_inventory')
    await client.query(sql, parameters)
    t.is((await reviewAep(client, f.manifest)).stateHash, f.receipt.verification.review.stateHash)
    await t.throwsAsync(rollbackAep(client, f.manifest, f.receipt), {message: 'AEP_ROLLBACK_FOREIGN_ATTACHMENT'})
    t.is((await reviewAep(client, f.manifest)).stateHash, f.receipt.verification.review.stateHash)
    await client.query('ROLLBACK TO SAVEPOINT outside_inventory')
    await client.query('RELEASE SAVEPOINT outside_inventory')
  }
})

integration('rollback partiel conserve comptes et PP préexistants et restaure la révision du verrou', async t => {
  const f = await appliedFixture()
  await client.query('DELETE FROM "DeclarantPointPrelevement" WHERE id=$1', [f.exploitationId])
  const manifest = sign({...f.manifest, syntheticRevision: 2})
  const original = await reviewAep(client, manifest)
  t.is(original.changes.length, 1)
  const receipt = {...await applyAep(client, manifest, original), status: 'COMMITTED'}
  const result = await rollbackAep(client, manifest, receipt)
  t.is(result.afterStateHash, original.stateHash)
  t.is(result.summary.deleted.User, 0)
  t.is(result.summary.deleted.PointPrelevement, 0)
  t.is(result.summary.restoredPoints, 0)
  t.is((await client.query('SELECT count(*)::int AS n FROM "User" WHERE id=$1', [f.ownerId])).rows[0].n, 1)
  t.is((await client.query('SELECT count(*)::int AS n FROM "PointPrelevement" WHERE id=$1', [f.pointId])).rows[0].n, 1)
})

integration('rollback protège les références auteur sans FK sur les ressources d’un autre compte', async t => {
  const f = await appliedFixture()
  const other = randomUUID()
  const declaration = randomUUID()
  await client.query('INSERT INTO "User" (id,role,"updatedAt") VALUES ($1,\'DECLARANT\',now())', [other])
  await client.query('INSERT INTO "Declarant" ("userId","preleveurType") VALUES ($1,\'AUTRE\')', [other])
  await client.query('INSERT INTO "Declaration" (id,code,"declarantUserId",type,"waterWithdrawalType","updatedAt") VALUES ($1,\'SYN001\',$2,\'synthetic\',\'synthetic\',now())', [declaration, other])
  for (const [sql, parameters] of [
    ['INSERT INTO "DeclarantZone" (id,"declarantUserId","zoneId","createdByUserId","updatedAt") VALUES ($1,$2,$3,$4,now())', [randomUUID(), other, f.zones[0], f.ownerId]],
    ['INSERT INTO "DeclarationProcessingEvent" (id,"declarationId",status,"createdByUserId") VALUES ($1,$2,\'CREATED\',$3)', [randomUUID(), declaration, f.ownerId]]
  ]) {
    await client.query('SAVEPOINT author_reference')
    await client.query(sql, parameters)
    t.is((await reviewAep(client, f.manifest)).stateHash, f.receipt.verification.review.stateHash)
    await t.throwsAsync(rollbackAep(client, f.manifest, f.receipt), {message: 'AEP_ROLLBACK_FOREIGN_ATTACHMENT'})
    await client.query('ROLLBACK TO SAVEPOINT author_reference')
    await client.query('RELEASE SAVEPOINT author_reference')
  }
})

integration('rollback restaure automatiquement sa sous-transaction si un audit final échoue', async t => {
  const f = await appliedFixture()
  let fail = true
  const failingClient = {query: (sql, parameters) => {
    if (fail && sql.startsWith('INSERT INTO "AuditEvent"')) {
      fail = false
      return client.query('SELECT 1/0')
    }
    return client.query(sql, parameters)
  }}
  await t.throwsAsync(rollbackAep(failingClient, f.manifest, f.receipt), {code: '22012'})
  t.is((await reviewAep(client, f.manifest)).stateHash, f.receipt.verification.review.stateHash)
  t.is((await auditRows(f.manifest.manifestHash)).length, 4)
  t.true((await rollbackAep(client, f.manifest, f.receipt)).restored)
})

integration('rollback exige une transaction explicite sérialisable en écriture', async t => {
  const f = await appliedFixture()
  await client.query('ROLLBACK')
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
  await t.throwsAsync(rollbackAep(client, f.manifest, f.receipt), {message: 'AEP_SERIALIZABLE_TRANSACTION_REQUIRED'})
  await client.query('ROLLBACK')
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY')
  await t.throwsAsync(rollbackAep(client, f.manifest, f.receipt), {message: 'AEP_SERIALIZABLE_TRANSACTION_REQUIRED'})
})
