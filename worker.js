#!/usr/bin/env node
import 'dotenv/config'
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

await mongo.connect()
await startScheduler()
startWorkers()

console.log('Workers started')
