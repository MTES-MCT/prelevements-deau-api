import {spawn as spawnProcess} from 'node:child_process'
import {createHash, randomUUID, timingSafeEqual} from 'node:crypto'
import {createServer} from 'node:http'
import process from 'node:process'
import {fileURLToPath, pathToFileURL} from 'node:url'

import {validateProdAdminDatabaseUrl} from './prod-database-target.js'
import {getPrismaDatabaseUrl} from './prisma-database-url.js'
import {readMigrationStatus} from './prod-migration-status.js'

const RELEASE_PATTERN = /^[\da-f]{40}$/
const PROJECT_DIRECTORY = fileURLToPath(new URL('../../', import.meta.url))
const PRISMA_CLI = fileURLToPath(new URL('../../node_modules/prisma/build/index.js', import.meta.url))
const MAX_TIMEOUT_SECONDS = 1140

export function getMigrationConfiguration(environment) {
  if (environment.APP_ENV !== 'prod') {
    throw new Error('Le service de migration est réservé à APP_ENV=prod.')
  }

  validateProdAdminDatabaseUrl(environment.DATABASE_URL)

  if (!RELEASE_PATTERN.test(environment.MIGRATION_RELEASE_SHA ?? '')) {
    throw new Error('MIGRATION_RELEASE_SHA doit identifier une release Git complète.')
  }

  if (typeof environment.MIGRATION_INVOKE_SECRET !== 'string'
    || environment.MIGRATION_INVOKE_SECRET.length < 32) {
    throw new Error('MIGRATION_INVOKE_SECRET doit contenir au moins 32 caractères.')
  }

  const timeoutSeconds = Number(environment.MIGRATION_TIMEOUT_SECONDS ?? MAX_TIMEOUT_SECONDS)
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new Error('MIGRATION_TIMEOUT_SECONDS doit être compris entre 1 et 1140.')
  }

  return {
    databaseUrl: environment.DATABASE_URL,
    cliDatabaseUrl: getPrismaDatabaseUrl(environment.DATABASE_URL),
    release: environment.MIGRATION_RELEASE_SHA,
    secretDigest: createHash('sha256').update(environment.MIGRATION_INVOKE_SECRET).digest(),
    timeoutMs: timeoutSeconds * 1000
  }
}

function json(response, statusCode, body) {
  if (!response.destroyed) {
    response.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    response.end(JSON.stringify(body))
  }
}

function isAuthorized(request, configuration) {
  const supplied = request.headers['x-migration-secret']
  return typeof supplied === 'string' && supplied.length <= 4096
    && timingSafeEqual(createHash('sha256').update(supplied).digest(), configuration.secretDigest)
}

async function readRequestBody(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new Error('INVALID_REQUEST')
  }

  let body = ''
  for await (const chunk of request) {
    body += chunk.toString('utf8')
    if (Buffer.byteLength(body) > 1024) {
      throw new Error('INVALID_REQUEST')
    }
  }

  const parsed = JSON.parse(body)
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'
    || Object.keys(parsed).length !== 1 || !RELEASE_PATTERN.test(parsed.expectedRelease ?? '')) {
    throw new Error('INVALID_REQUEST')
  }

  return parsed
}

