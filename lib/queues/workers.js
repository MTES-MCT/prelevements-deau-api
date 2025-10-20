import {Worker} from 'bullmq'
import {connection, JOBS} from './config.js'
import {syncUpdatedDossiers} from '../demarches-simplifiees/index.js'
import {processAttachments} from '../demarches-simplifiees/attachments.js'
import {consolidateDossiers} from '../demarches-simplifiees/consolidate.js'

const handlers = {
  'sync-updated-dossiers': syncUpdatedDossiers,
  'process-attachments': processAttachments,
  'consolidate-dossiers': consolidateDossiers
}

export function startWorkers() {
  return JOBS.map(({name}) =>
    new Worker(name, () => handlers[name](), {connection})
  )
}
