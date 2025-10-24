#!/usr/bin/env node
import 'dotenv/config'

import process from 'node:process'

import express from 'express'
import morgan from 'morgan'
import cors from 'cors'

import mongo from './lib/util/mongo.js'
import errorHandler from './lib/util/error-handler.js'

import routes from './lib/routes.js'
import {setupBullBoard} from './lib/queues/board.js'

import {ensureSeriesIndexes} from './lib/models/series.js'

// Connect to MongoDB
await mongo.connect()
await ensureSeriesIndexes()

const PORT = process.env.PORT || 5000
const DEV = process.env.NODE_ENV !== 'production'

const app = express()

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

app.use('/', routes)
app.use('/api', routes) // Deprecated

// Setup BullBoard (monitoring des queues)
const bullBoard = setupBullBoard()
if (bullBoard) {
  app.use(bullBoard.basePath, bullBoard.router)
  console.log(`📊 BullBoard disponible sur ${bullBoard.basePath}`)
}

// Register error handler
app.use(errorHandler)

// Start listening
app.listen(PORT, () => {
  console.log(`Start listening on port ${PORT}`)
})
