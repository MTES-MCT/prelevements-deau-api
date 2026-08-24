import process from 'node:process'
import * as Sentry from '@sentry/node'
import {nodeProfilingIntegration} from '@sentry/profiling-node'
import {redactSentryEvent} from './lib/util/sentry-redaction.js'

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
    beforeSend: redactSentryEvent,
    beforeSendTransaction: redactSentryEvent,
    beforeSendSpan: redactSentryEvent,
    beforeSendLog: redactSentryEvent,
    integrations: [nodeProfilingIntegration()]
  })

  Sentry.setTag('service', service)
}
