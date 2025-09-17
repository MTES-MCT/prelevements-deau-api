import {CronJob} from 'cron'

import {processAttachments} from './demarches-simplifiees/attachments.js'
import {consolidateDossiers} from './demarches-simplifiees/consolidate.js'
import {syncUpdatedDossiers} from './demarches-simplifiees/index.js'

const jobs = [
  {
    time: '0 0 * * * *', // Every hour
    handler: () => syncUpdatedDossiers()
  },

  {
    time: '0 * * * * *', // Every minute
    handler: () => processAttachments()
  },

  {
    time: '0 * * * * *', // Every minute
    handler: () => consolidateDossiers()
  }
]

export async function startCron() {
  for (const job of jobs) {
    CronJob.from({
      cronTime: job.time,
      onTick: job.handler,
      start: true,
      waitForCompletion: true
    })
  }
}
