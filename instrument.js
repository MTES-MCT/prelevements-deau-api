import process from 'node:process'
import * as Sentry from '@sentry/node'
import {nodeProfilingIntegration} from '@sentry/profiling-node'

const dsn = (process.env.SENTRY_DSN || '').trim()
const environment = (process.env.SENTRY_ENV || '').trim() || 'development'
const release = (process.env.SENTRY_RELEASE || '').trim() || undefined
const service = (process.env.SENTRY_SERVICE || '').trim() || 'prelevements-deau-api'

if (dsn) {
  Sentry.init({
    dsn,
    environment,
    release,
    sendDefaultPii: true,
    enableLogs: true,
    tracesSampleRate: 1,
    profileLifecycle: 'trace',
    integrations: [nodeProfilingIntegration()]
  })

  Sentry.setTag('service', service)
}
