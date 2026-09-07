import test from 'ava'

import {
  checkEmailVerificationConfirmationRateLimit,
  checkEmailVerificationRequestRateLimit,
  EMAIL_VERIFICATION_RATE_LIMITS
} from '../email-verification-rate-limit.js'

function request({email = 'personne@example.test', ip = '192.0.2.1', userId = 'user-1'} = {}) {
  return {
    body: {email},
    params: {},
    ip,
    socket: {},
    user: {id: userId},
    get() {
      return undefined
    }
  }
}

function redisResult(counts) {
  return {
    async eval(_script, keyCount, ...arguments_) {
      const keys = arguments_.slice(0, keyCount)
      const ttl = Number(arguments_.at(-1))
      return counts.slice(0, keys.length).flatMap(count => [count, ttl])
    }
  }
}

test('la limitation des demandes utilise trois empreintes sans exposer les identifiants', async t => {
  let redisArguments
  const redis = {
    async eval(...arguments_) {
      redisArguments = arguments_
      return [1, 1000, 1, 1000, 1, 1000]
    }
  }

  await checkEmailVerificationRequestRateLimit(request(), {
    redis,
    secret: 'test-secret'
  })

  const serialized = JSON.stringify(redisArguments)
  t.false(serialized.includes('personne@example.test'))
  t.false(serialized.includes('192.0.2.1'))
  t.false(serialized.includes('user-1'))
  t.is(redisArguments[1], 3)
})

test('la limitation des demandes refuse un dépassement par compte', async t => {
  const error = await t.throwsAsync(() => checkEmailVerificationRequestRateLimit(request(), {
    redis: redisResult([1, EMAIL_VERIFICATION_RATE_LIMITS.requestByUser + 1, 1]),
    secret: 'test-secret'
  }))

  t.is(error.statusCode, 429)
  t.is(error.retryAfterSeconds, 900)
})

test('la limitation des confirmations est fermée quand Redis échoue', async t => {
  const error = await t.throwsAsync(() => checkEmailVerificationConfirmationRateLimit(request(), {
    redis: {
      async eval() {
        throw new Error('redis indisponible')
      }
    },
    secret: 'test-secret'
  }))

  t.is(error.statusCode, 503)
})
