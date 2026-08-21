import {createHmac} from 'node:crypto'
import {Buffer} from 'node:buffer'
import process from 'node:process'

import test from 'ava'

import {
  addUnknownLoginAuditMetadata,
  resolveAuditNetworkContext
} from '../context.js'

function createRequest(headers = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  )

  return {
    ip: '127.0.0.1',
    get(name) {
      return normalizedHeaders[name.toLowerCase()]
    }
  }
}

function createSignedHeaders(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return {
    'x-ple-audit-context': encoded,
    'x-ple-audit-signature': createHmac('sha256', secret).update(encoded).digest('hex')
  }
}

test.serial('resolveAuditNetworkContext accepte uniquement un contexte signé récent', t => {
  const previousSecret = process.env.AUDIT_CONTEXT_SECRET
  process.env.AUDIT_CONTEXT_SECRET = 'test-secret-with-more-than-thirty-two-bytes'

  try {
    const headers = createSignedHeaders({
      clientIp: '203.0.113.4',
      userAgent: 'Test browser',
      timestamp: Date.now(),
      requestId: 'front-request-id'
    }, process.env.AUDIT_CONTEXT_SECRET)
    const context = resolveAuditNetworkContext(createRequest(headers))

    t.deepEqual(context, {
      clientIp: '203.0.113.4',
      userAgent: 'Test browser',
      originRequestId: 'front-request-id',
      source: 'FRONT_SIGNED',
      invalidSignedContext: false
    })
  } finally {
    if (previousSecret === undefined) {
      delete process.env.AUDIT_CONTEXT_SECRET
    } else {
      process.env.AUDIT_CONTEXT_SECRET = previousSecret
    }
  }
})

test.serial('resolveAuditNetworkContext refuse les signatures altérées et expirées', t => {
  const previousSecret = process.env.AUDIT_CONTEXT_SECRET
  process.env.AUDIT_CONTEXT_SECRET = 'test-secret-with-more-than-thirty-two-bytes'

  try {
    const expiredHeaders = createSignedHeaders({
      clientIp: '203.0.113.4',
      timestamp: Date.now() - (10 * 60 * 1000),
      requestId: 'expired'
    }, process.env.AUDIT_CONTEXT_SECRET)
    const tamperedHeaders = {
      ...expiredHeaders,
      'x-ple-audit-signature': '0'.repeat(64)
    }

    for (const headers of [expiredHeaders, tamperedHeaders]) {
      const context = resolveAuditNetworkContext(createRequest({
        ...headers,
        'user-agent': 'Direct browser'
      }))
      t.is(context.source, 'DIRECT')
      t.true(context.invalidSignedContext)
      t.is(context.clientIp, '127.0.0.1')
      t.is(context.userAgent, 'Direct browser')
    }
  } finally {
    if (previousSecret === undefined) {
      delete process.env.AUDIT_CONTEXT_SECRET
    } else {
      process.env.AUDIT_CONTEXT_SECRET = previousSecret
    }
  }
})

test.serial('addUnknownLoginAuditMetadata borne l’email avant normalisation et HMAC', t => {
  const previousSecret = process.env.AUDIT_CONTEXT_SECRET
  process.env.AUDIT_CONTEXT_SECRET = 'test-secret-with-more-than-thirty-two-bytes'

  try {
    const boundedPrefix = `${'A'.repeat(307)}@Example.test`
    const oversizedEmail = boundedPrefix + 'B'.repeat(1_000_000)
    const boundedRequest = {auditEventId: 'bounded', auditContext: {metadata: {}}}
    const oversizedRequest = {auditEventId: 'oversized', auditContext: {metadata: {}}}

    addUnknownLoginAuditMetadata(boundedRequest, boundedPrefix)
    addUnknownLoginAuditMetadata(oversizedRequest, oversizedEmail)

    t.is(
      oversizedRequest.auditContext.metadata.loginFingerprint,
      boundedRequest.auditContext.metadata.loginFingerprint
    )
    t.is(oversizedRequest.auditContext.metadata.loginDomain, 'example.test')
  } finally {
    if (previousSecret === undefined) {
      delete process.env.AUDIT_CONTEXT_SECRET
    } else {
      process.env.AUDIT_CONTEXT_SECRET = previousSecret
    }
  }
})

test.serial('addUnknownLoginAuditMetadata ne convertit jamais une entrée non chaîne', t => {
  const previousSecret = process.env.AUDIT_CONTEXT_SECRET
  process.env.AUDIT_CONTEXT_SECRET = 'test-secret-with-more-than-thirty-two-bytes'
  let toStringCalls = 0

  try {
    const nonStringEmail = {
      toString() {
        toStringCalls += 1
        throw new Error('Cette conversion ne doit jamais avoir lieu.')
      }
    }
    const request = {auditEventId: 'non-string', auditContext: {metadata: {}}}

    t.notThrows(() => addUnknownLoginAuditMetadata(request, nonStringEmail))
    t.is(toStringCalls, 0)
    t.deepEqual(request.auditContext.metadata, {})
  } finally {
    if (previousSecret === undefined) {
      delete process.env.AUDIT_CONTEXT_SECRET
    } else {
      process.env.AUDIT_CONTEXT_SECRET = previousSecret
    }
  }
})
