const DEFAULT_STALE_PROCESSING_DELAY_MS = 15 * 60 * 1000

export function getReplayableDeclarationsWhere({
  now = new Date(),
  staleProcessingDelayMs = DEFAULT_STALE_PROCESSING_DELAY_MS
} = {}) {
  const staleProcessingThreshold = new Date(now.getTime() - staleProcessingDelayMs)

  return {
    files: {
      some: {}
    },
    source: {
      is: null
    },
    OR: [
      {
        processingStatus: {
          in: ['COMPLETED', 'FAILED']
        }
      },
      {
        createdAt: {
          lt: staleProcessingThreshold
        },
        processingStatus: {
          in: ['CREATED', 'UPLOADED', 'QUEUED', 'PROCESSING']
        }
      }
    ]
  }
}
