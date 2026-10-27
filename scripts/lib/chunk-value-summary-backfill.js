const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function transaction(client, apply, run) {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    await client.query("SET LOCAL lock_timeout = '3s'")
    await client.query("SET LOCAL statement_timeout = '30s'")
    const result = await run()
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

async function inventory(client) {
  return transaction(client, false, async () => {
    const {rows: [row]} = await client.query(`
      SELECT count(*)::integer AS total,
        count(*) FILTER (WHERE s."chunkId" IS NULL OR NOT s.valid OR s."formatVersion" <> 1)::integer AS remaining
      FROM "Chunk" c LEFT JOIN "ChunkValueSummary" s ON s."chunkId" = c.id
    `)
    return row
  })
}

// The caller owns connection identity/TLS attestation. Only derived summaries
// are written, in bounded transactions; a replay skips valid summaries.
export async function backfillChunkValueSummaries(client, {
  apply = false, batchSize = 25, maxBatches = 1000, after = null, onProgress = () => {}
} = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100
    || !Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 10000
    || (after !== null && !UUID.test(after))) {
    throw new Error('Paramètres de reprise invalides.')
  }
  const before = await inventory(client)
  const report = {apply, before, batches: 0, refreshed: 0, cursor: after}
  if (!apply) return {...report, after: before, complete: before.remaining === 0}

  for (let index = 0; index < maxBatches; index++) {
    const batch = await transaction(client, true, async () => {
      const {rows} = await client.query(`
        SELECT c.id FROM "Chunk" c
        LEFT JOIN "ChunkValueSummary" s ON s."chunkId" = c.id
        WHERE ($1::uuid IS NULL OR c.id > $1::uuid)
          AND (s."chunkId" IS NULL OR NOT s.valid OR s."formatVersion" <> 1)
        ORDER BY c.id LIMIT $2
      `, [report.cursor, batchSize])
      if (!rows.length) return null
      const {rows: [result]} = await client.query(
        'SELECT refresh_chunk_value_summaries($1::uuid[]) AS refreshed', [rows.map(row => row.id)]
      )
      return {refreshed: result.refreshed, cursor: rows.at(-1).id}
    })
    if (!batch) break
    report.batches++
    report.refreshed += batch.refreshed
    report.cursor = batch.cursor
    // Emit only committed progress, so this cursor is safe to resume after a
    // timeout. A final replay without a cursor catches concurrent invalidations.
    await onProgress({...report})
  }
  const afterInventory = await inventory(client)
  return {...report, after: afterInventory, complete: afterInventory.remaining === 0}
}
