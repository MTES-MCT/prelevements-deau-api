import {readdir} from 'node:fs/promises'

import {assertConnectedDemoAdminDatabase} from '../demo/database-target.js'

const MIGRATIONS_DIRECTORY = new URL('../../prisma/migrations/', import.meta.url)

async function createMigrationPrisma(databaseUrl) {
  const [{default: prismaPackage}, {PrismaPg}, {getPostgresConnectionOptions}] = await Promise.all([
    import('@prisma/client'),
    import('@prisma/adapter-pg'),
    import('../../db/connection-options.js')
  ])
  const adapter = new PrismaPg(getPostgresConnectionOptions(databaseUrl, {
    max: 1,
    connectionTimeoutMillis: 5000
  }))
  return new prismaPackage.PrismaClient({adapter})
}

// Fixed queries only: neither HTTP parameters nor migration logs enter this path.
export async function readMigrationStatus(databaseUrl, {
  createPrisma = createMigrationPrisma,
  readDirectory = readdir
} = {}) {
  const prisma = await createPrisma(databaseUrl)

  try {
    const entries = await readDirectory(MIGRATIONS_DIRECTORY, {withFileTypes: true})
    const expected = entries.filter(entry => entry.isDirectory() && /^\d+_/.test(entry.name))
      .map(entry => entry.name).sort()

    return await prisma.$transaction(async transaction => {
      await transaction.$executeRawUnsafe('SET TRANSACTION READ ONLY')
      await transaction.$executeRawUnsafe('SET LOCAL statement_timeout = \'10s\'')
      const identity = await assertConnectedDemoAdminDatabase(transaction)
      const [table] = await transaction.$queryRawUnsafe(
        'SELECT to_regclass(\'public._prisma_migrations\') IS NOT NULL AS present'
      )
      const migrations = table.present
        ? await transaction.$queryRawUnsafe(`
          SELECT migration_name AS "name", started_at AS "startedAt",
            finished_at AS "finishedAt", rolled_back_at AS "rolledBackAt",
            applied_steps_count AS "appliedStepsCount"
          FROM public._prisma_migrations ORDER BY started_at, id
        `)
        : []
      const applied = new Set(migrations.filter(row => row.finishedAt && !row.rolledBackAt)
        .map(row => row.name))

      return {
        identity,
        expectedCount: expected.length,
        pending: expected.filter(name => !applied.has(name)),
        unfinished: migrations.filter(row => !row.finishedAt && !row.rolledBackAt)
          .map(row => row.name),
        migrations
      }
    }, {maxWait: 5000, timeout: 15_000})
  } finally {
    await prisma.$disconnect()
  }
}
