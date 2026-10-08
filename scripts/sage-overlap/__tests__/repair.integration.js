import test from 'ava'
import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {requireDisposableDatabase} from '../../../lib/util/test-helpers/disposable-database.js'
import {applyRepair, fingerprint, readState, reviewRepair, rollbackRepair, validateReceipt} from '../lib/repair.js'

const enabled = process.env.SAGE_OVERLAP_INTEGRATION_TESTS === '1' || process.env.DROPT_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
const schema = `sage_overlap_${randomUUID().replaceAll('-', '')}`
let client

test.before(async () => {
  if (!enabled) return
  requireDisposableDatabase()
  client = new pg.Client({connectionString: process.env.DATABASE_URL})
  await client.connect()
  await client.query(`CREATE SCHEMA ${schema}`)
  await client.query('SELECT set_config(\'search_path\', $1, false)', [`${schema}, public`])
  await client.query(`
    CREATE TABLE "Zone" (id uuid PRIMARY KEY, code text UNIQUE NOT NULL, type text NOT NULL,
      "managedResourceType" text, coordinates geometry(MultiPolygon,4326), "updatedAt" timestamp(6) NOT NULL);
    CREATE TABLE "PointPrelevement" (id uuid PRIMARY KEY, "waterBodyType" text, coordinates geometry(Point,4326),
      "deletedAt" timestamp(6), "updatedAt" timestamp(6) NOT NULL);
    CREATE TABLE "PointPrelevementZone" (id uuid PRIMARY KEY, "pointPrelevementId" uuid NOT NULL REFERENCES "PointPrelevement",
      "zoneId" uuid NOT NULL REFERENCES "Zone", "createdAt" timestamp(6) NOT NULL, UNIQUE("pointPrelevementId", "zoneId"))
  `)
})

