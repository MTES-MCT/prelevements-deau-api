import dotenvFlow from 'dotenv-flow'
import process from 'node:process'

dotenvFlow.config({
  node_env: process.env.APP_ENV || process.env.NODE_ENV || 'development'
})