export function createMigrationService({
  environment = process.env,
  spawn = spawnProcess,
  readStatus = readMigrationStatus,
  terminationGraceMs = 10_000
} = {}) {
  const configuration = getMigrationConfiguration(environment)
  let stopping = false
  let activeOperation
  let operation
  let cancelChild

  function snapshot() {
    return {release: configuration.release, state: operation?.state ?? 'idle', operation: operation ?? null}
  }

  async function executePrisma() {
    return new Promise(resolve => {
      let child
      let timedOut = false
      let cancelled = false
      let finished = false
      let killTimer
      let timeoutTimer = null

      const finish = (exitCode, failedToStart = false) => {
        if (finished) {
          return
        }

        finished = true
        clearTimeout(timeoutTimer)
        clearTimeout(killTimer)
        cancelChild = undefined
        resolve({exitCode, timedOut, cancelled, failedToStart})
      }

      const kill = signal => {
        try {
          if (child.pid && process.platform !== 'win32') {
            process.kill(-child.pid, signal)
          } else {
            child.kill(signal)
          }
        } catch {
          // A process that already exited needs no further action.
        }
      }

      const terminate = reason => {
        timedOut = reason === 'timeout'
        cancelled = reason === 'shutdown'
        kill('SIGTERM')
        killTimer = setTimeout(() => kill('SIGKILL'), terminationGraceMs)
        killTimer.unref()
      }

      try {
        child = spawn(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
          cwd: PROJECT_DIRECTORY,
          detached: process.platform !== 'win32',
          // Never forward raw Prisma errors: they may include database credentials.
          stdio: 'ignore',
          env: {
            PATH: environment.PATH ?? process.env.PATH,
            NODE_ENV: 'production',
            NODE_OPTIONS: '--use-openssl-ca',
            APP_ENV: 'prod',
            DATABASE_URL: configuration.cliDatabaseUrl
          }
        })
      } catch {
        finish(null, true)
        return
      }

      child.once('error', () => finish(null, true))
      child.once('close', code => finish(code))
      cancelChild = () => terminate('shutdown')
      timeoutTimer = setTimeout(() => terminate('timeout'), configuration.timeoutMs)
      timeoutTimer.unref()
    })
  }

  async function migrate() {
    operation = {
      id: randomUUID(),
      release: configuration.release,
      state: 'running',
      startedAt: new Date().toISOString()
    }
    try {
      // Also confirms the actual connected database/user/TLS, not just its URL.
      const before = await readStatus(configuration.databaseUrl)
      if (!Array.isArray(before.unfinished) || before.unfinished.length > 0) {
        operation.state = 'failed'
        operation.errorCode = 'MIGRATION_LEDGER_REQUIRES_REVIEW'
        return
      }

      if (stopping) {
        operation.state = 'unknown'
        operation.errorCode = 'SERVICE_STOPPING'
        return
      }

      const result = await executePrisma()
      operation.exitCode = result.exitCode
      operation.state = result.timedOut || result.cancelled ? 'unknown' : 'failed'
      if (result.timedOut || result.cancelled) {
        operation.errorCode = result.timedOut ? 'MIGRATION_TIMEOUT' : 'SERVICE_STOPPING'
      } else if (result.failedToStart) {
        operation.errorCode = 'MIGRATION_START_FAILED'
      } else if (result.exitCode !== 0) {
        operation.errorCode = 'MIGRATION_EXIT_FAILED'
      }

      // Do not rerun the command after a lost response/timeout: inspect the ledger.
      operation.database = await readStatus(configuration.databaseUrl)
      if (!result.timedOut && !result.cancelled && result.exitCode === 0) {
        operation.state = operation.database.pending.length === 0 && operation.database.unfinished.length === 0
          ? 'succeeded'
          : 'failed'
        if (operation.state !== 'succeeded') {
          operation.errorCode = 'MIGRATION_LEDGER_NOT_READY'
        }
      }
    } catch {
      operation.state = 'unknown'
      operation.errorCode = 'DATABASE_STATUS_UNAVAILABLE'
    } finally {
      operation.finishedAt = new Date().toISOString()
    }
  }

  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      json(response, stopping ? 503 : 200, {ok: !stopping, service: 'prod-migrations', release: configuration.release})
      return
    }

    if (!['/status', '/migrate'].includes(request.url)) {
      json(response, 404, {errorCode: 'NOT_FOUND'})
      return
    }

    if (!isAuthorized(request, configuration)) {
      json(response, 403, {errorCode: 'FORBIDDEN'})
      return
    }

    if (request.method === 'GET' && request.url === '/status') {
      try {
        const database = await readStatus(configuration.databaseUrl)
        json(response, 200, {...snapshot(), database})
      } catch {
        json(response, 503, {...snapshot(), errorCode: 'DATABASE_STATUS_UNAVAILABLE'})
      }

      return
    }

    if (request.method !== 'POST' || request.url !== '/migrate') {
      json(response, 405, {errorCode: 'METHOD_NOT_ALLOWED'})
      return
    }

    let body
    try {
      body = await readRequestBody(request)
    } catch {
      json(response, 400, {errorCode: 'INVALID_REQUEST'})
      return
    }

    if (body.expectedRelease !== configuration.release) {
      json(response, 409, {...snapshot(), errorCode: 'RELEASE_MISMATCH'})
      return
    }

    if (stopping || activeOperation) {
      json(response, stopping ? 503 : 409, {...snapshot(), errorCode: stopping ? 'SERVICE_STOPPING' : 'MIGRATION_IN_PROGRESS'})
      return
    }

    if (['failed', 'unknown'].includes(operation?.state)) {
      json(response, 409, {...snapshot(), errorCode: 'MIGRATION_REQUIRES_REVIEW'})
      return
    }

    activeOperation = migrate()
    await activeOperation
    activeOperation = undefined
    json(response, operation.state === 'succeeded' ? 200 : 503, snapshot())
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000

  return {
    server,
    configuration: {release: configuration.release},
    async stop() {
      stopping = true
      cancelChild?.()
      await activeOperation
      await new Promise(resolve => {
        server.close(resolve)
      })
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const service = createMigrationService()
    const port = Number(process.env.PORT ?? 8080)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('PORT invalide.')
    }

    service.server.listen(port, '0.0.0.0')
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.once(signal, () => {
        service.stop().catch(() => {
          process.exitCode = 1
        })
      })
    }
  } catch {
    console.error('Configuration du service de migration refusée.')
    process.exitCode = 1
  }
}
