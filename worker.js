#!/usr/bin/env node
import 'dotenv/config'
import './instrument.js'
import mongo from './lib/util/mongo.js'
import {startWorkers} from './lib/queues/workers.js'
import {startScheduler} from './lib/queues/scheduler.js'
import * as Sentry from '@sentry/node'

Sentry.setTag('service', 'worker')

await mongo.connect()
await startScheduler()
startWorkers()

console.log('Workers started')
