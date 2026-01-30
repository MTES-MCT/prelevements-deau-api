#!/usr/bin/env node
import 'dotenv/config'
import './instrument.js'

import process from 'node:process'

import * as Sentry from '@sentry/node'
import express from 'express'
import morgan from 'morgan'
import cors from 'cors'

import mongo from './lib/util/mongo.js'
import errorHandler from './lib/util/error-handler.js'
import routes from './lib/routes.js'
import {createBullBoardRouter} from './lib/queues/board.js'
import {ensureSeriesIndexes} from './lib/models/series.js'
import {validateEmailConfig} from './lib/util/email.js'

Sentry.setTag('service', 'api')

// Validate configuration
validateEmailConfig()

// Connect to MongoDB
await mongo.connect()
await ensureSeriesIndexes()

const PORT = process.env.PORT || 5000
const DEV = process.env.NODE_ENV !== 'production'

const app = express()

// Trust proxy (for req.ip behind a proxy/load balancer)
if (!DEV) {
  app.set('trust proxy', 1)
}

// Enable CORS
app.use(cors({origin: true, maxAge: 600}))

// Enable morgan logger (dev only)
if (DEV) {
  app.use(morgan('dev'))
}

// Setup JSON parsing
app.use(express.json())

// Ensure body is always an object
app.use((req, res, next) => {
  req.body ||= {}
  next()
})

// Setup BullBoard (monitoring des queues)
if (process.env.BULLBOARD_PASSWORD) {
  const basePath = '/admin/queues'
  const { router } = createBullBoardRouter(basePath, process.env.BULLBOARD_PASSWORD)
  app.use(basePath, router)
  console.log(`📊 BullBoard disponible sur ${basePath}`)
} else if (process.env.NODE_ENV !== 'test') {
  console.warn('⚠️  BullBoard désactivé : variable BULLBOARD_PASSWORD non définie')
}

app.use('/', routes)
app.use('/api', routes) // Deprecated

Sentry.setupExpressErrorHandler(app)

// Register error handler
app.use(errorHandler)

// Start listening
app.listen(PORT, () => {
  console.log(`Start listening on port ${PORT}`)
})
