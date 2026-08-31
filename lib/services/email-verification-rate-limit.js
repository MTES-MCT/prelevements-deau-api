import {createHmac} from 'node:crypto'
import process from 'node:process'

import createHttpError from 'http-errors'

import {resolveAuditNetworkContext} from '../audit/context.js'
import {getRedis} from '../queues/redis.js'

const WINDOW_MS = 15 * 60 * 1000
const REQUEST_LIMIT_BY_IP = 20
const REQUEST_LIMIT_BY_USER = 5
const REQUEST_LIMIT_BY_TARGET = 5
const CONFIRMATION_LIMIT_BY_IP = 30
const REDIS_OPERATION_TIMEOUT_MS = 2000

const INCREMENT_KEYS_SCRIPT = `
local result = {}
for index, key in ipairs(KEYS) do
  local count = redis.call('INCR', key)
  if count == 1 then
    redis.call('PEXPIRE', key, ARGV[1])
  end
  table.insert(result, count)
  table.insert(result, redis.call('PTTL', key))
end
return result
`

function getFingerprintSecret(environment = process.env) {
  const secret = environment.AUDIT_CONTEXT_SECRET

  if (secret) {
    return secret
  }

  if (environment.NODE_ENV === 'production') {
    throw new Error('AUDIT_CONTEXT_SECRET est requis pour limiter les validations d’e-mail.')
  }

  return 'partageons-leau-email-rate-limit-development-only'
}

function fingerprint(value, secret) {
  return createHmac('sha256', secret)
    .update(String(value ?? '').slice(0, 500).trim().toLowerCase().normalize('NFC'), 'utf8')
    .digest('hex')
}

function resolveClientIp(request) {
  const networkContext = resolveAuditNetworkContext(request)

  return networkContext.clientIp
    || request.ip
    || request.socket?.remoteAddress
    || ''
}

async function withTimeout(promise, timeoutMs = REDIS_OPERATION_TIMEOUT_MS) {
  let timeoutId
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('Redis rate-limit timeout')),
      timeoutMs
    )
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timeoutId)
  }
}

async function incrementRateLimit(keys, limits, {
  redis = getRedis(),
  secret = getFingerprintSecret()
} = {}) {
  const redisKeys = keys.map(({scope, value}) => (
    `auth:email-verification:rate:v1:${scope}:${fingerprint(value, secret)}`
  ))

  let result
  try {
    result = await withTimeout(redis.eval(
      INCREMENT_KEYS_SCRIPT,
      redisKeys.length,
      ...redisKeys,
      WINDOW_MS
    ))
  } catch {
    throw createHttpError(503, 'Service de validation d’e-mail temporairement indisponible.')
  }

  const counts = []
  const timeToLives = []
  for (let index = 0; index < result.length; index += 2) {
    counts.push(Number(result[index]))
    timeToLives.push(Number(result[index + 1]))
  }

  if (counts.some((count, index) => count > limits[index])) {
    const retryAfterMilliseconds = Math.max(...timeToLives, 1000)
    const error = createHttpError(429, 'Trop de demandes de validation. Veuillez réessayer plus tard.')
    error.retryAfterSeconds = Math.ceil(retryAfterMilliseconds / 1000)
    throw error
  }

  return counts.map((count, index) => Math.max(0, limits[index] - count))
}

export function checkEmailVerificationRequestRateLimit(request, options) {
  const target = request.body?.email || request.params?.verificationId || ''

  return incrementRateLimit([
    {scope: 'request-ip', value: resolveClientIp(request)},
    {scope: 'request-user', value: request.user?.id},
    {scope: 'request-target', value: target}
  ], [
    REQUEST_LIMIT_BY_IP,
    REQUEST_LIMIT_BY_USER,
    REQUEST_LIMIT_BY_TARGET
  ], options)
}

export function checkEmailVerificationConfirmationRateLimit(request, options) {
  return incrementRateLimit([
    {scope: 'confirm-ip', value: resolveClientIp(request)}
  ], [CONFIRMATION_LIMIT_BY_IP], options)
}

function rateLimitMiddleware(check) {
  return async (request, response, next) => {
    try {
      await check(request)
      next()
    } catch (error) {
      if (error.retryAfterSeconds) {
        response.set('Retry-After', String(error.retryAfterSeconds))
      }

      next(error)
    }
  }
}

export const emailVerificationRequestRateLimiter = rateLimitMiddleware(
  checkEmailVerificationRequestRateLimit
)
export const emailVerificationConfirmationRateLimiter = rateLimitMiddleware(
  checkEmailVerificationConfirmationRateLimit
)

export const EMAIL_VERIFICATION_RATE_LIMITS = Object.freeze({
  windowMs: WINDOW_MS,
  requestByIp: REQUEST_LIMIT_BY_IP,
  requestByUser: REQUEST_LIMIT_BY_USER,
  requestByTarget: REQUEST_LIMIT_BY_TARGET,
  confirmationByIp: CONFIRMATION_LIMIT_BY_IP
})
