#!/usr/bin/env node
import './lib/config/env.js'
import http from 'node:http'
import process from 'node:process'
import './instrument.js'
import * as Sentry from '@sentry/node'

import {startWorkers} from './lib/queues/workers.js'
import {startScheduler} from './lib/queues/scheduler.js'
import {waitForRedis, closeRedis} from './lib/queues/redis.js'
import {closeQueues} from './lib/queues/config.js'
import {createWorkerShutdown} from './lib/queues/shutdown.js'
import {prisma} from './db/prisma.js'

Sentry.setTag('service', process.env.SENTRY_SERVICE?.trim() || 'worker')

for (;;) {
  try {
    // eslint-disable-next-line no-await-in-loop
    await waitForRedis()
    break
  } catch (error) {
    Sentry.captureException(error)
    console.warn('Redis indisponible, nouvelle tentative dans 2s...')
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => {
      setTimeout(resolve, 2000)
    })
  }
}

let ready = false

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    if (ready) {
      res.writeHead(200)
      res.end('ok')
    } else {
      res.writeHead(503)
      res.end('starting')
    }

    return
  }

  res.writeHead(404)
  res.end()
})

server.listen(8080, () => {
  console.log('Healthcheck server listening on port 8080')
})

await startScheduler()
const workers = startWorkers()

const shutdown = createWorkerShutdown({
  workers,
  async stopAccepting() {
    ready = false
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeIdleConnections()
    })
  },
  closeQueues,
  closeRedis,
  async closeDatabase() {
    await prisma.$disconnect()
    await globalThis.pgPool?.end()
  },
  flushTelemetry: () => Sentry.flush(2000)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown().catch(error => {
      console.error('Arrêt du worker impossible:', error)
      process.exitCode = 1
    })
  })
}

ready = true
console.log('Workers started')
