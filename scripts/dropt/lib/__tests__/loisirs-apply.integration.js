import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {requireDisposableDatabase} from '../../../../lib/util/test-helpers/disposable-database.js'
import {buildManifest, digest} from '../epidropt.js'
import {buildLoisirsManifest} from '../loisirs-source.js'
import {readLoisirsState, planLoisirs, applyLoisirsPlan} from '../loisirs-apply.js'

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

function sourceFixture() {
  const suffix = randomUUID()
  const epidropt = {'Points prélèvement': [], Préleveurs: [], Exploitations: []}
  for (let index = 0; index < 2; index++) {
    const row = index + 3
    const name = `LOISIR-${suffix}-${index}`
    const email = `loisir-${index}-${suffix}@example.test`
    const point = Array(38).fill(null)
    Object.assign(point, {1: name, 3: 0.4, 4: 44.6, 7: 'Eau de surface'})
    epidropt['Points prélèvement'].push({row, values: point})
    epidropt.Préleveurs.push({row, values: [null, 'Autres', email, `1234567890000${index}`, `Club synthétique ${index}`]})
    epidropt.Exploitations.push({row, values: [null, name, email, 'Loisirs']})
  }
  const previous = buildManifest({epidropt, rives: {Contrat: [], Compteur: [], Lieu: [], Affectation: []}})
  previous.exploitations = previous.exploitations.filter(row => row.source[0].row === 3)
  const {manifestHash: _hash, ...payload} = previous
  const previousManifest = {...payload, manifestHash: digest(payload)}
  const source = {name: 'loisirs-synthetic.xlsx', sha256: 'a'.repeat(64)}
  const decisions = {version: 1, sourceSha256: source.sha256, previousManifestHash: previousManifest.manifestHash,
    exploitations: epidropt.Exploitations.map(row => {
      const owner = previousManifest.declarants.find(owner => owner.emails.includes(row.values[2]))
      return {row: row.row, rowHash: digest(row.values), pointName: row.values[1], declarantKey: owner.key, declarantSiret: owner.data.siret}
    })}
  return buildLoisirsManifest({epidropt, previousManifest, decisions, source})
}

async function fixture() {
  const manifest = sourceFixture()
  for (const owner of manifest.declarants) {
    await client.query('INSERT INTO "User" (id,role,email,"updatedAt") VALUES ($1,\'DECLARANT\',$2,now())', [owner.id, owner.emails[0]])
    await client.query('INSERT INTO "Declarant" ("userId","sourceId",siret,"socialReason","declarantType","preleveurType","quickDeclarationEnabled") VALUES ($1,$2,$3,$4,\'LEGAL_PERSON\',\'AUTRE\',true)', [owner.id, owner.sourceId, owner.data.siret, owner.data.socialReason])
    for (const reference of owner.references) await client.query('INSERT INTO "ExternalReference" (id,provider,scope,kind,"externalId","declarantUserId") VALUES ($1,$2,\'epidropt\',\'DECLARANT\',$3,$4)', [randomUUID(), reference.provider, reference.externalId, owner.id])
  }
  const zoneId = randomUUID()
  await client.query('INSERT INTO "Zone" (id,code,name,type,coordinates,"updatedAt") VALUES ($1,$2,\'Zone synthétique\',\'SAGE\',ST_GeomFromText(\'MULTIPOLYGON(((0 44,1 44,1 45,0 45,0 44)))\',4326),now())', [zoneId, `sage-${zoneId}`])
  for (const point of manifest.points) {
    await client.query('INSERT INTO "PointPrelevement" (id,name,"sourceId","waterBodyType","flowType","collectionMode",coordinates,"updatedAt") VALUES ($1,$2,$3,\'SUPERFICIELLE\',\'PRELEVEMENT\',\'MANUAL\',ST_SetSRID(ST_MakePoint(0.4,44.6),4326),now())', [point.id, point.data.name, point.sourceId])
    await client.query('INSERT INTO "PointPrelevementZone" (id,"pointPrelevementId","zoneId") VALUES ($1,$2,$3)', [randomUUID(), point.id, zoneId])
    for (const reference of point.references) await client.query('INSERT INTO "ExternalReference" (id,provider,scope,kind,"externalId","pointPrelevementId") VALUES ($1,$2,\'epidropt\',\'POINT\',$3,$4)', [randomUUID(), reference.provider, reference.externalId, point.id])
  }
  const existing = manifest.exploitations.find(row => row.source[0].row === 3)
  const missing = manifest.exploitations.find(row => row.source[0].row === 4)
  await client.query('INSERT INTO "DeclarantPointPrelevement" (id,"sourceId","pointPrelevementId","declarantUserId","usageId",status,"excludeFromQuickDeclaration","updatedAt") SELECT $1,$2,$3,$4,id,\'NON_RENSEIGNE\',true,now() FROM "SandreWaterUse" WHERE code=\'7\'', [existing.id, existing.sourceId, existing.pointId, existing.declarantId])
  await client.query('INSERT INTO "DeclarantZone" (id,"declarantUserId","zoneId",source,"updatedAt") VALUES ($1,$2,$3,\'MANUAL\',now())', [randomUUID(), existing.declarantId, zoneId])
  await client.query('INSERT INTO "DeclarantPointPrelevementSecondaryUsage" ("exploitationId","usageId") SELECT $1,id FROM "SandreWaterUse" WHERE code=\'2\'', [existing.id])
  const collectorId = randomUUID()
  await client.query('INSERT INTO "User" (id,role,"updatedAt") VALUES ($1,\'DECLARANT\',now())', [collectorId])
  await client.query('INSERT INTO "Declarant" ("userId","declarantRole") VALUES ($1,\'COLLECTEUR\')', [collectorId])
  const campaignId = randomUUID()
  await client.query('INSERT INTO "CollectionCampaign" (id,name,status,"collecteurUserId","createdByUserId","updatedAt") VALUES ($1,\'Campagne synthétique préexistante\',\'OPEN\',$2,$2,now())', [campaignId, collectorId])
  await client.query('INSERT INTO "CollectionResponse" (id,"campaignId","exploitationId","preleveurUserId","draftData",revision,"updatedAt") VALUES ($1,$2,$3,$4,\'{"synthetic":true}\',3,now())', [randomUUID(), campaignId, existing.id, existing.declarantId])
  const meterId = randomUUID()
  await client.query('INSERT INTO "Compteur" (id,"serialNumber","updatedAt") VALUES ($1,$2,now())', [meterId, `SYNTHETIC-${meterId}`])
  await client.query('INSERT INTO "MeterReading" (id,"compteurId","observedAt","lastFetchedAt","currentMode") VALUES ($1,$2,\'2026-09-01T00:00:00Z\',\'2026-09-02T00:00:00Z\',\'OFFLINE\')', [randomUUID(), meterId])
  return {manifest, existing, missing, zoneId, collectorId, campaignId, meterId}
}

