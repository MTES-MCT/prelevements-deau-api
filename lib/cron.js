import process from 'node:process'

import {CronJob} from 'cron'

import {processAttachments} from './demarches-simplifiees/attachments.js'
import {consolidateDossiers} from './demarches-simplifiees/consolidate.js'
import {syncUpdatedDossiers} from './demarches-simplifiees/index.js'

const jobs = [
  {
    name: 'sync-updated-dossiers',
    time: '0 0 * * * *', // Every hour
    handler: () => syncUpdatedDossiers()
  },

  {
    name: 'process-attachments',
    time: '0 * * * * *', // Every minute
    handler: () => processAttachments()
  },

  {
    name: 'consolidate-dossiers',
    time: '0 * * * * *', // Every minute
    handler: () => consolidateDossiers()
  }
]

export async function startCron() {
  const rawFilter = process.env.CRON_JOBS

  const selectedNames = rawFilter
    ? new Set(rawFilter.split(',').map(name => name.trim()).filter(Boolean))
    : null

  const activeJobs = selectedNames
    ? jobs.filter(job => selectedNames.has(job.name))
    : jobs

  if (selectedNames) {
    const availableNames = new Set(jobs.map(job => job.name))
    const unknownNames = [...selectedNames].filter(name => !availableNames.has(name))

    if (unknownNames.length > 0) {
      console.warn(
        `Ignored unknown cron job(s) from CRON_JOBS: ${unknownNames.join(', ')}`
      )
    }

    if (activeJobs.length === 0) {
      console.warn('No matching cron jobs found for CRON_JOBS setting.')
    }
  }

  for (const job of activeJobs) {
    CronJob.from({
      cronTime: job.time,
      onTick: job.handler,
      start: true,
      waitForCompletion: true
    })
  }
}
