import {Worker} from 'bullmq'
import * as Sentry from '@sentry/node'

import {getConnection, JOBS} from './config.js'
import {syncUpdatedDossiers} from '../demarches-simplifiees/index.js'
import {processAttachmentsMaintenance, processAttachment} from '../demarches-simplifiees/attachments/index.js'
import {consolidateDossiersMaintenance, consolidateDossier} from '../demarches-simplifiees/consolidate.js'
import {createLogger} from '../util/logger.js'

const handlers = {
  'sync-updated-dossiers': async job => syncUpdatedDossiers(createLogger(job)),
  'process-attachments-maintenance': async job => processAttachmentsMaintenance(createLogger(job)),
  'consolidate-dossiers-maintenance': async job => consolidateDossiersMaintenance(createLogger(job)),
  'process-attachment': async job => processAttachment(job.data.attachmentId, createLogger(job)),
  'consolidate-dossier': async job => consolidateDossier(job.data.dossierId, createLogger(job))
}

const concurrencySettings = {
  'consolidate-dossier': 4,
  'process-attachment': 1
}

export function startWorkers() {
  const connection = getConnection()

  return JOBS.map(({name}) => {
    const worker = new Worker(name, handlers[name], {
      connection,
      concurrency: concurrencySettings[name] || 1
    })

    worker.on('error', err => {
      Sentry.captureException(err)
    })

    worker.on('failed', (job, err) => {
      Sentry.withScope(scope => {
        scope.setTag('queue', name)
        scope.setContext('job', {id: job?.id, name: job?.name})
        Sentry.captureException(err)
      })
    })

    return worker
  })
}
