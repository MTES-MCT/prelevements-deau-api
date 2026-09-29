import process from 'node:process'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {createRequire} from 'node:module'
import {parseArgs} from 'node:util'
import IORedis from 'ioredis'
import {JOBS} from '../lib/queues/config.js'
import {readRedisUrl, getRedisTlsOptions} from '../lib/config/redis-url.js'
import {inspectQueueSchedules, assertLegacyMigrationTarget, migrateLegacySchedule, QueueMigrationSafetyError} from '../lib/queues/migration-preflight.js'

const {values} = parseArgs({options: {
  apply: {type: 'boolean', default: false},
  queue: {type: 'string'},
  'legacy-key': {type: 'string'},
  'expected-sha256': {type: 'string'},
  'scheduler-id': {type: 'string'},
  'bullmq-v5-module': {type: 'string'}
}})
const queueNames = [...new Set([...JOBS.map(job => job.name), 'pull-updated-data'])]
if (values.queue && !queueNames.includes(values.queue)) {
  throw new Error('File inconnue : utiliser un nom de file de l’API ou pull-updated-data.')
}

if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL explicite obligatoire. Aucune variable d’environnement ne sera modifiée.')
}

let redis
let queue
try {
  const ca = process.env.REDIS_TLS_CA_FILE_PATH
    ? await readFile(process.env.REDIS_TLS_CA_FILE_PATH, 'utf8')
    : undefined
  redis = new IORedis(readRedisUrl(), {
    protocol: 2,
    lazyConnect: true,
    retryStrategy: () => null,
    maxRetriesPerRequest: 1,
    connectTimeout: 10_000,
    commandTimeout: 10_000,
    tls: getRedisTlsOptions(ca)
  })
  // Errors reported below intentionally never include connection strings or job data.
  redis.on('error', () => {})
  await redis.connect()
  const reports = []
  for (const name of values.queue ? [values.queue] : queueNames) {
    reports.push(await inspectQueueSchedules(redis, name))
  }

  if (values.apply) {
    if (!values.queue || !values['legacy-key'] || !values['expected-sha256']
      || !values['scheduler-id'] || !values['bullmq-v5-module']) {
      throw new QueueMigrationSafetyError('Migration ciblée : --queue, --legacy-key, --expected-sha256, --scheduler-id et --bullmq-v5-module requis.')
    }

    const target = {
      report: reports[0],
      legacyKey: values['legacy-key'],
      fingerprint: values['expected-sha256'],
      schedulerId: values['scheduler-id']
    }
    // Even constructing Queue writes metadata: reject ambiguous targets first.
    assertLegacyMigrationTarget(target.report, target)

    const require = createRequire(import.meta.url)
    const modulePath = path.resolve(values['bullmq-v5-module'])
    const metadata = JSON.parse(await readFile(path.join(modulePath, 'package.json'), 'utf8'))
    if (metadata.name !== 'bullmq' || !metadata.version.startsWith('5.')) {
      throw new QueueMigrationSafetyError('La migration doit être exécutée avec BullMQ 5, avant le déploiement de BullMQ 6.')
    }

    const {Queue} = require(modulePath)
    queue = new Queue(values.queue, {connection: redis})
    const result = await migrateLegacySchedule({queue, ...target})
    console.log(JSON.stringify(result))
  } else {
    const ready = reports.every(report => report.schedules.every(entry => entry.kind === 'scheduler'))
    console.log(JSON.stringify({readOnly: true, readyForBullmq6: ready, queues: reports}, null, 2))
    process.exitCode = ready ? 0 : 2
  }
} catch (error) {
  // The full failure may contain credentials (Redis URL or job payload).
  if (error instanceof QueueMigrationSafetyError) {
    console.error(error.message)
  }

  console.error('Contrôle/migration interrompu. Aucune purge effectuée. Garder les files en pause en cas de migration et vérifier les définitions.')
  process.exitCode = 1
} finally {
  try {
    await queue?.close()
  } catch {
    console.error('Fermeture de la connexion de maintenance incomplète.')
    process.exitCode = 1
  } finally {
    redis?.disconnect()
  }
}
