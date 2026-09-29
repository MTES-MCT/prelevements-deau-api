export function createWorkerShutdown({
  workers,
  stopAccepting,
  closeQueues,
  closeRedis,
  closeDatabase,
  flushTelemetry
}) {
  let shutdown

  return () => {
    shutdown ||= (async () => {
      const errors = []
      const attempt = async operation => {
        try {
          await operation()
        } catch (error) {
          errors.push(error)
        }
      }

      await attempt(stopAccepting)
      // Keep Redis and PostgreSQL available until every active job finishes.
      await Promise.all(workers.map(worker => attempt(() => worker.close())))
      await attempt(closeQueues)
      await attempt(closeRedis)
      await attempt(closeDatabase)
      await attempt(flushTelemetry)

      if (errors.length > 0) {
        throw new AggregateError(errors, 'Arrêt incomplet des traitements')
      }
    })()

    return shutdown
  }
}
