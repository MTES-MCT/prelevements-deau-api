#!/usr/bin/env node
import 'dotenv/config'
import http from 'node:http'
import mongo from './lib/util/mongo.js'
import {startWorkers} from './lib/queues/workers.js'
import {startScheduler} from './lib/queues/scheduler.js'

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
