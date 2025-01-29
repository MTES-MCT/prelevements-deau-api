#!/usr/bin/env node
import 'dotenv/config.js'

import process from 'node:process'

import express from 'express'
import morgan from 'morgan'

import mongo from './lib/util/mongo.js'

import routes from './lib/api/routes/web.js'

// Connect to MongoDB
await mongo.connect()

const PORT = process.env.PORT || 5000
const DEV = process.env.NODE_ENV !== 'production'

const app = express()

// Enable morgan logger (dev only)
if (DEV) {
  app.use(morgan('dev'))
}

app.use('/', routes)
app.use('/api', routes) // Deprecated

// Start listening
app.listen(PORT, () => {
  console.log(`Start listening on port ${PORT}`)
})
