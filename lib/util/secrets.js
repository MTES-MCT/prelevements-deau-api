import {randomBytes, scryptSync, timingSafeEqual, createHash, randomUUID} from 'node:crypto'

const SCRYPT_KEYLEN = 64

export function generateOpaqueToken() {
  return `${randomUUID()}${randomBytes(24).toString('hex')}`
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

export function hashSecret(secret) {
  const salt = randomBytes(16).toString('hex')
  const derivedKey = scryptSync(secret, salt, SCRYPT_KEYLEN).toString('hex')
  return `${salt}:${derivedKey}`
}

export function verifySecret(secret, storedHash) {
  const [salt, expectedHex] = storedHash.split(':')
  if (!salt || !expectedHex) {
    return false
  }

  const actual = scryptSync(secret, salt, SCRYPT_KEYLEN)
  const expected = Buffer.from(expectedHex, 'hex')

  if (actual.length !== expected.length) {
    return false
  }

  return timingSafeEqual(actual, expected)
}
