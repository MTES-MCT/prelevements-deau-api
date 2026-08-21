import process from 'node:process'
import {Buffer} from 'node:buffer'

const DEFAULT_AUTH_METHODS = Object.freeze(['magic_link'])
const IMPLEMENTED_AUTH_METHODS = new Set(['magic_link', 'password'])
const MINIMUM_PEPPER_BYTES = 32

export function readAuthMethods(value = process.env.AUTH_METHODS) {
  if (value === undefined) {
    return [...DEFAULT_AUTH_METHODS]
  }

  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('AUTH_METHODS doit contenir au moins une méthode d’authentification.')
  }

  const methods = value.split(',').map(method => method.trim().toLowerCase())

  if (methods.some(method => !method)) {
    throw new Error('AUTH_METHODS contient une méthode vide.')
  }

  if (new Set(methods).size !== methods.length) {
    throw new Error('AUTH_METHODS ne doit pas contenir de doublon.')
  }

  const unknownMethods = methods.filter(method => !IMPLEMENTED_AUTH_METHODS.has(method))
  if (unknownMethods.length > 0) {
    throw new Error(`AUTH_METHODS contient des méthodes inconnues : ${unknownMethods.join(', ')}.`)
  }

  return methods
}

export function readCurrentPasswordPepperVersion(value = process.env.PASSWORD_PEPPER_CURRENT_VERSION) {
  const version = Number.parseInt(value ?? '', 10)

  if (!Number.isSafeInteger(version) || version < 1 || String(version) !== String(value).trim()) {
    throw new Error('PASSWORD_PEPPER_CURRENT_VERSION doit être un entier positif.')
  }

  return version
}

export function readPasswordPepper(version, environment = process.env) {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('Version de pepper invalide.')
  }

  const variableName = `PASSWORD_PEPPER_V${version}`
  const pepper = environment[variableName]

  if (typeof pepper !== 'string' || Buffer.byteLength(pepper, 'utf8') < MINIMUM_PEPPER_BYTES) {
    throw new Error(`${variableName} doit contenir au moins 32 octets.`)
  }

  return pepper
}

export function readPasswordActivationFrontUrl(value = process.env.FRONT_URL) {
  let frontUrl
  try {
    frontUrl = new URL(value)
  } catch {
    throw new Error('FRONT_URL doit être une URL HTTP(S) explicite et valide pour la méthode password.')
  }

  if (
    !['http:', 'https:'].includes(frontUrl.protocol)
    || frontUrl.username
    || frontUrl.password
    || frontUrl.search
    || frontUrl.hash
  ) {
    throw new Error('FRONT_URL doit être une URL HTTP(S) explicite et valide pour la méthode password.')
  }

  return frontUrl.toString().replace(/\/$/, '')
}

export function validateAuthConfig(environment = process.env) {
  const methods = readAuthMethods(environment.AUTH_METHODS)

  if (methods.includes('password')) {
    const currentPepperVersion = readCurrentPasswordPepperVersion(
      environment.PASSWORD_PEPPER_CURRENT_VERSION
    )
    readPasswordPepper(currentPepperVersion, environment)
    readPasswordActivationFrontUrl(environment.FRONT_URL)
  }

  return methods
}

export function isAuthMethodEnabled(method, methods = readAuthMethods()) {
  return methods.includes(method)
}

export const AUTH_METHODS = Object.freeze({
  MAGIC_LINK: 'magic_link',
  PASSWORD: 'password'
})
