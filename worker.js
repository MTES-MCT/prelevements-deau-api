#!/usr/bin/env node
import 'dotenv/config'
import mongo from './lib/util/mongo.js'
import {startWorkers} from './lib/queues/workers.js'
import {startScheduler} from './lib/queues/scheduler.js'

await mongo.connect()
await startScheduler()
startWorkers()

console.log('Workers started')
