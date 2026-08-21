import {createHmac} from 'node:crypto'
import {Buffer} from 'node:buffer'
import process from 'node:process'

import test from 'ava'

import {
  checkPasswordLoginRateLimit,
  checkPasswordRequestRateLimit,
  PASSWORD_RATE_LIMITS,
  resolvePasswordRateLimitClientIp
} from '../password-rate-limit.js'

const PEPPER = 'rate-limit-pepper-avec-au-moins-trente-deux-octets'
const readPepper = () => PEPPER
const AUDIT_CONTEXT_SECRET = 'test-audit-context-secret-with-more-than-thirty-two-bytes'

function createRequest({headers = {}, ip = '198.51.100.10'} = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  )

  return {
    ip,
    get(name) {
      return normalizedHeaders[name.toLowerCase()]
    }
  }
}

function createSignedHeaders(clientIp) {
  const encodedContext = Buffer.from(JSON.stringify({
    clientIp,
    timestamp: Date.now()
  })).toString('base64url')

  return {
    'x-ple-audit-context': encodedContext,
    'x-ple-audit-signature': createHmac('sha256', AUDIT_CONTEXT_SECRET)
      .update(encodedContext)
      .digest('hex')
  }
}

function createCountingRedis() {
  const counts = new Map()

  return {
    counts,
    async eval(_script, _keyCount, ipKey, accountKey) {
      const ipCount = (counts.get(ipKey) ?? 0) + 1
      const accountCount = (counts.get(accountKey) ?? 0) + 1
      counts.set(ipKey, ipCount)
      counts.set(accountKey, accountCount)
      return [ipCount, accountCount, 900_000, 900_000]
    }
  }
}

async function withAuditContextSecret(run) {
  const previousSecret = process.env.AUDIT_CONTEXT_SECRET
  process.env.AUDIT_CONTEXT_SECRET = AUDIT_CONTEXT_SECRET

  try {
    await run()
  } finally {
    if (previousSecret === undefined) {
      delete process.env.AUDIT_CONTEXT_SECRET
    } else {
      process.env.AUDIT_CONTEXT_SECRET = previousSecret
    }
  }
}

test('le rate limit ne place ni email ni IP en clair dans Redis', async t => {
  let arguments_
  const redis = {
    async eval(...values) {
      arguments_ = values
      return [1, 1, 900_000, 900_000]
    }
  }

  const result = await checkPasswordLoginRateLimit({
    ip: '192.0.2.42',
    email: 'personne@example.test'
  }, {redis, pepperVersion: 1, readPepper})

  const serializedArguments = JSON.stringify(arguments_)
  t.false(serializedArguments.includes('personne@example.test'))
  t.false(serializedArguments.includes('192.0.2.42'))
  t.is(result.ipRemaining, PASSWORD_RATE_LIMITS.maximumAttemptsByIp - 1)
  t.is(result.accountRemaining, PASSWORD_RATE_LIMITS.maximumAttemptsByAccount - 1)
})

test('le rate limit refuse après dix tentatives par compte', async t => {
  const redis = {
    async eval() {
      return [11, 11, 600_000, 600_000]
    }
  }

  const error = await t.throwsAsync(() => checkPasswordLoginRateLimit({
    ip: '192.0.2.42',
    email: 'personne@example.test'
  }, {redis, pepperVersion: 1, readPepper}))

  t.is(error.status, 429)
  t.is(error.retryAfterSeconds, 600)
})

test('le rate limit échoue fermé si Redis est indisponible', async t => {
  const redis = {
    async eval() {
      throw new Error('Redis indisponible')
    }
  }

  const error = await t.throwsAsync(() => checkPasswordLoginRateLimit({
    ip: '192.0.2.42',
    email: 'personne@example.test'
  }, {redis, pepperVersion: 1, readPepper}))

  t.is(error.status, 503)
})

test.serial('deux IP clientes signées ne partagent pas le quota IP du front', async t => {
  await withAuditContextSecret(async () => {
    const redis = createCountingRedis()
    const frontIp = '192.0.2.10'
    const firstClient = createRequest({
      headers: createSignedHeaders('203.0.113.10'),
      ip: frontIp
    })
    const secondClient = createRequest({
      headers: createSignedHeaders('203.0.113.11'),
      ip: frontIp
    })
    const options = {redis, pepperVersion: 1, readPepper}

    await Promise.all(Array.from(
      {length: PASSWORD_RATE_LIMITS.maximumAttemptsByIp},
      (_, index) => checkPasswordRequestRateLimit(
        firstClient,
        `personne-${index}@example.test`,
        options
      )
    ))

    await t.notThrowsAsync(() => checkPasswordRequestRateLimit(
      secondClient,
      'autre-personne@example.test',
      options
    ))
  })
})

test.serial('un contexte non signé ou invalide ne remplace jamais req.ip', async t => {
  await withAuditContextSecret(async () => {
    const encodedContext = createSignedHeaders('203.0.113.20')['x-ple-audit-context']
    const directIp = '198.51.100.20'
    const directRequest = createRequest({ip: directIp})
    const unsignedRequest = createRequest({
      headers: {'x-ple-audit-context': encodedContext},
      ip: directIp
    })
    const tamperedRequest = createRequest({
      headers: {
        'x-ple-audit-context': encodedContext,
        'x-ple-audit-signature': '0'.repeat(64)
      },
      ip: directIp
    })

    t.is(resolvePasswordRateLimitClientIp(unsignedRequest), directIp)
    t.is(resolvePasswordRateLimitClientIp(tamperedRequest), directIp)
    t.is(resolvePasswordRateLimitClientIp(directRequest), directIp)
  })
})

test.serial('un appel direct sans contexte signé utilise req.ip', async t => {
  await withAuditContextSecret(async () => {
    const redis = createCountingRedis()
    const options = {redis, pepperVersion: 1, readPepper}
    const firstRequest = createRequest({ip: '198.51.100.30'})
    const secondRequest = createRequest({ip: '198.51.100.31'})

    await checkPasswordRequestRateLimit(firstRequest, 'direct-1@example.test', options)
    await checkPasswordRequestRateLimit(secondRequest, 'direct-2@example.test', options)

    const ipKeys = [...redis.counts.keys()].filter(key => key.includes(':ip:'))
    t.is(ipKeys.length, 2)
  })
})
