import process from 'node:process'
import {randomUUID} from 'node:crypto'
import pg from 'pg'
import test from 'ava'
import {requireDisposableDatabase} from '../../../lib/util/test-helpers/disposable-database.js'
import {normalizeManifest} from '../manifest.js'
import {buildPlan} from '../plan.js'
import {readInventory, applyPlan} from '../database.js'
import {manifestInput} from '../fixtures/synthetic.js'

const integration = process.env.EVELER_INTEGRATION_TESTS === '1' ? test.serial : test.skip

integration('PostGIS initialization, identity trigger, replay, existing drafts and unrelated links', async t => {
  requireDisposableDatabase()
  const client = new pg.Client({connectionString: process.env.DATABASE_URL})
  await client.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    const suffix = randomUUID()
    const input = structuredClone(manifestInput)
    input.point.name += ` ${suffix}`
    input.point.sourceId += `-${suffix}`
    input.point.identifiers.DDT += `-${suffix}`
    input.preleveur.companyName += ` ${suffix}`
    input.preleveur.email = `${suffix}@example.test`
    input.connector.sourcePointId += `-${suffix}`
    const manifest = normalizeManifest(input)
    const zoneId = randomUUID()
    await client.query(`INSERT INTO "Zone" (id, code, type, name, coordinates, "updatedAt")
      VALUES ($1::uuid, $1, 'DEPARTEMENT', 'Zone synthétique',
        ST_Multi(ST_Buffer(ST_Transform(ST_SetSRID(ST_MakePoint(700000, 6600000), 2154), 4326), 0.01)), now())`, [zoneId])
    const before = await readInventory(client, manifest)
    t.is(before.usage.kind, 'SUB_USAGE')
    t.is(before.usage.parentCode, '7')
    t.true(buildPlan(manifest, before).actions.includes('create-point'))
    await applyPlan(client, manifest, before)
    const after = await readInventory(client, manifest)
    const verified = buildPlan(manifest, after)
    t.deepEqual(verified.actions, [])
    t.is(after.emailIdentity.primaryUserId, verified.ids.userId)
    t.true(after.points[0].coordinateDistance < 0.001)
    t.is(after.exploitations[0].startDate, null)
    t.is(after.exploitations[0].endDate, null)
    t.is(after.exploitations[0].status, 'EN_ACTIVITE')
    t.is(after.exploitations[0].usageId, before.usage.parentId)
    t.is(after.exploitations[0].comment, 'Usage SANDRE : 7E — Canon à neige.')
    t.is(after.points[0].usageName, 'Canon à neige')
    const draftId = randomUUID()
    await client.query(`INSERT INTO "Declaration" (id, code, "declarantUserId", type, "waterWithdrawalType", comment, "updatedAt")
      VALUES ($1::uuid, $2, $3::uuid, 'SYNTHETIC', 'SOUTERRAIN', 'Brouillon conservé', now())`,
    [draftId, suffix.slice(0, 6), verified.ids.userId])
    await client.query('UPDATE "PointPrelevement" SET "internalComment" = $2 WHERE id = $1::uuid', [verified.ids.pointId, 'Conservé'])
    const manualZoneId = randomUUID()
    await client.query(`INSERT INTO "Zone" (id, code, type, name, coordinates, "updatedAt")
      VALUES ($1::uuid, $1, 'DEPARTEMENT', 'Zone manuelle synthétique',
        ST_GeomFromText('MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)))', 4326), now())`, [manualZoneId])
    await client.query('INSERT INTO "PointPrelevementZone" (id, "pointPrelevementId", "zoneId") VALUES ($1::uuid, $2::uuid, $3::uuid)', [randomUUID(), verified.ids.pointId, manualZoneId])
    const replayBefore = await readInventory(client, manifest)
    t.deepEqual((await applyPlan(client, manifest, replayBefore)).actions, [])
    t.deepEqual(buildPlan(manifest, await readInventory(client, manifest)).actions, [])
    t.true((await readInventory(client, manifest)).pointZones.includes(manualZoneId))
    t.is((await client.query('SELECT comment FROM "Declaration" WHERE id = $1::uuid', [draftId])).rows[0].comment, 'Brouillon conservé')
    t.is((await client.query('SELECT "internalComment" FROM "PointPrelevement" WHERE id = $1::uuid', [verified.ids.pointId])).rows[0].internalComment, 'Conservé')
    await client.query('UPDATE "Declarant" SET siret = $2 WHERE "userId" = $1::uuid', [verified.ids.userId, '11111111111111'])
    t.throws(() => buildPlan(manifest, {...replayBefore, users: replayBefore.users.map(user => ({...user, siret: '11111111111111'}))}), {message: /^PRELEVEUR_CONFLICT/})
    await t.throwsAsync(applyPlan(client, manifest, await readInventory(client, manifest)), {message: /^PRELEVEUR_CONFLICT/})
  } finally {
    await client.query('ROLLBACK')
    await client.end()
  }
})
