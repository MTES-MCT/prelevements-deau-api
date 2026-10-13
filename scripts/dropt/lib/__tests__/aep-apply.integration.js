import test from 'ava'
import process from 'node:process'
import {createHash, randomUUID} from 'node:crypto'
import pg from 'pg'
import {reviewAep, applyAep, verifyAep} from '../aep-apply.js'
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

integration('AEP review reste en lecture seule, application atomique et rejeu sans écriture ni audit supplémentaire', async t => {
  const f = await fixture()
  const first = await reviewAep(client, f.manifest)
  t.true(first.complete, JSON.stringify(first.blocked))
  t.deepEqual(first.summary, {declarantsCreated: 1, pointsCreated: 1, exploitationsCreated: 1, pointsRetired: 1, changes: 4})
  t.is((await client.query('SELECT count(*)::int AS count FROM "User" WHERE id=$1', [f.ownerId])).rows[0].count, 0)
  await client.query('SAVEPOINT application')
  const applied = await applyAep(client, f.manifest, first)
  t.true(applied.verification.ok)
  t.is((await client.query('SELECT "primaryUserId" FROM "UserEmailIdentity" WHERE email=$1', [f.email])).rows[0].primaryUserId, f.ownerId)
  const retired = (await client.query('SELECT * FROM "PointPrelevement" WHERE id=$1', [f.oldId])).rows[0]
  t.truthy(retired.deletedAt)
  t.is(retired.name, '1')
  t.is((await client.query('SELECT count(*)::int AS n FROM "PointPrelevementZone" WHERE "pointPrelevementId"=$1', [f.oldId])).rows[0].n, 3)
  const repeated = await reviewAep(client, f.manifest)
  t.is(repeated.summary.changes, 0)
  await applyAep(client, f.manifest, repeated)
  t.is((await reviewAep(client, f.manifest)).stateHash, repeated.stateHash)
  t.is((await client.query('SELECT count(*)::int AS n FROM "AuditEvent" WHERE metadata->>\'manifestHash\'=$1', [f.manifest.manifestHash])).rows[0].n, 4)
  const nextManifest = sign({...f.manifest, datasetRevision: 2})
  const nextReview = await reviewAep(client, nextManifest)
  t.true(nextReview.complete, JSON.stringify(nextReview.blocked))
  t.is(nextReview.summary.changes, 0)
  await applyAep(client, nextManifest, nextReview)
  t.is((await reviewAep(client, nextManifest)).stateHash, repeated.stateHash)
  await client.query('ROLLBACK TO SAVEPOINT application')
  t.is((await reviewAep(client, f.manifest)).stateHash, first.stateHash)
})

integration('AEP refuse collision email réservé alias et identité SIRET même sur compte supprimé', async t => {
  const f = await fixture()
  const otherId = randomUUID()
  await client.query('INSERT INTO "User" (id,role,"deletedAt","updatedAt") VALUES ($1,\'DECLARANT\',now(),now())', [otherId])
  await client.query('INSERT INTO "Declarant" ("userId",siret,"preleveurType") VALUES ($1,$2,$3)', [otherId, '123 456 789 00012', 'AUTRE'])
  const aliasOwner = randomUUID()
  await client.query('INSERT INTO "User" (id,role,"updatedAt") VALUES ($1,$2,now())', [aliasOwner, 'DECLARANT'])
  await client.query('INSERT INTO "UserEmailAlias" (id,"userId",email,"updatedAt") VALUES ($1,$2,$3,now())', [randomUUID(), aliasOwner, f.email])
  const review = await reviewAep(client, f.manifest)
  t.false(review.complete)
  t.true(review.blocked.some(issue => issue.code === 'AEP_EMAIL_COLLISION'))
  t.true(review.blocked.some(issue => issue.code === 'AEP_DECLARANT_COLLISION'))
})

integration('AEP refuse un PP ancien dépendant et conserve toutes ses données', async t => {
  const f = await fixture()
  const otherId = randomUUID()
  await client.query('INSERT INTO "User" (id,role,"updatedAt") VALUES ($1,\'DECLARANT\',now())', [otherId])
  await client.query('INSERT INTO "Declarant" ("userId","preleveurType") VALUES ($1,$2)', [otherId, 'AUTRE'])
  await client.query('INSERT INTO "DeclarantPointPrelevement" (id,"pointPrelevementId","declarantUserId","usageId","updatedAt") SELECT $1,$2,$3,id,now() FROM "SandreWaterUse" WHERE code=\'5\'', [randomUUID(), f.oldId, otherId])
  const review = await reviewAep(client, f.manifest)
  t.false(review.complete)
  t.true(review.blocked.some(issue => issue.code === 'AEP_RETIREMENT_DEPENDENCY'))
  t.is((await client.query('SELECT "deletedAt" FROM "PointPrelevement" WHERE id=$1', [f.oldId])).rows[0].deletedAt, null)
})

integration('AEP dérive depuis la simulation bloque avant la première mutation', async t => {
  const f = await fixture()
  const review = await reviewAep(client, f.manifest)
  await client.query('UPDATE "PointPrelevement" SET comment=$2 WHERE id=$1', [f.oldId, 'Correction manuelle'])
  await t.throwsAsync(applyAep(client, f.manifest, review), {message: 'AEP_STATE_CHANGED'})
  t.is((await client.query('SELECT count(*)::int AS n FROM "User" WHERE id=$1', [f.ownerId])).rows[0].n, 0)
})

