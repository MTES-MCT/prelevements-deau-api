import {randomUUID} from 'node:crypto'
import {prisma} from '../../db/prisma.js'
import {
  VOLUME_PRELEVE_METRIC_CODE,
  planVolumesFromIndexReconstruction
} from './volumes-from-index-computation.js'

export {
  INDEX_METRIC_TYPE_CODES,
  VOLUME_PRELEVE_METRIC_CODE,
  computeVolumeRowsFromIndexReadings,
  planVolumesFromIndexReconstruction
} from './volumes-from-index-computation.js'

const COMPUTED_FREQUENCY = '1 day'
const RECONSTRUCTION_LOCK_NAMESPACE = 'volumes-from-index'

async function lockPointForReconstruction(tx, pointId) {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${RECONSTRUCTION_LOCK_NAMESPACE}),
      hashtext(${pointId})
    )
  `
}

/**
 * Reconstruit les volumes à partir des index pour tous les chunks rattachés à un point.
 *
 * @param {string} pointId
 * @returns {Promise<{ pointId: string, chunksConsidered: number, chunksUpdated: number, volumesCreated: number, details: Array<{ chunkId: string, created: number, skipped?: boolean, reason?: string | null }> }>}
 */
export async function reconstructVolumesFromIndexForPoint(pointId) {
  return prisma.$transaction(async tx => {
    await lockPointForReconstruction(tx, pointId)

    const chunks = await tx.chunk.findMany({
      where: {
        pointPrelevementId: pointId,
        source: {
          status: 'COMPLETED'
        }
      },
      select: {
        id: true,
        pointPrelevementId: true,
        chunkValues: {
          where: {
            valueKind: 'DECLARED'
          },
          select: {
            metricTypeCode: true,
            valueKind: true,
            date: true,
            value: true,
            unit: true,
            frequency: true
          }
        }
      }
    })

    const plan = planVolumesFromIndexReconstruction(chunks)

    if (plan.eligibleChunkIds.length > 0) {
      await tx.chunkValue.deleteMany({
        where: {
          chunkId: {
            in: plan.eligibleChunkIds
          },
          metricTypeCode: VOLUME_PRELEVE_METRIC_CODE,
          valueKind: 'COMPUTED'
        }
      })
    }

    if (plan.computedRows.length > 0) {
      await tx.chunkValue.createMany({
        data: plan.computedRows.map(row => ({
          id: randomUUID(),
          chunkId: row.chunkId,
          metricTypeCode: VOLUME_PRELEVE_METRIC_CODE,
          unit: row.unit,
          frequency: COMPUTED_FREQUENCY,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          date: row.date,
          valueKind: 'COMPUTED',
          value: row.value
        }))
      })
    }

    return {
      pointId,
      chunksConsidered: plan.chunksConsidered,
      chunksUpdated: plan.chunksUpdated,
      volumesCreated: plan.volumesCreated,
      details: plan.details
    }
  }, {
    timeout: 30_000
  })
}
