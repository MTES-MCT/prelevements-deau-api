import {
  argon2,
  randomBytes,
  timingSafeEqual
} from 'node:crypto'
import {Buffer} from 'node:buffer'
import {promisify} from 'node:util'

import {ZxcvbnFactory} from '@zxcvbn-ts/core'
import * as zxcvbnCommonPackage from '@zxcvbn-ts/language-common'
import * as zxcvbnFrPackage from '@zxcvbn-ts/language-fr'
import createHttpError from 'http-errors'

import {
  readCurrentPasswordPepperVersion,
  readPasswordPepper
} from '../config/auth.js'

const deriveArgon2 = promisify(argon2)

const ARGON2_VERSION = 19
const ARGON2_PARAMETERS = Object.freeze({
  memory: 65_536,
  passes: 3,
  parallelism: 1,
  tagLength: 32
})
const PASSWORD_MINIMUM_LENGTH = 15
const PASSWORD_MAXIMUM_LENGTH = 128
const PASSWORD_MAXIMUM_RAW_CODE_UNITS = 512
const MINIMUM_ZXCVBN_SCORE = 3
const ACCEPTED_HASH_LIMITS = Object.freeze({
  minimumMemory: 8192,
  maximumMemory: 262_144,
  maximumPasses: 10,
  maximumParallelism: 4,
  maximumSaltLength: 64
})
const DUMMY_SALT = Buffer.from('cGFydGFnZW9ucy1sZWF1LWR1bW15LXNhbHQ', 'base64url')
const DUMMY_HASH = Buffer.alloc(ARGON2_PARAMETERS.tagLength)

const passwordStrengthEstimator = new ZxcvbnFactory({
  translations: zxcvbnFrPackage.translations,
  dictionary: {
    ...zxcvbnCommonPackage.dictionary,
    ...zxcvbnFrPackage.dictionary
  },
  graphs: zxcvbnCommonPackage.adjacencyGraphs
})

function encodePasswordHash({salt, hash, parameters = ARGON2_PARAMETERS}) {
  return [
    '$argon2id',
    `v=${ARGON2_VERSION}`,
    `m=${parameters.memory},t=${parameters.passes},p=${parameters.parallelism}`,
    salt.toString('base64url'),
    hash.toString('base64url')
  ].join('$')
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function parsePasswordHash(encodedHash) {
  if (typeof encodedHash !== 'string') {
    return null
  }

  const parts = encodedHash.split('$')
  if (parts.length !== 6 || parts[0] !== '' || parts[1] !== 'argon2id' || parts[2] !== `v=${ARGON2_VERSION}`) {
    return null
  }

  const parameterParts = Object.fromEntries(
    parts[3].split(',').map(part => part.split('='))
  )
  const memory = parsePositiveInteger(parameterParts.m)
  const passes = parsePositiveInteger(parameterParts.t)
  const parallelism = parsePositiveInteger(parameterParts.p)

  if (!memory || !passes || !parallelism) {
    return null
  }

  if (
    memory < ACCEPTED_HASH_LIMITS.minimumMemory
    || memory > ACCEPTED_HASH_LIMITS.maximumMemory
    || passes > ACCEPTED_HASH_LIMITS.maximumPasses
    || parallelism > ACCEPTED_HASH_LIMITS.maximumParallelism
  ) {
    return null
  }

  try {
    const salt = Buffer.from(parts[4], 'base64url')
    const hash = Buffer.from(parts[5], 'base64url')

    if (
      salt.length < 16
      || salt.length > ACCEPTED_HASH_LIMITS.maximumSaltLength
      || hash.length !== ARGON2_PARAMETERS.tagLength
    ) {
      return null
    }

    return {
      salt,
      hash,
      parameters: {
        memory,
        passes,
        parallelism,
        tagLength: hash.length
      }
    }
  } catch {
    return null
  }
}

function normalizePassword(password) {
  if (typeof password !== 'string') {
    throw createHttpError(400, 'Le mot de passe est requis.')
  }

  if (password.length > PASSWORD_MAXIMUM_RAW_CODE_UNITS) {
    throw createHttpError(
      400,
      `Le mot de passe doit contenir au maximum ${PASSWORD_MAXIMUM_LENGTH} caractères.`
    )
  }

  return password.normalize('NFC')
}

function getPasswordLength(password) {
  return [...password].length
}

export function validatePasswordPolicy(password, userInputs = []) {
  const normalizedPassword = normalizePassword(password)
  const length = getPasswordLength(normalizedPassword)

  if (length < PASSWORD_MINIMUM_LENGTH || length > PASSWORD_MAXIMUM_LENGTH) {
    throw createHttpError(
      400,
      `Le mot de passe doit contenir entre ${PASSWORD_MINIMUM_LENGTH} et ${PASSWORD_MAXIMUM_LENGTH} caractères.`
    )
  }

  const normalizedUserInputs = userInputs
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => value.slice(0, 256).normalize('NFC'))
  const result = passwordStrengthEstimator.check(normalizedPassword, normalizedUserInputs)

  if (result.score < MINIMUM_ZXCVBN_SCORE) {
    const error = createHttpError(400, 'Ce mot de passe est trop courant ou trop prévisible.')
    error.data = {
      code: 'PASSWORD_TOO_WEAK',
      suggestions: result.feedback?.suggestions ?? []
    }
    throw error
  }

  return normalizedPassword
}

