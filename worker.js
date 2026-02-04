#!/usr/bin/env node
import 'dotenv/config'
import http from 'node:http'
import './instrument.js'
import * as Sentry from '@sentry/node'

import mongo from './lib/util/mongo.js'
import {startWorkers} from './lib/queues/workers.js'
import {startScheduler} from './lib/queues/scheduler.js'
import {waitForRedis} from './lib/queues/redis.js'

Sentry.setTag('service', 'worker')

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

await mongo.connect()
await startScheduler()
startWorkers()

ready = true
console.log('Workers started')
