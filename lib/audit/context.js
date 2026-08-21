import {
  createHmac,
  timingSafeEqual
} from 'node:crypto'
import {Buffer} from 'node:buffer'
import process from 'node:process'

export const AUDIT_CONTEXT_HEADER = 'x-ple-audit-context'
export const AUDIT_SIGNATURE_HEADER = 'x-ple-audit-signature'

const MAX_CONTEXT_AGE_MS = 5 * 60 * 1000
const MAX_FUTURE_SKEW_MS = 30 * 1000
const MAX_LOGIN_EMAIL_AUDIT_LENGTH = 320
const REQUEST_ID_PATTERN = /^[\w.-]{1,100}$/

export function validateAuditContextConfig({
  required = process.env.NODE_ENV === 'production'
} = {}) {
  const secret = process.env.AUDIT_CONTEXT_SECRET

  if (required && !secret) {
    throw new Error('AUDIT_CONTEXT_SECRET est requis dans cet environnement.')
  }

  if (secret && secret.length < 32) {
    throw new Error('AUDIT_CONTEXT_SECRET doit contenir au moins 32 caractères.')
  }

  return secret || null
}

function truncate(value, maximumLength) {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  return normalized ? normalized.slice(0, maximumLength) : null
}

function getDirectIp(request) {
  return truncate(request.ip || request.socket?.remoteAddress, 128)
}

function hasValidSignature(encodedContext, signature, secret) {
  if (!encodedContext || !signature || !secret) {
    return false
  }

  const expected = createHmac('sha256', secret)
    .update(encodedContext)
    .digest('hex')
  const expectedBuffer = Buffer.from(expected, 'utf8')
  const actualBuffer = Buffer.from(signature, 'utf8')

  return expectedBuffer.length === actualBuffer.length
    && timingSafeEqual(expectedBuffer, actualBuffer)
}

function decodeSignedContext(encodedContext) {
  if (!encodedContext || encodedContext.length > 4096) {
    return null
  }

  try {
    const parsed = JSON.parse(Buffer.from(encodedContext, 'base64url').toString('utf8'))
    const timestamp = Number(parsed.timestamp)
    const age = Date.now() - timestamp

    if (!Number.isFinite(timestamp) || age > MAX_CONTEXT_AGE_MS || age < -MAX_FUTURE_SKEW_MS) {
      return null
    }

    return {
      clientIp: truncate(parsed.clientIp, 128),
      userAgent: truncate(parsed.userAgent, 512),
      originRequestId: REQUEST_ID_PATTERN.test(parsed.requestId || '')
        ? parsed.requestId
        : null
    }
  } catch {
    return null
  }
}

export function resolveAuditNetworkContext(request) {
  const encodedContext = request.get(AUDIT_CONTEXT_HEADER)
  const signature = request.get(AUDIT_SIGNATURE_HEADER)
  const secret = validateAuditContextConfig({required: false})

  if (hasValidSignature(encodedContext, signature, secret)) {
    const signedContext = decodeSignedContext(encodedContext)

    if (signedContext) {
      return {
        ...signedContext,
        source: 'FRONT_SIGNED',
        invalidSignedContext: false
      }
    }
  }

  return {
    clientIp: getDirectIp(request),
    userAgent: truncate(request.get('user-agent'), 512),
    originRequestId: null,
    source: 'DIRECT',
    invalidSignedContext: Boolean(encodedContext || signature)
  }
}

function getAuditContext(request) {
  request.auditContext ||= {
    metadata: {}
  }

  return request.auditContext
}

export function addAuditMetadata(request, metadata) {
  if (!request.auditEventId || !metadata || typeof metadata !== 'object') {
    return
  }

  const context = getAuditContext(request)
  context.metadata = {
    ...context.metadata,
    ...metadata
  }
}

export function setAuditSubject(request, user) {
  if (!request.auditEventId || !user) {
    return
  }

  getAuditContext(request).subject = user
}

export function setAuditActor(request, actor) {
  if (!request.auditEventId || !actor) {
    return
  }

  getAuditContext(request).actor = actor
}

export function setAuditTarget(request, {id, label, type} = {}) {
  if (!request.auditEventId) {
    return
  }

  const context = getAuditContext(request)
  context.target = {
    ...context.target,
    ...(id ? {id: String(id)} : {}),
    ...(label ? {label: String(label)} : {}),
    ...(type ? {type: String(type)} : {})
  }
}

export function addUnknownLoginAuditMetadata(request, email) {
  const boundedEmail = typeof email === 'string'
    ? email.slice(0, MAX_LOGIN_EMAIL_AUDIT_LENGTH)
    : ''
  const normalizedEmail = boundedEmail.trim().toLowerCase()
  const domain = normalizedEmail.includes('@') ? normalizedEmail.split('@').at(-1) : null
  const secret = validateAuditContextConfig({required: false})
  const fingerprint = secret && normalizedEmail
    ? createHmac('sha256', secret)
      .update(`unknown-login:${normalizedEmail}`)
      .digest('hex')
    : null

  addAuditMetadata(request, {
    ...(domain ? {loginDomain: domain.slice(0, 255)} : {}),
    ...(fingerprint ? {loginFingerprint: fingerprint} : {})
  })
}
