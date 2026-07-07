import {Worker} from 'bullmq'
import * as Sentry from '@sentry/node'

import {getConnection, WORKER_JOBS} from './config.js'
import {createLogger} from '../util/logger.js'
import {processApiImport} from '../api-importer/importer.js'
import {reconstructVolumesFromIndexForPoint} from '../services/volumes-from-index.js'
import {processScheduledDeclarationNotification} from '../services/declaration-notifications.js'

const handlers = {
  'process-api-import': async job => processApiImport(job.data.apiImportId, createLogger(job)),
  async 'reconstruct-volumes-from-index-for-point'(job) {
    const logger = createLogger(job)
    const {pointId, sourceId} = job.data
    logger.log(`Reconstruction des volumes index: pointId=${pointId}, sourceId=${sourceId}`)
    const result = await reconstructVolumesFromIndexForPoint(pointId)
    logger.log(
      `Reconstruction terminée: pointId=${pointId}, chunks=${result.chunksConsidered}, updated=${result.chunksUpdated}, created=${result.volumesCreated}`
    )
    return result
  },
  async 'declaration-notification-reminder-week'() {
    return processScheduledDeclarationNotification({
      notificationType: 'reminder',
      periodType: 'week'
    })
  },
  async 'declaration-notification-followup-week'() {
    return processScheduledDeclarationNotification({
      notificationType: 'followup',
      periodType: 'week'
    })
  },
  async 'declaration-notification-reminder-month'() {
    return processScheduledDeclarationNotification({
      notificationType: 'reminder',
      periodType: 'month'
    })
  },
  async 'declaration-notification-followup-month'() {
    return processScheduledDeclarationNotification({
      notificationType: 'followup',
      periodType: 'month'
    })
  }
}

export function startWorkers() {
  const connection = getConnection()

  return WORKER_JOBS.map(({name}) => {
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