async function plan(fixture) {
  return planLoisirs(fixture.manifest, await readLoisirsState(client, fixture.manifest))
}

async function preservedTables() {
  const tables = {}
  for (const table of ['User', 'Declarant', 'PointPrelevement', 'PointPrelevementZone', 'Compteur', 'MeterReading', 'MeterAllocation', 'Chunk', 'CollectionCampaign', 'CollectionResponse', 'DeclarantCollecteurExploitation']) {
    tables[table] = (await client.query(`SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`, [])).rows
  }
  return tables
}

integration('Loisirs complète le lien absent, active les deux saisies et conserve identités, campagne et compteurs ; rejeu strictement nul', async t => {
  const f = await fixture()
  const before = await readLoisirsState(client, f.manifest)
  const preserved = await preservedTables()
  const review = planLoisirs(f.manifest, before)
  t.deepEqual(review.blocked, [])
  t.is(review.changes.filter(row => row.action === 'CREATE_EXPLOITATION').length, 1)
  t.is(review.changes.filter(row => row.action === 'ENABLE_QUICK_DECLARATION').length, 1)
  t.is(review.changes.filter(row => row.action === 'ADD_ZONE').length, 1)
  t.is((await readLoisirsState(client, f.manifest)).stateHash, before.stateHash)
  await applyLoisirsPlan(client, review)
  const after = await readLoisirsState(client, f.manifest)
  t.is(after.tables.DeclarantPointPrelevement.length, 2)
  t.true(after.tables.DeclarantPointPrelevement.every(row => row.excludeFromQuickDeclaration === false))
  t.deepEqual(after.tables.DeclarantPointPrelevementSecondaryUsage, before.tables.DeclarantPointPrelevementSecondaryUsage)
  t.deepEqual(await preservedTables(), preserved)
  t.is(after.tables.DeclarantZone.length, 2)
  t.deepEqual(after.tables.CollectionResponse, before.tables.CollectionResponse)
  const replay = planLoisirs(f.manifest, after)
  t.deepEqual(replay.blocked, [])
  t.deepEqual(replay.changes, [])
  await applyLoisirsPlan(client, replay)
  t.is((await readLoisirsState(client, f.manifest)).stateHash, after.stateHash)
  t.deepEqual(await preservedTables(), preserved)
})

