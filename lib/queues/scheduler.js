import {getQueue, JOBS} from './config.js'

export async function startScheduler() {
  /* eslint-disable no-await-in-loop */
  for (const job of JOBS) {
    const queue = getQueue(job.name)
    await queue.upsertJobScheduler(job.name, {repeat: {pattern: job.cron}})
  }
  /* eslint-enable no-await-in-loop */
}
