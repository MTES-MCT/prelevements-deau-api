import {assertConnectedDemoAdminDatabase} from '../demo/database-target.js'
import {readMigrationStatus as readStatus} from './migration-status-core.js'

export function readMigrationStatus(databaseUrl, options) {
  return readStatus(databaseUrl, options, assertConnectedDemoAdminDatabase)
}