function normalizePasswordForVerification(password) {
  if (typeof password !== 'string' || password.length > PASSWORD_MAXIMUM_RAW_CODE_UNITS) {
    return ''
  }

  const normalized = password.normalize('NFC')
  return getPasswordLength(normalized) <= PASSWORD_MAXIMUM_LENGTH ? normalized : ''
}

async function derivePassword(password, salt, pepper, parameters) {
  return deriveArgon2('argon2id', {
    message: Buffer.from(password, 'utf8'),
    nonce: salt,
    parallelism: parameters.parallelism,
    tagLength: parameters.tagLength,
    memory: parameters.memory,
    passes: parameters.passes,
    secret: Buffer.from(pepper, 'utf8')
  })
}

export async function hashPassword(password, {
  pepperVersion = readCurrentPasswordPepperVersion(),
  pepper = readPasswordPepper(pepperVersion),
  salt = randomBytes(16)
} = {}) {
  const normalizedPassword = normalizePassword(password)
  const hash = await derivePassword(
    normalizedPassword,
    salt,
    pepper,
    ARGON2_PARAMETERS
  )

  return {
    passwordHash: encodePasswordHash({salt, hash}),
    pepperVersion
  }
}

export async function verifyPassword(password, credential, {
  currentPepperVersion = readCurrentPasswordPepperVersion(),
  readPepper = readPasswordPepper
} = {}) {
  const normalizedPassword = normalizePasswordForVerification(password)
  const parsedHash = parsePasswordHash(credential?.passwordHash)

  if (!parsedHash || !Number.isSafeInteger(credential?.pepperVersion)) {
    await derivePassword(
      normalizedPassword,
      DUMMY_SALT,
      readPepper(currentPepperVersion),
      ARGON2_PARAMETERS
    )
    return {valid: false, needsRehash: false}
  }

  const actualHash = await derivePassword(
    normalizedPassword,
    parsedHash.salt,
    readPepper(credential.pepperVersion),
    parsedHash.parameters
  )
  const valid = actualHash.length === parsedHash.hash.length
    && timingSafeEqual(actualHash, parsedHash.hash)
  const needsRehash = valid && (
    credential.pepperVersion !== currentPepperVersion
    || parsedHash.parameters.memory !== ARGON2_PARAMETERS.memory
    || parsedHash.parameters.passes !== ARGON2_PARAMETERS.passes
    || parsedHash.parameters.parallelism !== ARGON2_PARAMETERS.parallelism
    || parsedHash.parameters.tagLength !== ARGON2_PARAMETERS.tagLength
  )

  return {valid, needsRehash}
}

export async function runDummyPasswordVerification(password, options = {}) {
  return verifyPassword(password, {
    passwordHash: encodePasswordHash({salt: DUMMY_SALT, hash: DUMMY_HASH}),
    pepperVersion: options.currentPepperVersion ?? readCurrentPasswordPepperVersion()
  }, options)
}

export const PASSWORD_HASH_PARAMETERS = ARGON2_PARAMETERS
