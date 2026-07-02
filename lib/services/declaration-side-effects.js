import {prisma} from '../../db/prisma.js'

const AVAILABLE_CHUNK_STATUSES = [
  'PENDING',
  'VALIDATED',
  'AUTOMATICALLY_VALIDATED'
]

function uniqueTruthy(values = []) {
  return [...new Set(values.filter(Boolean))]
}

export async function refreshMostRecentAvailableDateForDeclarantPoints({
  declarantUserId,
  pointPrelevementIds
}) {
  const uniquePointIds = uniqueTruthy(pointPrelevementIds)

  if (!declarantUserId || uniquePointIds.length === 0) {
    return
  }

  const maxDateRows = await prisma.chunk.groupBy({
    by: ['pointPrelevementId'],
    where: {
      pointPrelevementId: {
        in: uniquePointIds
      },
      instructionStatus: {
        in: AVAILABLE_CHUNK_STATUSES
      },
      source: {
        status: 'COMPLETED',
        declaration: {
          declarantUserId
        }
      }
    },
    _max: {
      maxDate: true
    }
  })

  const maxDatesByPoint = new Map(
    maxDateRows
      .filter(row => row.pointPrelevementId)
      .map(row => [row.pointPrelevementId, row._max.maxDate ?? null])
  )

  const exploitations = await prisma.declarantPointPrelevement.findMany({
    where: {
      declarantUserId,
      pointPrelevementId: {
        in: uniquePointIds
      }
    },
    select: {
      id: true,
      pointPrelevementId: true
    }
  })

  await Promise.all(
    exploitations.map(async exploitation => prisma.declarantPointPrelevement.update({
      where: {
        id: exploitation.id
      },
      data: {
        mostRecentAvailableDate: maxDatesByPoint.get(exploitation.pointPrelevementId) ?? null
      }
    }))
  )
}
