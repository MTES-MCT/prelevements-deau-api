import {createHmac} from 'node:crypto'

import createHttpError from 'http-errors'

import {resolveAuditNetworkContext} from '../audit/context.js'
import {
  readCurrentPasswordPepperVersion,
  readPasswordPepper
} from '../config/auth.js'
import {getRedis} from '../queues/redis.js'

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const MAXIMUM_ATTEMPTS_BY_IP = 30
const MAXIMUM_ATTEMPTS_BY_ACCOUNT = 10
const REDIS_OPERATION_TIMEOUT_MS = 2000

const INCREMENT_RATE_LIMIT_SCRIPT = `
local ipCount = redis.call('INCR', KEYS[1])
if ipCount == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end

local accountCount = redis.call('INCR', KEYS[2])
if accountCount == 1 then
  redis.call('PEXPIRE', KEYS[2], ARGV[1])
end

return {
  ipCount,
  accountCount,
  redis.call('PTTL', KEYS[1]),
  redis.call('PTTL', KEYS[2])
}
`

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

function fingerprint(value, pepper) {
  return createHmac('sha256', pepper)
    .update(value, 'utf8')
    .digest('hex')
}

function normalizeAccountIdentifier(email) {
  return typeof email === 'string'
    ? email.slice(0, 320).trim().toLowerCase().normalize('NFC')
    : ''
}

export function resolvePasswordRateLimitClientIp(request) {
  const networkContext = resolveAuditNetworkContext(request)

  return networkContext.clientIp
    || request.ip
    || request.socket?.remoteAddress
    || ''
}

export async function checkPasswordLoginRateLimit({ip, email}, {
  redis = getRedis(),
  pepperVersion = readCurrentPasswordPepperVersion(),
  readPepper = readPasswordPepper
} = {}) {
  const pepper = readPepper(pepperVersion)
  const ipKey = `auth:password:rate:v1:ip:${fingerprint(String(ip || ''), pepper)}`
  const accountKey = `auth:password:rate:v1:account:${fingerprint(normalizeAccountIdentifier(email), pepper)}`

  let result
  try {
    result = await withTimeout(redis.eval(
      INCREMENT_RATE_LIMIT_SCRIPT,
      2,
      ipKey,
      accountKey,
      RATE_LIMIT_WINDOW_MS
    ))
  } catch {
    throw createHttpError(503, 'Service d’authentification temporairement indisponible.')
  }

  const [ipCount, accountCount, ipTtl, accountTtl] = result.map(Number)
  if (ipCount > MAXIMUM_ATTEMPTS_BY_IP || accountCount > MAXIMUM_ATTEMPTS_BY_ACCOUNT) {
    const retryAfterMilliseconds = Math.max(ipTtl, accountTtl, 1000)
    const error = createHttpError(429, 'Trop de tentatives de connexion. Veuillez réessayer plus tard.')
    error.retryAfterSeconds = Math.ceil(retryAfterMilliseconds / 1000)
    throw error
  }

  return {
    ipRemaining: Math.max(0, MAXIMUM_ATTEMPTS_BY_IP - ipCount),
    accountRemaining: Math.max(0, MAXIMUM_ATTEMPTS_BY_ACCOUNT - accountCount)
  }
}

export async function checkPasswordRequestRateLimit(request, accountIdentifier, options) {
  return checkPasswordLoginRateLimit({
    ip: resolvePasswordRateLimitClientIp(request),
    email: accountIdentifier
  }, options)
}

export async function passwordLoginRateLimiter(req, res, next) {
  try {
    await checkPasswordRequestRateLimit(req, req.body?.email)
    next()
  } catch (error) {
    if (error.retryAfterSeconds) {
      res.set('Retry-After', String(error.retryAfterSeconds))
    }

    next(error)
  }
}

export async function passwordActivationRateLimiter(req, res, next) {
  try {
    await checkPasswordRequestRateLimit(req, req.body?.token)
    next()
  } catch (error) {
    if (error.retryAfterSeconds) {
      res.set('Retry-After', String(error.retryAfterSeconds))
    }

    next(error)
  }
}

export const PASSWORD_RATE_LIMITS = Object.freeze({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maximumAttemptsByIp: MAXIMUM_ATTEMPTS_BY_IP,
  maximumAttemptsByAccount: MAXIMUM_ATTEMPTS_BY_ACCOUNT
})
