import {getQueue, JOBS} from './config.js'

export async function startScheduler(getQueueForJob = getQueue) {
  /* eslint-disable no-await-in-loop -- Register schedules sequentially to limit Redis load. */
  for (const job of JOBS) {
    if (!job.cron) {
      continue
    }

    const queue = getQueueForJob(job.name)
    if (!queue) {
      console.log(`Queue ${job.name} non disponible, planification ignorée`)
      continue
    }

    await queue.upsertJobScheduler(
      job.name,
      {
        pattern: job.cron,
        ...(job.tz ? {tz: job.tz} : {})
      },
      {override: true}
    )
  }
  /* eslint-enable no-await-in-loop */
}