test.after.always(async () => {
  if (!client) return
  try { await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`) } finally { await client.end() }
})

async function fixture() {
  await client.query('TRUNCATE "PointPrelevementZone", "PointPrelevement", "Zone"')
  const zones = ['sage-SAGE06028', 'sage-SAGE06030', 'synthetic-department'].map(code => ({id: randomUUID(), code}))
  for (const zone of zones) {
    await client.query(`INSERT INTO "Zone" VALUES ($1, $2, $3, 'MIXTE',
      ST_GeomFromText('MULTIPOLYGON(((9 49,11 49,11 51,9 51,9 49)))',4326), '2026-01-01 00:00:00.000001')`,
    [zone.id, zone.code, zone.code.startsWith('sage-') ? 'SAGE' : 'DEPARTEMENT'])
  }
  const pointId = randomUUID()
  await client.query(`INSERT INTO "PointPrelevement"
    VALUES ($1, 'SUPERFICIELLE', ST_SetSRID(ST_MakePoint(10,50),4326), NULL, '2026-01-01 00:00:00.000001')`, [pointId])
  for (const zone of zones) {
    await client.query('INSERT INTO "PointPrelevementZone" VALUES ($1,$2,$3,$4)', [randomUUID(), pointId, zone.id, '2026-01-01 00:00:00.123456'])
  }
  return {zones, pointId}
}

const target = 'local'
const persistPrepared = async () => {}

integration('revue lecture seule, application bornée, rejeu zéro et restauration exacte avec microsecondes', async t => {
  await fixture()
  const before = await readState(client)
  const review = await reviewRepair(client, {target})
  t.is(review.summary.changed, 1)
  t.deepEqual(await readState(client), before)
  let prepared
  const receipt = await applyRepair(client, review, {target, persistPrepared: async value => { prepared = value }})
  t.is(prepared.status, 'PREPARED')
  t.is(receipt.status, 'COMMITTED')
  t.is(validateReceipt(receipt, target), receipt)
  t.is(receipt.summary.changed, 1)
  t.is((await reviewRepair(client, {target})).summary.changed, 0)
  const replay = await applyRepair(client, review, {target, persistPrepared})
  t.is(replay.summary.changed, 0)
  t.is((await rollbackRepair(client, replay, {target, persistPrepared})).summary.changed, 0)
  const rollback = await rollbackRepair(client, receipt, {target, persistPrepared})
  t.is(rollback.summary.changed, 1)
  t.deepEqual(await readState(client), before)
  t.is((await rollbackRepair(client, receipt, {target, persistPrepared})).summary.changed, 0)
})

integration('ajout de lien manquant et récupération du reçu PREPARED après confirmation de l’état commis', async t => {
  const {zones, pointId} = await fixture()
  await client.query('DELETE FROM "PointPrelevementZone" WHERE "pointPrelevementId"=$1 AND "zoneId"=$2', [pointId, zones[1].id])
  const before = await readState(client)
  const review = await reviewRepair(client, {target})
  let prepared
  await applyRepair(client, review, {target, persistPrepared: async value => { prepared = value }})
  t.is((await rollbackRepair(client, prepared, {target, persistPrepared})).summary.changed, 1)
  t.deepEqual(await readState(client), before)
})

integration('échec de persistance du reçu annule toute mutation SQL', async t => {
  await fixture()
  const before = await readState(client)
  const review = await reviewRepair(client, {target})
  await t.throwsAsync(applyRepair(client, review, {target, persistPrepared: async () => { throw new Error('synthetic filesystem failure') }}))
  t.deepEqual(await readState(client), before)
})

integration('dérives coordonnées, milieu, géométrie, réglage, liens et nouveau troisième SAGE bloquent avant écriture', async t => {
  const mutations = [
    'UPDATE "PointPrelevement" SET coordinates=ST_SetSRID(ST_MakePoint(10.1,50),4326)',
    'UPDATE "PointPrelevement" SET "waterBodyType"=\'SOUTERRAIN\'',
    'UPDATE "Zone" SET coordinates=ST_Translate(coordinates,0.01,0) WHERE type=\'SAGE\'',
    'UPDATE "Zone" SET "managedResourceType"=\'SOUTERRAIN\' WHERE type=\'SAGE\'',
    'UPDATE "PointPrelevementZone" SET "createdAt"="createdAt" + interval \'1 microsecond\'',
    `INSERT INTO "Zone" SELECT '${randomUUID()}', 'sage-synthetic-third', type, "managedResourceType", coordinates, "updatedAt" FROM "Zone" WHERE type='SAGE' LIMIT 1`
  ]
  for (const query of mutations) {
    await fixture()
    const review = await reviewRepair(client, {target})
    await client.query(query)
    const drifted = await readState(client)
    const error = await t.throwsAsync(applyRepair(client, review, {target, persistPrepared}))
    t.regex(error.message, /Dérive/)
    t.deepEqual(await readState(client), drifted)
  }
})

integration('dérive après application interdit le rollback', async t => {
  await fixture()
  const receipt = await applyRepair(client, await reviewRepair(client, {target}), {target, persistPrepared})
  await client.query('UPDATE "PointPrelevement" SET "waterBodyType"=\'SOUTERRAIN\'')
  const state = await readState(client)
  await t.throwsAsync(rollbackRepair(client, receipt, {target, persistPrepared}), {message: /Dérive/})
  t.deepEqual(await readState(client), state)
})

integration('points supprimés, sans coordonnées et troisième SAGE existant restent inchangés', async t => {
  for (const kind of ['deleted', 'missing', 'third']) {
    const {zones, pointId} = await fixture()
    if (kind === 'deleted') await client.query('UPDATE "PointPrelevement" SET "deletedAt"=now()')
    if (kind === 'missing') await client.query('UPDATE "PointPrelevement" SET coordinates=NULL')
    if (kind === 'third') {
      const zoneId = randomUUID()
      await client.query('INSERT INTO "Zone" SELECT $1, \'sage-synthetic-third\', type, \'SOUTERRAIN\', ST_Translate(coordinates,30,0), "updatedAt" FROM "Zone" WHERE id=$2', [zoneId, zones[0].id])
      await client.query('INSERT INTO "PointPrelevementZone" VALUES ($1,$2,$3,now())', [randomUUID(), pointId, zoneId])
    }
    const before = await readState(client)
    const review = await reviewRepair(client, {target})
    t.is(review.summary.changed, 0)
    t.is(review.summary.exceptions, 1)
    const receipt = await applyRepair(client, review, {target, persistPrepared})
    t.is(receipt.summary.changed, 0)
    t.is(fingerprint(await readState(client)), fingerprint(before))
  }
})

integration('les verrous empêchent une écriture concurrente avant la validation durable du reçu', async t => {
  await fixture()
  const writer = new pg.Client({connectionString: process.env.DATABASE_URL})
  await writer.connect()
  try {
    await writer.query('SELECT set_config(\'search_path\', $1, false)', [`${schema}, public`])
    await writer.query("SET lock_timeout = '100ms'")
    const review = await reviewRepair(client, {target})
    const receipt = await applyRepair(client, review, {target, persistPrepared: async () => {
      const error = await t.throwsAsync(writer.query('UPDATE "PointPrelevement" SET "waterBodyType"=\'SOUTERRAIN\''))
      t.is(error.code, '55P03')
    }})
    t.is(receipt.summary.changed, 1)
  } finally {
    await writer.end()
  }
})
