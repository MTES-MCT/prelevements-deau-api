import test from 'ava'
import {Buffer} from 'node:buffer'

import {
  hashPassword,
  parsePasswordHash,
  validatePasswordPolicy,
  verifyPassword
} from '../password.js'

const PEPPERS = {
  1: 'pepper-version-un-avec-trente-deux-octets-minimum',
  2: 'pepper-version-deux-avec-trente-deux-octets-minimum'
}

const readPepper = version => PEPPERS[version]

test('hashPassword utilise Argon2id avec un sel distinct par credential', async t => {
  const first = await hashPassword('Une phrase vraiment longue et sûre !', {
    pepperVersion: 1,
    pepper: PEPPERS[1]
  })
  const second = await hashPassword('Une phrase vraiment longue et sûre !', {
    pepperVersion: 1,
    pepper: PEPPERS[1]
  })

  t.not(first.passwordHash, second.passwordHash)
  t.truthy(parsePasswordHash(first.passwordHash))

  const verification = await verifyPassword(
    'Une phrase vraiment longue et sûre !',
    first,
    {currentPepperVersion: 1, readPepper}
  )
  t.true(verification.valid)
  t.false(verification.needsRehash)
})

test('verifyPassword normalise Unicode en NFC et refuse un mauvais secret', async t => {
  const decomposed = 'Phrase tre\u0300s longue, unique et robuste !'
  const credential = await hashPassword(decomposed, {
    pepperVersion: 1,
    pepper: PEPPERS[1]
  })

  const valid = await verifyPassword(
    decomposed.normalize('NFC'),
    credential,
    {currentPepperVersion: 1, readPepper}
  )
  const invalid = await verifyPassword(
    'Phrase complètement différente et robuste !',
    credential,
    {currentPepperVersion: 1, readPepper}
  )

  t.true(valid.valid)
  t.false(invalid.valid)
})

test('verifyPassword demande un rehash après rotation du pepper', async t => {
  const credential = await hashPassword('Une autre phrase vraiment longue et sûre !', {
    pepperVersion: 1,
    pepper: PEPPERS[1]
  })
  const verification = await verifyPassword(
    'Une autre phrase vraiment longue et sûre !',
    credential,
    {currentPepperVersion: 2, readPepper}
  )

  t.true(verification.valid)
  t.true(verification.needsRehash)
})

test('parsePasswordHash refuse des paramètres susceptibles d’épuiser les ressources', t => {
  const salt = Buffer.alloc(16).toString('base64url')
  const hash = Buffer.alloc(32).toString('base64url')

  t.is(parsePasswordHash(`$argon2id$v=19$m=999999999,t=3,p=1$${salt}$${hash}`), null)
  t.is(parsePasswordHash(`$argon2id$v=19$m=65536,t=999,p=1$${salt}$${hash}`), null)
  t.is(parsePasswordHash(`$argon2id$v=19$m=65536,t=3,p=999$${salt}$${hash}`), null)
})

test('validatePasswordPolicy impose 15 à 128 caractères et rejette les secrets prévisibles', t => {
  t.throws(() => validatePasswordPolicy('trop court'))
  t.throws(() => validatePasswordPolicy('motdepassemotdepasse'), {
    message: /trop courant ou trop prévisible/
  })
  t.is(
    validatePasswordPolicy('Deux grandes rivières courent vite ! 2048'),
    'Deux grandes rivières courent vite ! 2048'
  )
  t.throws(() => validatePasswordPolicy('x'.repeat(129)))
  t.throws(() => validatePasswordPolicy('x'.repeat(1_000_000)))
})
