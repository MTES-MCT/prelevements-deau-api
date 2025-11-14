/* eslint-disable unicorn/no-process-exit */
import 'dotenv/config'
import process from 'node:process'
import mongo from '../lib/util/mongo.js'
import {getQueue, closeConnection, JOBS} from '../lib/queues/config.js'

// Extract job name from command line arguments
const jobName = process.argv[2]

if (!jobName) {
  console.error('Usage: node scripts/trigger-scheduled-job.js <job-name>')
  console.error('\nJobs disponibles:')
  for (const job of JOBS.filter(j => j.cron)) {
    console.error(`  - ${job.name} (cron: ${job.cron})`)
  }

  process.exit(1)
}

// Verify that the job exists and is scheduled
const job = JOBS.find(j => j.name === jobName)
if (!job) {
  console.error(`Job "${jobName}" non trouvé`)
  console.error('\nJobs disponibles:')
  for (const job of JOBS.filter(j => j.cron)) {
    console.error(`  - ${job.name} (cron: ${job.cron})`)
  }

  process.exit(1)
}

if (!job.cron) {
  console.error(`Job "${jobName}" n'est pas un job schedulé (pas de cron)`)
  console.error('\nJobs schedulés disponibles:')
  for (const job of JOBS.filter(j => j.cron)) {
    console.error(`  - ${job.name} (cron: ${job.cron})`)
  }

  process.exit(1)
}

// Connect to MongoDB
await mongo.connect()

async function main() {
  console.log(`Déclenchement immédiat du job: ${jobName}`)

  const queue = getQueue(jobName)
  if (!queue) {
    throw new Error(`Queue ${jobName} non disponible`)
  }

  // Add the job to the queue immediately (no delay)
  const addedJob = await queue.add(
    jobName,
    {},
    {
      jobId: `manual-${jobName}-${Date.now()}` // Unique ID to avoid deduplication
    }
  )

  console.log(`✅ Job ${jobName} ajouté à la queue avec l'ID: ${addedJob.id}`)
  console.log('\nVous pouvez suivre son exécution via BullBoard: http://localhost:5000/admin/queues')
}

// Call the main function and ensure MongoDB is disconnected afterwards
try {
  await main()
} finally {
  // Disconnect from MongoDB and Redis
  await mongo.disconnect()
  await closeConnection()
}
