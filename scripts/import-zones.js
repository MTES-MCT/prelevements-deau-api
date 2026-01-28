/* eslint-disable no-console */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.resolve(__dirname, "../prisma/fixtures/zones");

const SOURCES = [
  {
    file: "regions.geojson",
    type: "REGION",
    prefix: "reg",
    codeProperty: "code",
    nameProperty: "nom",
  },
  {
    file: "departements.geojson",
    type: "DEPARTEMENT",
    prefix: "dep",
    codeProperty: "code",
    nameProperty: "nom",
  },
];

function readGeoJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const json = JSON.parse(raw);

  if (!json || json.type !== "FeatureCollection" || !Array.isArray(json.features)) {
    throw new Error(`GeoJSON invalide: ${filePath}`);
  }
  return json;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const upsertSql = `
    INSERT INTO "Zone" (
      id,
      type,
      code,
      name,
      coordinates,
      "createdAt",
      "updatedAt"
    )
    VALUES (
      $1::uuid,
      $2::"ZoneType",
      $3::text,
      $4::text,
      ST_Multi(
        ST_MakeValid(
          ST_SetSRID(
            ST_GeomFromGeoJSON($5),
            4326
          )
        )
      )::geometry(MultiPolygon,4326),
      now(),
      now()
    )
    ON CONFLICT (type, code)
    DO UPDATE SET
      name = EXCLUDED.name,
      coordinates = EXCLUDED.coordinates,
      "updatedAt" = now()
  `;

  const client = await pool.connect();
  try {
    for (const source of SOURCES) {
      const filePath = path.join(FIXTURES_DIR, source.file);
      const geojson = readGeoJson(filePath);

      console.log(`\nImport ${source.type} depuis ${source.file}`);

      let ok = 0;
      let skipped = 0;

      await client.query("BEGIN");

      for (const feature of geojson.features) {
        const props = feature?.properties ?? {};
        const geom = feature?.geometry;

        const rawCode = props[source.codeProperty];
        const name = props[source.nameProperty];

        if (!rawCode || !name || !geom) {
          skipped++;
          continue;
        }

        const code = `${source.prefix}-${String(rawCode).trim()}`;
        const geometryJson = JSON.stringify(geom);

        await client.query(upsertSql, [
          randomUUID(),
          source.type,
          code,
          name,
          geometryJson,
        ]);

        ok++;
        if (ok % 50 === 0) {
          console.log(`  … ${ok} importés`);
        }
      }

      await client.query("COMMIT");
      console.log(`  ${ok} importés, ${skipped} ignorés`);
    }

    console.log("\nImport des zones terminé");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Erreur import zones", e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
