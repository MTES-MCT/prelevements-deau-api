#!/usr/bin/env node

import 'dotenv/config'
import process from 'node:process'
import mongo from '../lib/util/mongo.js'
import {consolidateDossier} from '../lib/demarches-simplifiees/consolidate.js'
import {processAttachment} from '../lib/demarches-simplifiees/attachments/index.js'

const handlers = {
  'consolidate-dossier': consolidateDossier,
  'process-attachment': processAttachment
}

// Logger qui écrit directement dans la console
const consoleLogger = {
  log: (...args) => console.log(...args),
  info: (...args) => console.log('ℹ️', ...args),
  warn: (...args) => console.warn('⚠️', ...args),
  error: (...args) => console.error('❌', ...args)
}

async function runJobWithLogs(jobName, jobData = {}) {
  console.log(`🚀 Exécution du job ${jobName}`)
  console.log('📦 Données:', JSON.stringify(jobData, null, 2))
  console.log('─'.repeat(80))
  console.log()

  const handler = handlers[jobName]
  if (!handler) {
    throw new Error(`Handler inconnu: ${jobName}`)
  }

  // Extraire les arguments selon le job
  let args = []
  if (jobName === 'consolidate-dossier') {
    args = [jobData.dossierId, consoleLogger]
  } else if (jobName === 'process-attachment') {
    args = [jobData.attachmentId, consoleLogger]
  }

  const result = await handler(...args)

  console.log()
  console.log('─'.repeat(80))
  console.log('✅ Job terminé avec succès')

  if (result) {
    console.log('\n📊 Résultat:')
    console.log(JSON.stringify(result, null, 2))
  }

  return result
}

// Usage
const jobName = process.argv[2]
const jobDataArg = process.argv[3]

if (!jobName) {
  console.error('Usage: node scripts/run-job-with-logs.js <job-name> [job-data-json]')
  console.error('\nExemples:')
  console.error('  node scripts/run-job-with-logs.js consolidate-dossier \'{"dossierId":"6908db261a6a10831363dde3"}\'')
  console.error('  node scripts/run-job-with-logs.js process-attachment \'{"attachmentId":"..."}\'')
  process.exit(1)
}

let jobData = {}
if (jobDataArg) {
  try {
    jobData = JSON.parse(jobDataArg)
  } catch (error) {
    console.error(`❌ Erreur de parsing JSON: ${error.message}`)
    process.exit(1)
  }
}

try {
  await mongo.connect()
  await runJobWithLogs(jobName, jobData)
  await mongo.disconnect()
} catch (error) {
  console.error('❌ Erreur:', error.message)
  if (error.stack) {
    console.error(error.stack)
  }

  process.exit(1)
}
