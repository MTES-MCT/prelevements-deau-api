import {prisma} from '../../db/prisma.js'
import {isNativeTemporal} from '../util/native-temporal.js'
import {loadChunkValueCounts} from './chunk-value-summaries.js'

// Load only after source/chunk permissions have been applied. A nested Prisma
// relation count can aggregate the entire ChunkValue table before joining chunks.
export async function loadSourceChunkValues(sources, {client = prisma, includeLegacyValues = false} = {}) {
  const chunks = sources.filter(Boolean).flatMap(source => source.chunks ?? [])
  const chunkIds = [...new Set(chunks.map(chunk => chunk.id))]
  if (chunkIds.length === 0) return sources

  const legacyIds = includeLegacyValues
    ? [...new Set(chunks.filter(chunk => !isNativeTemporal(chunk.metadata)).map(chunk => chunk.id))]
    : []
  const [countsByChunk, values] = await Promise.all([
    loadChunkValueCounts(chunkIds, {client}),
    legacyIds.length > 0
      ? client.chunkValue.findMany({where: {chunkId: {in: legacyIds}}, orderBy: {periodEnd: 'asc'}})
      : []
  ])
  const valuesByChunk = new Map()
  for (const value of values) {
    const group = valuesByChunk.get(value.chunkId) ?? []
    group.push(value)
    valuesByChunk.set(value.chunkId, group)
  }
  for (const chunk of chunks) {
    chunk._count = {...chunk._count, chunkValues: countsByChunk.get(chunk.id) ?? 0}
    if (includeLegacyValues) chunk.chunkValues = valuesByChunk.get(chunk.id) ?? []
  }
  return sources
}
