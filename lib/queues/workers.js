import {Worker} from 'bullmq'
import * as Sentry from '@sentry/node'

import {getConnection, JOBS} from './config.js'
import {createLogger} from '../util/logger.js'
import {processDeclaration} from '../declaration-importer/importer.js'

const handlers = {
  'process-declaration': async job => processDeclaration(job.data.declarationId, createLogger(job))
}

export function startWorkers() {
  const connection = getConnection()

  return JOBS.map(({name}) => {
    const worker = new Worker(name, handlers[name], {
      connection,
      concurrency: 1
    })

    worker.on('error', err => {
      Sentry.captureException(err)
    })

    worker.on('failed', (job, err) => {
      const msg = err?.message ?? String(err)
      const stack = err?.stack ?? ''
      console.error(`[worker ${name}] Job ${job?.id} failed:`, msg, stack ? `\n${stack}` : '')
      Sentry.withScope(scope => {
        scope.setTag('queue', name)
        scope.setContext('job', {id: job?.id, name: job?.name})
        Sentry.captureException(err)
      })
    })

    return worker
  })
}