integration('Loisirs refuse toute collision de principal, point, propriétaire ou source existante', async t => {
  const f = await fixture()
  // Campaign responses independently prevent identity edits at database level.
  // Remove only this synthetic response to exercise the importer's own guard.
  await client.query('DELETE FROM "CollectionResponse" WHERE "campaignId"=$1', [f.campaignId])
  const mutations = [
    ['UPDATE "DeclarantPointPrelevement" SET "usageId"=(SELECT id FROM "SandreWaterUse" WHERE code=\'17\') WHERE id=$1', [f.existing.id]],
    ['UPDATE "DeclarantPointPrelevement" SET "pointPrelevementId"=$2 WHERE id=$1', [f.existing.id, f.missing.pointId]],
    ['UPDATE "DeclarantPointPrelevement" SET "declarantUserId"=$2 WHERE id=$1', [f.existing.id, f.missing.declarantId]],
    ['UPDATE "DeclarantPointPrelevement" SET "sourceId"=$2 WHERE id=$1', [f.existing.id, `manual:${randomUUID()}`]]
  ]
  for (const [sql, parameters] of mutations) {
    await client.query('SAVEPOINT collision')
    await client.query(sql, parameters)
    const state = await readLoisirsState(client, f.manifest)
    const review = planLoisirs(f.manifest, state)
    t.true(review.blocked.some(row => row.code === 'LOISIRS_EXPLOITATION_COLLISION'))
    await t.throwsAsync(applyLoisirsPlan(client, review), {message: 'LOISIRS_PLAN_BLOCKED'})
    t.is((await readLoisirsState(client, f.manifest)).stateHash, state.stateHash)
    await client.query('ROLLBACK TO SAVEPOINT collision')
  }
})

integration('Loisirs conserve une exclusion manuelle après journalisation sans recréer ni réactiver', async t => {
  const f = await fixture()
  await applyLoisirsPlan(client, await plan(f))
  await client.query('UPDATE "DeclarantPointPrelevement" SET "excludeFromQuickDeclaration"=true WHERE id=$1', [f.existing.id])
  const before = await readLoisirsState(client, f.manifest)
  const review = planLoisirs(f.manifest, before)
  t.true(review.blocked.some(row => row.id === f.existing.id && row.code === 'LOISIRS_MANUAL_CHANGE_PRESERVED'))
  await t.throwsAsync(applyLoisirsPlan(client, review), {message: 'LOISIRS_PLAN_BLOCKED'})
  t.is((await readLoisirsState(client, f.manifest)).stateHash, before.stateHash)
})

integration('Loisirs bloque tout collecteur, connecteur ou compteur rattaché sans modifier le lien', async t => {
  const f = await fixture()
  const mutations = [
    ['INSERT INTO "DeclarantCollecteurExploitation" (id,"collecteurUserId","exploitationId","updatedAt") VALUES ($1,$2,$3,now())', [randomUUID(), f.collectorId, f.existing.id]],
    ['INSERT INTO "DeclarantPointPrelevementConnector" (id,"declarantPointPrelevementId","connectorType","updatedAt") VALUES ($1,$2,\'synthetic\',now())', [randomUUID(), f.existing.id]],
    ['INSERT INTO "MeterAllocation" (id,"sourceId",provider,scope,"compteurId","exploitationId") VALUES ($1,$2,\'synthetic\',\'synthetic\',$3,$4)', [randomUUID(), `synthetic:${randomUUID()}`, f.meterId, f.existing.id]]
  ]
  for (const [sql, parameters] of mutations) {
    await client.query('SAVEPOINT external_link')
    await client.query(sql, parameters)
    const before = await readLoisirsState(client, f.manifest)
    const review = planLoisirs(f.manifest, before)
    t.true(review.blocked.some(row => row.id === f.existing.id && row.code === 'LOISIRS_EXTERNAL_LINK_REVIEW_REQUIRED'))
    await t.throwsAsync(applyLoisirsPlan(client, review), {message: 'LOISIRS_PLAN_BLOCKED'})
    t.is((await readLoisirsState(client, f.manifest)).stateHash, before.stateHash)
    await client.query('ROLLBACK TO SAVEPOINT external_link')
  }
})

integration('Loisirs ne ressuscite ni point ni compte supprimé et refuse les ancrages altérés', async t => {
  const f = await fixture()
  const mutations = [
    ['UPDATE "PointPrelevement" SET "deletedAt"=now() WHERE id=$1', [f.missing.pointId], 'LOISIRS_POINT_ANCHOR_REQUIRED'],
    ['UPDATE "User" SET "deletedAt"=now() WHERE id=$1', [f.missing.declarantId], 'LOISIRS_DECLARANT_ANCHOR_REQUIRED'],
    ['UPDATE "Declarant" SET siret=\'99999999999999\' WHERE "userId"=$1', [f.missing.declarantId], 'LOISIRS_DECLARANT_ANCHOR_REQUIRED']
  ]
  for (const [sql, parameters, code] of mutations) {
    await client.query('SAVEPOINT anchor')
    await client.query(sql, parameters)
    const before = await readLoisirsState(client, f.manifest)
    const review = planLoisirs(f.manifest, before)
    t.true(review.blocked.some(row => row.code === code))
    await t.throwsAsync(applyLoisirsPlan(client, review), {message: 'LOISIRS_PLAN_BLOCKED'})
    t.is((await readLoisirsState(client, f.manifest)).stateHash, before.stateHash)
    await client.query('ROLLBACK TO SAVEPOINT anchor')
  }
})

