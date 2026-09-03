import process from 'node:process'

const ALLOWED_ENVIRONMENTS = new Set(['development', 'local', 'demo'])
const MUTABLE_ENVIRONMENTS = new Set(['development', 'local'])
const CONFIRMATION_PREFIX = 'APPLY_LEGACY_AQUASYS'
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function assertLoopbackUrl(environment, variableName, protocols, {required = true} = {}) {
  const rawValue = environment[variableName]?.trim()
  if (!rawValue) {
    if (required) {
      throw new Error(`Écriture legacy refusée : ${variableName} est requise.`)
    }

    return
  }

  let url
  try {
    url = new URL(rawValue)
  } catch {
    throw new Error(`Écriture legacy refusée : ${variableName} est invalide.`)
  }

  if (!protocols.has(url.protocol)) {
    throw new Error(`Écriture legacy refusée : protocole ${variableName} interdit.`)
  }

  if (!LOOPBACK_HOSTS.has(url.hostname) && !/^127(?:\.\d{1,3}){3}$/.test(url.hostname)) {
    throw new Error(`Écriture legacy refusée : ${variableName} doit cibler loopback.`)
  }

  if (url.search || url.hash) {
    throw new Error(
      `Écriture legacy refusée : ${variableName} ne doit contenir ni paramètre ni fragment.`
    )
  }
}

function assertLocalMutationTargets(environment, {requireLocalServices}) {
  assertLoopbackUrl(
    environment,
    'DATABASE_URL',
    new Set(['postgres:', 'postgresql:'])
  )

  if (!requireLocalServices) {
    return
  }

  assertLoopbackUrl(environment, 'S3_ENDPOINT', new Set(['http:', 'https:']))
  assertLoopbackUrl(environment, 'REDIS_URL', new Set(['redis:', 'rediss:']))
  assertLoopbackUrl(
    environment,
    'ORCHESTRATION_BASE_URL',
    new Set(['http:', 'https:'])
  )
}

export function getLegacyEnvironment(environment = process.env) {
  const value = environment.APP_ENV || environment.NODE_ENV || 'development'
  const normalized = value.trim().toLowerCase()

  if (!ALLOWED_ENVIRONMENTS.has(normalized)) {
    throw new Error(
      `Refus legacy Aquasys : environnement ${normalized || 'vide'} interdit ; `
      + 'seuls development, local et demo sont autorisés.'
    )
  }

  return normalized
}

export function legacyConfirmationFor(environmentName) {
  return `${CONFIRMATION_PREFIX}:${environmentName}`
}

export function authorizeLegacyDemoMutation({
  arguments_ = process.argv.slice(2),
  environment = process.env,
  requireLocalServices = false
} = {}) {
  const environmentName = getLegacyEnvironment(environment)
  let apply = false
  let confirmation

  for (const argument of arguments_) {
    if (argument === '--apply') {
      if (apply) {
        throw new Error('Option legacy --apply dupliquée.')
      }

      apply = true
      continue
    }

    if (argument.startsWith('--confirm-legacy=')) {
      if (confirmation !== undefined) {
        throw new Error('Option legacy --confirm-legacy dupliquée.')
      }

      confirmation = argument.slice('--confirm-legacy='.length)
      continue
    }

    throw new Error(`Argument legacy inconnu : ${argument}`)
  }

  const expectedConfirmation = legacyConfirmationFor(environmentName)
  if (!apply) {
    if (confirmation !== undefined) {
      throw new Error('--confirm-legacy exige --apply.')
    }

    return {
      authorized: false,
      dryRun: true,
      environmentName,
      expectedConfirmation
    }
  }

  if (confirmation !== expectedConfirmation) {
    throw new Error(
      `Écriture legacy refusée : ajouter --confirm-legacy=${expectedConfirmation}`
    )
  }

  if (!environment.APP_ENV?.trim()) {
    throw new Error('Écriture legacy refusée : APP_ENV doit être explicitement définie.')
  }

  if (!MUTABLE_ENVIRONMENTS.has(environmentName)) {
    throw new Error(
      'Écriture legacy refusée : les cibles demo et distantes sont neutralisées.'
    )
  }

  assertLocalMutationTargets(environment, {requireLocalServices})

  return {
    authorized: true,
    dryRun: false,
    environmentName,
    expectedConfirmation
  }
}

export function printLegacyAuthorization(authorization, scope) {
  console.log(
    `[legacy-aquasys] cible=${authorization.environmentName} périmètre=${scope}`
  )

  if (authorization.dryRun) {
    console.log('[legacy-aquasys] dry-run : aucune écriture effectuée')
    if (authorization.environmentName === 'demo') {
      console.log('[legacy-aquasys] application distante neutralisée ; utiliser un environnement local')
    } else {
      console.log(
        '[legacy-aquasys] application locale explicite : --apply '
        + `--confirm-legacy=${authorization.expectedConfirmation}`
      )
    }
  }
}
