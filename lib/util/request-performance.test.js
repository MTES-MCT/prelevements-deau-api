import process from 'node:process'

import test from 'ava'
import express from 'express'
import request from 'supertest'

import {
  normalizeRequestPath,
  recordDatabasePoolAcquisition,
  requestPerformanceMiddleware,
  resolveRequestId,
  withRequestPerformancePhase
} from './request-performance.js'
import {createResponseCompressionMiddleware} from './response-compression.js'

test('normalizeRequestPath masque les identifiants dynamiques', t => {
  t.is(
    normalizeRequestPath('/declarants/024ab8c0-6d6f-47a5-b2c3-377420a5cfbf'),
    '/declarants/:id'
  )
  t.is(normalizeRequestPath('/zones/75/declarants?page=2'), '/zones/:id/declarants')
})

test('resolveRequestId conserve uniquement un identifiant sûr', t => {
  t.is(resolveRequestId('front_01-abc.def'), 'front_01-abc.def')
  t.regex(resolveRequestId('invalid id with spaces'), /^[\da-f-]{36}$/)
})

test('withRequestPerformancePhase refuse un nom impropre aux en-têtes', t => {
  t.throws(
    () => withRequestPerformancePhase('user input', () => true),
    {instanceOf: TypeError}
  )
})

test.serial('journalise les phases, le pool et les tailles sans donnée de requête', async t => {
  const previousPerfLog = process.env.API_PERF_LOG
  const previousCompressionThreshold = process.env.API_RESPONSE_COMPRESSION_MIN_BYTES
  const originalConsoleLog = console.log
  const logs = []
  process.env.API_PERF_LOG = '1'
  process.env.API_RESPONSE_COMPRESSION_MIN_BYTES = '1024'
  console.log = (...arguments_) => logs.push(arguments_.join(' '))
  t.teardown(() => {
    console.log = originalConsoleLog
    if (previousPerfLog === undefined) {
      delete process.env.API_PERF_LOG
    } else {
      process.env.API_PERF_LOG = previousPerfLog
    }

    if (previousCompressionThreshold === undefined) {
      delete process.env.API_RESPONSE_COMPRESSION_MIN_BYTES
    } else {
      process.env.API_RESPONSE_COMPRESSION_MIN_BYTES = previousCompressionThreshold
    }
  })

  const app = express()
  app.use(requestPerformanceMiddleware)
  app.use(createResponseCompressionMiddleware())
  app.get('/resources/:id', async (request_, response) => {
    await withRequestPerformancePhase('authorization', async () => true)
    const poolMetadata = recordDatabasePoolAcquisition({
      durationMs: 12.3,
      idleCount: 1,
      totalCount: 3,
      waitingCount: 2
    })
    response.setHeader('X-Test-Pool-Route', poolMetadata.route)
    response.json({value: 'compressible '.repeat(1000)})
  })

  const response = await request(app)
    .get('/resources/024ab8c0-6d6f-47a5-b2c3-377420a5cfbf?secret=not-logged')
    .set('Accept-Encoding', 'gzip')
    .set('X-Request-Id', 'front_01')

  const performanceLog = logs.find(line => line.startsWith('[API_PERF]'))
  const payload = JSON.parse(performanceLog.slice('[API_PERF] '.length))

  t.is(response.headers['content-encoding'], 'gzip')
  t.regex(response.headers['server-timing'], /authorization;dur=/)
  t.regex(response.headers['server-timing'], /db_pool_wait;dur=12\.3/)
  t.is(response.headers['x-test-pool-route'], '/resources/:id')
  t.is(payload.requestId, 'front_01')
  t.is(payload.route, '/resources/:id')
  t.true(payload.responseBytes > payload.transferredBytes)
  t.true(payload.compressionRatio < 1)
  t.is(payload.phases.authorization.count, 1)
  t.is(payload.phases.db_pool_wait.durationMs, 12.3)
  t.deepEqual(payload.databasePool, {
    acquisitions: 1,
    failures: 0,
    idleCountMin: 1,
    totalCountMax: 3,
    waitingCountMax: 2
  })
  t.false(performanceLog.includes('not-logged'))
})
