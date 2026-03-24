import process from 'node:process'
import * as Sentry from '@sentry/node'
import {nodeProfilingIntegration} from '@sentry/profiling-node'

const dsn = (process.env.SENTRY_DSN || '').trim()

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENV || 'development',
    sendDefaultPii: true,
    enableLogs: true,
    tracesSampleRate: 1,
    profileLifecycle: 'trace',
    integrations: [nodeProfilingIntegration()]
  })
}