integration('Loisirs ne recrée pas une exploitation supprimée après une application journalisée', async t => {
  const f = await fixture()
  await applyLoisirsPlan(client, await plan(f))
  await client.query('DELETE FROM "DeclarantPointPrelevement" WHERE id=$1', [f.missing.id])
  const before = await readLoisirsState(client, f.manifest)
  const review = planLoisirs(f.manifest, before)
  t.true(review.blocked.some(row => row.id === f.missing.id && row.code === 'LOISIRS_MANUAL_CHANGE_PRESERVED'))
  t.false(review.changes.some(row => row.action === 'CREATE_EXPLOITATION'))
  await t.throwsAsync(applyLoisirsPlan(client, review), {message: 'LOISIRS_PLAN_BLOCKED'})
  t.is((await readLoisirsState(client, f.manifest)).stateHash, before.stateHash)
})

integration('Loisirs lit son état dans une transaction réellement en lecture seule', async t => {
  const manifest = sourceFixture()
  await client.query('ROLLBACK')
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const before = await readLoisirsState(client, manifest)
  const review = planLoisirs(manifest, before)
  t.true(review.blocked.some(row => row.code === 'LOISIRS_POINT_ANCHOR_REQUIRED'))
  t.is((await readLoisirsState(client, manifest)).stateHash, before.stateHash)
})

integration('Loisirs refuse les références exactes réattribuées à un point ou un propriétaire hors manifeste', async t => {
  const f = await fixture()
  const outsidePointId = randomUUID()
  const outsideOwnerId = randomUUID()
  await client.query('INSERT INTO "PointPrelevement" (id,name,"waterBodyType","flowType","updatedAt") VALUES ($1,\'Point extérieur synthétique\',\'SUPERFICIELLE\',\'PRELEVEMENT\',now())', [outsidePointId])
  await client.query('INSERT INTO "User" (id,role,"updatedAt") VALUES ($1,\'DECLARANT\',now())', [outsideOwnerId])
  await client.query('INSERT INTO "Declarant" ("userId","preleveurType") VALUES ($1,\'AUTRE\')', [outsideOwnerId])
  const mutations = [
    ['pointPrelevementId', f.missing.pointId, outsidePointId, 'LOISIRS_POINT_ANCHOR_REQUIRED'],
    ['declarantUserId', f.missing.declarantId, outsideOwnerId, 'LOISIRS_DECLARANT_ANCHOR_REQUIRED']
  ]
  for (const [field, selectedId, outsideId, code] of mutations) {
    await client.query('SAVEPOINT reference')
    await client.query(`UPDATE "ExternalReference" SET "${field}"=$2 WHERE "${field}"=$1 AND provider='epidropt'`, [selectedId, outsideId])
    const before = await readLoisirsState(client, f.manifest)
    t.true(before.tables.ExternalReference.some(row => row[field] === outsideId))
    const review = planLoisirs(f.manifest, before)
    t.true(review.blocked.some(row => row.id === selectedId && row.code === code))
    await t.throwsAsync(applyLoisirsPlan(client, review), {message: 'LOISIRS_PLAN_BLOCKED'})
    t.is((await readLoisirsState(client, f.manifest)).stateHash, before.stateHash)
    await client.query('ROLLBACK TO SAVEPOINT reference')
  }
})

integration('Loisirs préserve le retrait manuel d’une zone après journalisation', async t => {
  const f = await fixture()
  await applyLoisirsPlan(client, await plan(f))
  await client.query('DELETE FROM "DeclarantZone" WHERE "declarantUserId"=$1 AND "zoneId"=$2', [f.missing.declarantId, f.zoneId])
  const before = await readLoisirsState(client, f.manifest)
  const review = planLoisirs(f.manifest, before)
  t.true(review.blocked.some(row => row.id === f.missing.id && row.code === 'LOISIRS_MANUAL_CHANGE_PRESERVED'))
  t.false(review.changes.some(row => row.action === 'ADD_ZONE'))
  await t.throwsAsync(applyLoisirsPlan(client, review), {message: 'LOISIRS_PLAN_BLOCKED'})
  t.is((await readLoisirsState(client, f.manifest)).stateHash, before.stateHash)
})
