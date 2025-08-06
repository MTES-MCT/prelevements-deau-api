import process from 'node:process'

import {CronJob} from 'cron'

import {processAttachments} from './demarches-simplifiees/attachments.js'
import {consolidateDossiers} from './demarches-simplifiees/consolidate.js'
import {syncUpdatedDossiers} from './demarches-simplifiees/index.js'

const demarcheNumber = Number.parseInt(process.env.DS_DEMARCHE_NUMBER, 10)

const jobs = [
  {
    time: '0 0 * * * *', // Every hour
    handler: () => syncUpdatedDossiers(demarcheNumber)
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
