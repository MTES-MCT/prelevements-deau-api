import test from 'ava'
import {createWorkerShutdown} from '../shutdown.js'

test('attend le traitement actif avant de fermer Redis et la base', async t => {
  const steps = []
  let finishJob
  const job = new Promise(resolve => {
    finishJob = resolve
  })
  const shutdown = createWorkerShutdown({
    workers: [{async close() {
      steps.push('worker')
      await job
      steps.push('job-finished')
    }}],
    stopAccepting: () => steps.push('not-ready'),
    closeQueues: () => steps.push('queues'),
    closeRedis: () => steps.push('redis'),
    closeDatabase: () => steps.push('database'),
    flushTelemetry: () => steps.push('telemetry')
  })

  const stopped = shutdown()
  t.is(shutdown(), stopped)
  await new Promise(resolve => {
    setImmediate(resolve)
  })
  t.deepEqual(steps, ['not-ready', 'worker'])
  finishJob()
  await stopped
  t.deepEqual(steps, ['not-ready', 'worker', 'job-finished', 'queues', 'redis', 'database', 'telemetry'])
})

test('termine les autres nettoyages si une fermeture échoue', async t => {
  const steps = []
  const shutdown = createWorkerShutdown({
    workers: [{async close() {
      throw new Error('worker-error')
    }}],
    stopAccepting: () => steps.push('not-ready'),
    closeQueues: () => steps.push('queues'),
    closeRedis: () => steps.push('redis'),
    closeDatabase: () => steps.push('database'),
    flushTelemetry: () => steps.push('telemetry')
  })

  const error = await t.throwsAsync(shutdown(), {instanceOf: AggregateError})
  t.is(error.errors[0].message, 'worker-error')
  t.deepEqual(steps, ['not-ready', 'queues', 'redis', 'database', 'telemetry'])
})
