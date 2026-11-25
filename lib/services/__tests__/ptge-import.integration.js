import process from 'node:process'
import pg from 'pg'
import test from 'ava'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {importPtge} from '../ptge-import.js'

const integration = process.env.DROPT_INTEGRATION_TESTS === '1' ? test.serial : test.skip
const ring = (xmin, xmax) => [[xmin, 0], [xmax, 0], [xmax, 1], [xmin, 1], [xmin, 0]]
const polygon = (...rings) => ({type: 'Polygon', coordinates: rings})
const zone = (code, geometry) => ({code, name: `Projet ${code}`, progressStatus: 'Emergence', geometry})

integration('import PTGE, chevauchements, corrections, retraits et rejeu sur PostGIS', async t => {
  requireDisposableDatabase()
  const client = new pg.Client({connectionString: process.env.DATABASE_URL})
  await client.connect()
  t.teardown(() => client.end())
  // Isolate complete national snapshot reconciliation from other test shards.
  for (const table of ['Zone', 'PointPrelevement', 'PointPrelevementZone']) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(`CREATE TEMP TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`)
  }
  await client.query(`
    INSERT INTO "PointPrelevement" (id,name,"waterBodyType","flowType",coordinates,"updatedAt")
    SELECT gen_random_uuid(), name, 'SUPERFICIELLE', 'PRELEVEMENT', ST_SetSRID(ST_MakePoint(x, 0.5), 4326), now()
    FROM (VALUES ('commun',1.0), ('îlot',4.5), ('extérieur',12.0)) p(name,x);
    INSERT INTO "Zone" (id,type,code,name,coordinates,"managedResourceType","updatedAt")
    VALUES (gen_random_uuid(),'SAGE','sage-SAGE01001','SAGE', ST_GeomFromText('MULTIPOLYGON(((0 0,5 0,5 1,0 1,0 0)))',4326),'MIXTE',now());
    INSERT INTO "PointPrelevementZone" (id,"pointPrelevementId","zoneId")
    SELECT gen_random_uuid(),p.id,z.id FROM "PointPrelevement" p, "Zone" z WHERE p.name = 'commun';
  `)
  const records = [zone('SAGE01001', polygon(ring(0, 1), ring(4, 5))), zone('PTGE02', polygon(ring(1, 2))), zone('PTGE03', null)]
  const run = (rows, apply = true) => importPtge(client, {apply, loadSnapshot: async () => rows})
  const links = async () => (await client.query(`
    SELECT p.name || '/' || z.code AS link FROM "PointPrelevementZone" l
    JOIN "PointPrelevement" p ON p.id = l."pointPrelevementId" JOIN "Zone" z ON z.id = l."zoneId" ORDER BY link
  `)).rows.map(row => row.link)
  const initial = await links()
  const preview = await run(records, false)
  t.deepEqual(await links(), initial)
  t.deepEqual(preview.repairedContours, ['SAGE01001'])
  t.deepEqual(preview.withoutContour, [{code: 'PTGE03', name: 'Projet PTGE03'}])
  t.deepEqual((await run(records)).links, {added: 3, removed: 0})
  const shared = ['commun/ptge-PTGE02', 'commun/ptge-SAGE01001', ...initial, 'îlot/ptge-SAGE01001']
  t.deepEqual((await links()).sort(), shared.sort())
  const before = (await client.query('SELECT id, "updatedAt" FROM "Zone" ORDER BY id')).rows
  const replay = await run(records)
  t.deepEqual(replay.links, {added: 0, removed: 0})
  t.is(replay.zones.updated + replay.zones.created, 0)
  t.deepEqual((await client.query('SELECT id, "updatedAt" FROM "Zone" ORDER BY id')).rows, before)

  const changed = [{...records[0], geometry: polygon(ring(10, 13)), progressStatus: 'Révision'}, ...records.slice(1)]
  t.deepEqual((await run(changed)).links, {added: 1, removed: 2})
  t.deepEqual((await links()).sort(), ['commun/ptge-PTGE02', ...initial, 'extérieur/ptge-SAGE01001'].sort())
  const invalid = [{...records[0], geometry: polygon(ring(0, 0))}, ...records.slice(1)]
  await t.throwsAsync(run(invalid), {message: /inutilisables/})
  t.is((await client.query('SELECT "progressStatus" FROM "Zone" WHERE "sourceCode" = $1', ['SAGE01001'])).rows[0].progressStatus, 'Révision')
  // A lost contour and a project removed from the catalogue both keep their local UUID.
  const retired = await run([zone('PTGE02', null), records[2]])
  t.deepEqual(retired.zones.withdrawnContours, ['PTGE02', 'SAGE01001'])
  t.deepEqual(await links(), initial)
  t.is((await client.query('SELECT count(*)::int AS n FROM "Zone" WHERE type = \'PTGE\' AND coordinates IS NULL')).rows[0].n, 2)
  t.deepEqual((await client.query('SELECT id FROM "Zone" ORDER BY id')).rows.map(row => row.id), before.map(row => row.id))
})
