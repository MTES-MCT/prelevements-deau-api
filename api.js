#!/usr/bin/env node
import 'dotenv/config.js'

import process from 'node:process'

import express from 'express'
import morgan from 'morgan'

import mongo from './lib/util/mongo.js'

import webRoutes from './lib/api/routes/web.js'
import prelevementRoutes from './lib/api/routes/prelevements.js'

// Connect to MongoDB
await mongo.connect()

const PORT = process.env.PORT || 5000
const DEV = process.env.NODE_ENV !== 'production'

const app = express()

// Enable morgan logger (dev only)
if (DEV) {
  app.use(morgan('dev'))
}

app.use('/', webRoutes)
app.use('/api', prelevementRoutes)

// Start listening
app.listen(PORT, () => {
  console.log(`Start listening on port ${PORT}`)
})
