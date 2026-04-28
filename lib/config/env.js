import dotenvFlow from 'dotenv-flow'

dotenvFlow.config({
  node_env: process.env.APP_ENV || process.env.NODE_ENV || 'development',
})
