import process from 'node:process'
import {pathToFileURL} from 'node:url'

import {validateProdAdminDatabaseUrl} from './prod-database-target.js'
import {readMigrationStatus} from './prod-migration-status.js'
import {
  createMigrationService as createService,
  getMigrationConfiguration as getConfiguration,
  startMigrationService
} from './migration-service-core.js'

const target = Object.freeze({
  appEnv: 'prod',
  validateDatabaseUrl: validateProdAdminDatabaseUrl,
  requireCleanLedger: true,
  blockFailedReplay: true
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
