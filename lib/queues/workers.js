import {Worker} from 'bullmq'
import {getConnection, JOBS} from './config.js'
import {syncUpdatedDossiers} from '../demarches-simplifiees/index.js'
import {processAttachmentsMaintenance, processAttachment} from '../demarches-simplifiees/attachments.js'
import {consolidateDossiersMaintenance, consolidateDossier} from '../demarches-simplifiees/consolidate.js'

const handlers = {
  'sync-updated-dossiers': syncUpdatedDossiers,
  'process-attachments-maintenance': processAttachmentsMaintenance,
  'consolidate-dossiers-maintenance': consolidateDossiersMaintenance,
  'process-attachment': async job => processAttachment(job.data.attachmentId),
  'consolidate-dossier': async job => consolidateDossier(job.data.dossierId)
}

const concurrencySettings = {
  'consolidate-dossier': 4,
  'process-attachment': 1
}

export function startWorkers() {
  const connection = getConnection()
  return JOBS.map(({name}) =>
    new Worker(name, handlers[name], {connection, concurrency: concurrencySettings[name] || 1})
  )
}
