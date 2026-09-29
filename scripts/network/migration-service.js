import process from 'node:process'
import {pathToFileURL} from 'node:url'

import {validateDemoAdminDatabaseUrl} from '../demo/database-target.js'
import {readMigrationStatus} from './migration-status.js'
import {
  createMigrationService as createService,
  getMigrationConfiguration as getConfiguration,
  startMigrationService
} from './migration-service-core.js'

function validateDatabaseUrl(databaseUrl) {
  const target = validateDemoAdminDatabaseUrl(databaseUrl)
  if (target.hostname !== '172.16.12.2' || target.port !== '5432') {
    throw new Error('Le service doit utiliser exclusivement PostgreSQL demo privé.')
  }
}

const target = Object.freeze({
  appEnv: 'demo',
  validateDatabaseUrl: validateDatabaseUrl,
  requireCleanLedger: false,
  blockFailedReplay: false
})

export function getMigrationConfiguration(environment) {
  return getConfiguration(environment, target)
}

export function createMigrationService({readStatus = readMigrationStatus, ...options} = {}) {
  return createService({readStatus, ...options}, target)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startMigrationService(createMigrationService)
}
