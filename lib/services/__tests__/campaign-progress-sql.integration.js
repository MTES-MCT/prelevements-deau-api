import process from 'node:process'
import test from 'ava'
import pg from 'pg'
import {loadCampaignListProgress} from '../campaign-progress.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'

const enabled = process.env.CAMPAIGN_PROGRESS_SQL_TESTS === '1'
const integration = enabled ? test : test.skip
const id = suffix => `10000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`

integration('la requête PostgreSQL réelle agrège les seuls couples autorisés sans charger les réponses', async t => {
  const url = requireDisposableDatabase()

  const sql = new pg.Client({connectionString: url.toString()})
  await sql.connect()
  try {
    // Table temporaire de cette connexion seulement : aucun schéma applicatif,
    // aucune migration et aucune donnée utilisateur ne sont nécessaires.
    await sql.query('CREATE TEMP TABLE "CampaignResponse" ("campaignId" uuid, "preleveurUserId" uuid, kind text, status text, "latestSubmissionId" uuid)')
    const rows = [
      [id(1), id(10), 'INDEX', 'DRAFT', id(100)],
      [id(1), id(10), 'NEEDS', 'SUBMITTED', id(101)],
      [id(1), id(11), 'INDEX', 'SUBMITTED', id(102)],
      [id(2), id(10), 'INDEX', 'SUBMITTED', id(103)],
      [id(2), id(11), 'INDEX', 'DRAFT', null],
      [id(2), id(11), 'NEEDS', 'SUBMITTED', id(104)],
      [id(3), id(10), 'INDEX', 'SUBMITTED', id(105)]
    ]
    const placeholders = rows.map((_, rowIndex) => `(${Array.from({length: 5}, (_, column) => `$${(rowIndex * 5) + column + 1}`).join(',')})`).join(',')
    await sql.query(`INSERT INTO "CampaignResponse" VALUES ${placeholders}`, rows.flat())
    const queries = []
    const client = {async $queryRaw(strings, ...values) {
      let query = strings[0]
      for (let index = 1; index < strings.length; index++) {
        query += `$${index}${strings[index]}`
      }

      queries.push({query, values})
      const result = await sql.query(query, values)
      return result.rows
    }}
    const accesses = [
      {campaign: {id: id(1), status: 'OPEN'}, targets: [{preleveurUserId: id(10)}, {preleveurUserId: id(10)}], permissions: {canFollowup: true}, scopeComplete: false},
      {campaign: {id: id(2), status: 'CLOSED'}, targets: [{preleveurUserId: id(11)}], permissions: {canFollowup: true}, scopeComplete: true},
      {campaign: {id: id(3), status: 'DRAFT'}, targets: [{preleveurUserId: id(10)}], permissions: {canFollowup: true}, scopeComplete: true}
    ]
    const progress = await loadCampaignListProgress(accesses, {client})
    t.is(queries.length, 1)
    t.is(queries[0].values.length, 1)
    t.is(progress.size, 2)
    t.deepEqual(progress.get(id(1)), {
      preleveurCount: 1, expectedCount: 2, receivedCount: 2, correctionCount: 1, scopeComplete: false,
      byKind: {INDEX: {expectedCount: 1, receivedCount: 1, correctionCount: 1}, NEEDS: {expectedCount: 1, receivedCount: 1, correctionCount: 0}}
    })
    t.deepEqual(progress.get(id(2)).byKind, {
      INDEX: {expectedCount: 1, receivedCount: 0, correctionCount: 0}, NEEDS: {expectedCount: 1, receivedCount: 1, correctionCount: 0}
    })
    const remaining = await sql.query('SELECT COUNT(*)::integer AS count FROM "CampaignResponse"')
    t.is(remaining.rows[0].count, rows.length)
  } finally {
    await sql.end()
  }
})