integration('AEP conserve et signale les réglages manuels après import', async t => {
  const f = await fixture()
  await applyAep(client, f.manifest, await reviewAep(client, f.manifest))
  await client.query('UPDATE "DeclarantPointPrelevement" SET "excludeFromQuickDeclaration"=true WHERE id=$1', [f.exploitationId])
  const result = await verifyAep(client, f.manifest)
  t.false(result.ok)
  t.true(result.issues.some(issue => issue.code === 'AEP_EXPLOITATION_CHANGED'))
  t.true((await client.query('SELECT "excludeFromQuickDeclaration" FROM "DeclarantPointPrelevement" WHERE id=$1', [f.exploitationId])).rows[0].excludeFromQuickDeclaration)
})

integration('AEP refuse zonage ambigu ou configuration modifiée', async t => {
  const f = await fixture()
  const id = randomUUID()
  await client.query('INSERT INTO "Zone" (id,code,name,type,"managedResourceType",coordinates,"updatedAt") SELECT $1,$2,\'Autre SAGE\',\'SAGE\',\'SOUTERRAIN\',coordinates,now() FROM "Zone" WHERE id=$3', [id, `sage-${id}`, f.zones[2]])
  const result = await reviewAep(client, f.manifest)
  t.false(result.complete)
  t.true(result.blocked.some(issue => issue.code === 'AEP_POINT_ZONE_AMBIGUOUS'))
})

integration('AEP refuse référence étrangère et suppression antérieure sans reçu', async t => {
  const f = await fixture()
  await client.query('UPDATE "ExternalReference" SET provider=$2 WHERE id=$1', [f.oldRef, 'autre-source'])
  await client.query('UPDATE "PointPrelevement" SET "deletedAt"=now() WHERE id=$1', [f.oldId])
  const result = await reviewAep(client, f.manifest)
  t.true(result.blocked.some(issue => issue.code === 'AEP_RETIREMENT_REFERENCE'))
  t.true(result.blocked.some(issue => issue.code === 'AEP_RETIREMENT_ALREADY_DELETED'))
})

integration('AEP exige transaction sérialisable et refuse manifeste modifié', async t => {
  const f = await fixture()
  await t.throwsAsync(reviewAep(client, {...f.manifest, points: []}), {message: 'AEP_MANIFEST_HASH_INVALID'})
  const review = await reviewAep(client, f.manifest)
  await client.query('ROLLBACK')
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
  await t.throwsAsync(applyAep(client, f.manifest, review), {message: 'AEP_SERIALIZABLE_TRANSACTION_REQUIRED'})
})

integration('AEP review et verify sont exécutables dans une vraie transaction READ ONLY', async t => {
  const f = await fixture()
  await client.query('ROLLBACK')
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY')
  const review = await reviewAep(client, f.manifest)
  t.false(review.complete)
  t.true(review.blocked.some(issue => issue.code === 'AEP_RETIREMENT_IDENTITY'))
  t.false((await verifyAep(client, f.manifest)).ok)
})

integration('AEP refuse la collision de nom ou de source externe et un zonage ancien étranger', async t => {
  const f = await fixture()
  await client.query('INSERT INTO "PointPrelevement" (id,name,"waterBodyType","flowType","updatedAt") VALUES ($1,$2,$3,$4,now())', [randomUUID(), f.manifest.points[0].data.name, 'SOUTERRAIN', 'PRELEVEMENT'])
  await client.query('UPDATE "Zone" SET code=$2 WHERE id=$1', [f.zones[1], 'dep-99'])
  const review = await reviewAep(client, f.manifest)
  t.false(review.complete)
  t.true(review.blocked.some(issue => issue.code === 'AEP_POINT_COLLISION'))
  t.true(review.blocked.some(issue => issue.code === 'AEP_RETIREMENT_ZONES'))
})

integration('AEP retire les anciens PP avant les créations et annule tout sur une erreur suivante', async t => {
  const f = await fixture()
  const review = await reviewAep(client, f.manifest)
  let retirementObserved = false
  const failing = {query: async (sql, parameters) => {
    if (sql.startsWith('INSERT INTO "User"')) {
      retirementObserved = Boolean((await client.query('SELECT "deletedAt" FROM "PointPrelevement" WHERE id=$1', [f.oldId])).rows[0].deletedAt)
      throw new Error('SYNTHETIC_INSERT_FAILURE')
    }
    return client.query(sql, parameters)
  }}
  await t.throwsAsync(applyAep(failing, f.manifest, review), {message: 'SYNTHETIC_INSERT_FAILURE'})
  t.true(retirementObserved)
  t.is((await reviewAep(client, f.manifest)).stateHash, review.stateHash)
  t.is((await client.query('SELECT count(*)::int AS n FROM "User" WHERE id=$1', [f.ownerId])).rows[0].n, 0)
})

integration('AEP refuse un SISEAUX déjà attribué sous un autre nom y compris supprimé', async t => {
  const f = await fixture()
  f.manifest.points[0].data.codeSISEAUX = '033001234'
  f.manifest = sign(f.manifest)
  await client.query('INSERT INTO "PointPrelevement" (id,name,"codeSISEAUX","waterBodyType","flowType","deletedAt","updatedAt") VALUES ($1,$2,$3,$4,$5,now(),now())', [randomUUID(), 'Autre captage synthétique', '033001234', 'SOUTERRAIN', 'PRELEVEMENT'])
  const review = await reviewAep(client, f.manifest)
  t.false(review.complete)
  t.true(review.blocked.some(issue => issue.code === 'AEP_POINT_COLLISION'))
})
