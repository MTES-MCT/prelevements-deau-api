/* eslint-disable no-await-in-loop -- Stream the stored series with bounded memory. */
import {nativeConflicts} from '../declaration-importer/native-conflicts.js'

export async function hasNativeAssociationConflict(client, {chunk, pointPrelevementId, preleveurUserId}) {
  let cursor
  while (true) {
    const values = await client.chunkValue.findMany({where: {chunkId: chunk.id},
      orderBy: {id: 'asc'}, take: 2000, ...(cursor ? {cursor: {id: cursor}, skip: 1} : {}),
      select: {id: true, metricTypeCode: true, periodStart: true, periodEnd: true}})
    if (!values.length) return false
    if (await nativeConflicts(client, {pointPrelevementId, preleveurUserId, metadata: chunk.metadata,
      values, sourceId: chunk.sourceId, excludeChunkId: chunk.id})) return true
    cursor = values.at(-1).id
  }
}
