import {createHash} from 'node:crypto'
import {readFile, stat} from 'node:fs/promises'
import path from 'node:path'

import dotenvFlow from 'dotenv-flow'

const TARGET_POLICY_VERSION = 1
export const ACCOUNT_KEYS = Object.freeze([
  'ddt',
  'sage',
  'ougc',
  'industrial',
  'aep',
  'irrigant'
])
const SHA256_PATTERN = /^[a-f\d]{64}$/
const PRODUCTION_PATTERN = /(^|[^a-z\d])prod(?:uction)?([^a-z\d]|$)/i
const DEMO_CA_SHA256 = '02b128cdf513b45aa87756a25d876c271ee622cf87a1366795868a71d549c1c4'
const KNOWN_PRODUCTION_DATABASE_HOSTS = new Set([
  '51.15.219.67',
  'rw-08e5c5a3-05af-4771-b994-fe2ad901c7b7.rdb.fr-par.scw.cloud'
])
const KNOWN_PRODUCTION_DATABASE_NAMES = new Set(['prod-partageons-leau-api'])
const SENSITIVE_KEY_PATTERN = /password|passwd|secret|token|authorization|credential|private.?key|api.?key|access.?key/i
const SENSITIVE_ENV_KEYS = new Set([
  'DATABASE_URL',
  'DATABASE_ADMIN_URL',
  'PGPASSWORD',
  'REDIS_URL',
  'SMTP_PASSWORD'
])

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value
  }

  Object.freeze(value)
  for (const item of Object.values(value)) {
    deepFreeze(item)
  }

  return value
}

export const BUILTIN_TARGET_POLICIES = deepFreeze({
  local: {
    version: TARGET_POLICY_VERSION,
    name: 'local',
    production: false,
    appEnvironments: ['local', 'development'],
    database: {
      mode: 'loopback',
      tls: false
    }
  },
  demo: {
    version: TARGET_POLICY_VERSION,
    name: 'demo',
    production: false,
    appEnvironments: ['demo'],
    database: {
      mode: 'exact',
      hosts: [
        '163.172.7.73',
        'rw-ea5a07db-05df-4869-9e57-fa5f5c6c81cc.rdb.fr-par.scw.cloud'
      ],
      port: '17063',
      name: 'prelevements_demo',
      user: 'prelevements_demo_app',
      tls: true,
      caSha256: DEMO_CA_SHA256
    }
  }
})

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function assertOnlyKeys(value, allowedKeys, label) {
  const unexpectedKeys = Object.keys(value).filter(key => !allowedKeys.has(key))
  if (unexpectedKeys.length > 0) {
    throw new Error(`${label}: propriété(s) inconnue(s) : ${unexpectedKeys.join(', ')}`)
  }
}

function assertString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} doit être une chaîne non vide`)
  }

  return value.trim()
}

function assertNotKnownProductionDatabase({hosts = [], name, user}, label) {
  if (hosts.some(host => KNOWN_PRODUCTION_DATABASE_HOSTS.has(host.toLowerCase()))
    || KNOWN_PRODUCTION_DATABASE_NAMES.has(name)
    || KNOWN_PRODUCTION_DATABASE_NAMES.has(user)) {
    throw new Error(`${label} : cible production interdite`)
  }
}

function isSensitiveKey(key) {
  return SENSITIVE_ENV_KEYS.has(String(key).toUpperCase()) || SENSITIVE_KEY_PATTERN.test(key)
}

function assertPolicyContainsNoSecrets(value, trail = 'policy') {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertPolicyContainsNoSecrets(item, `${trail}[${index}]`)
    }

    return
  }

  if (!isPlainObject(value)) {
    return
  }

  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      throw new Error(`${trail}.${key}: un fichier de policy ne doit contenir aucun secret`)
    }

    assertPolicyContainsNoSecrets(item, `${trail}.${key}`)
  }
}

function validateCustomPolicy(rawPolicy) {
  if (!isPlainObject(rawPolicy)) {
    throw new Error('La policy custom doit être un objet JSON')
  }

  assertPolicyContainsNoSecrets(rawPolicy)
  assertOnlyKeys(
    rawPolicy,
    new Set(['version', 'name', 'production', 'appEnv', 'database']),
    'Policy custom'
  )

  if (rawPolicy.version !== TARGET_POLICY_VERSION) {
    throw new Error(`Policy custom : version attendue ${TARGET_POLICY_VERSION}`)
  }

  if (rawPolicy.production !== false) {
    throw new Error('Policy custom : production doit valoir exactement false')
  }

  const name = assertString(rawPolicy.name, 'Policy custom.name')
  const appEnv = assertString(rawPolicy.appEnv, 'Policy custom.appEnv')
  if (PRODUCTION_PATTERN.test(name) || PRODUCTION_PATTERN.test(appEnv)) {
    throw new Error('Policy custom : cible production interdite')
  }

  if (!isPlainObject(rawPolicy.database)) {
    throw new Error('Policy custom.database doit être un objet')
  }

  assertOnlyKeys(
    rawPolicy.database,
    new Set(['host', 'port', 'name', 'user', 'tls', 'caSha256']),
    'Policy custom.database'
  )
  const database = {
    mode: 'exact',
    hosts: [assertString(rawPolicy.database.host, 'Policy custom.database.host').toLowerCase()],
    port: String(rawPolicy.database.port ?? '').trim(),
    name: assertString(rawPolicy.database.name, 'Policy custom.database.name'),
    user: assertString(rawPolicy.database.user, 'Policy custom.database.user'),
    tls: rawPolicy.database.tls,
    caSha256: rawPolicy.database.caSha256?.toLowerCase()
  }
  if (!/^\d{1,5}$/.test(database.port)
    || Number(database.port) < 1
    || Number(database.port) > 65_535) {
    throw new Error('Policy custom.database.port doit être un port valide')
  }

  if (typeof database.tls !== 'boolean') {
    throw new TypeError('Policy custom.database.tls doit être un booléen')
  }

  if (database.tls && !SHA256_PATTERN.test(database.caSha256 ?? '')) {
    throw new Error('Policy custom.database.caSha256 doit être un SHA-256 hexadécimal')
  }

  if (!database.tls && rawPolicy.database.caSha256 !== undefined) {
    throw new Error('Policy custom.database.caSha256 est interdit quand TLS est désactivé')
  }

  const policy = {
    version: TARGET_POLICY_VERSION,
    name,
    production: false,
    appEnvironments: [appEnv],
    database
  }
  assertNoProductionClues([
    policy.name,
    ...policy.appEnvironments,
    ...policy.database.hosts,
    policy.database.name,
    policy.database.user
  ], 'Policy custom')
  assertNotKnownProductionDatabase(policy.database, 'Policy custom')

  return deepFreeze(policy)
}

async function assertPrivateInputFile(filePath, label) {
  const fileStat = await stat(filePath)
  if (!fileStat.isFile()) {
    throw new Error(`${label} doit être un fichier ordinaire`)
  }

  if ((fileStat.mode & 0o077) !== 0) {
    throw new Error(`${label} est trop permissif ; appliquer chmod 600`)
  }
}

function assertSafeInputPath(filePath, label) {
  const normalized = assertString(filePath, label)
  if (PRODUCTION_PATTERN.test(path.basename(normalized))) {
    throw new Error(`${label} : fichier de production interdit`)
  }

  return normalized
}

async function readJsonObject(filePath, label, {privateFile = true} = {}) {
  if (privateFile) {
    await assertPrivateInputFile(filePath, label)
  } else {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) {
      throw new Error(`${label} doit être un fichier ordinaire`)
    }
  }

  let parsed
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SyntaxError(`${label} contient un JSON invalide`, {cause: error})
    }

    throw error
  }

  if (!isPlainObject(parsed) && !Array.isArray(parsed)) {
    throw new TypeError(`${label} doit contenir un objet ou un tableau JSON`)
  }

  return parsed
}

export async function loadTargetEnvironment(filePath) {
  const safePath = assertSafeInputPath(filePath, '--target-env')
  await assertPrivateInputFile(safePath, '--target-env')

  // Parse() lit exclusivement ce fichier et ne fusionne rien dans process.env.
  return Object.freeze(dotenvFlow.parse(safePath))
}

function normalizeEmail(value, label) {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} doit être une adresse email`)
  }

  const email = value.normalize('NFC').trim().toLowerCase()
  const parts = email.split('@')
  const [localPart, domain] = parts
  const domainLabels = domain?.split('.') ?? []
  const hasValidDomain = domainLabels.length >= 2 && domainLabels.every(item => (
    item.length > 0
    && item.length <= 63
    && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(item)
  ))
  if (email.length > 254
    || parts.length !== 2
    || !localPart
    || localPart.length > 64
    || localPart.startsWith('.')
    || localPart.endsWith('.')
    || localPart.includes('..')
    || !/^[\w.!#$%&'*+/=?^`{|}~-]+$/i.test(localPart)
    || !hasValidDomain) {
    throw new Error(`${label} doit être une adresse email valide`)
  }

  return email
}

export async function loadAccounts(filePath) {
  const safePath = assertSafeInputPath(filePath, '--accounts')
  const rawAccounts = await readJsonObject(safePath, '--accounts')
  if (!isPlainObject(rawAccounts)) {
    throw new Error('--accounts doit contenir un objet JSON')
  }

  assertOnlyKeys(rawAccounts, new Set(ACCOUNT_KEYS), '--accounts')
  const missingKeys = ACCOUNT_KEYS.filter(key => !Object.hasOwn(rawAccounts, key))
  if (missingKeys.length > 0) {
    throw new Error(`--accounts : compte(s) manquant(s) : ${missingKeys.join(', ')}`)
  }

  const normalizedAccounts = {}
  const ownersByEmail = new Map()
  for (const key of ACCOUNT_KEYS) {
    const email = normalizeEmail(rawAccounts[key], `--accounts.${key}`)
    const existingOwner = ownersByEmail.get(email)
    if (existingOwner) {
      throw new Error(`--accounts : ${key} et ${existingOwner} utilisent le même email`)
    }

    normalizedAccounts[key] = email
    ownersByEmail.set(email, key)
  }

  return Object.freeze(normalizedAccounts)
}

export async function loadTargetPolicy(filePath) {
  const safePath = assertSafeInputPath(filePath, '--target-policy')
  const rawPolicy = await readJsonObject(safePath, '--target-policy', {privateFile: false})
  return validateCustomPolicy(rawPolicy)
}

export async function loadExclusiveSeedInputs(options) {
  const [targetEnvironment, accounts, targetPolicy] = await Promise.all([
    loadTargetEnvironment(options.targetEnv),
    loadAccounts(options.accounts),
    options.target === 'custom' ? loadTargetPolicy(options.targetPolicy) : undefined
  ])

  return Object.freeze({targetEnvironment, accounts, targetPolicy})
}

function isLoopbackHostname(hostname) {
  const lowerHostname = hostname.toLowerCase()
  const unbracketedHostname = lowerHostname.startsWith('[') && lowerHostname.endsWith(']')
    ? lowerHostname.slice(1, -1)
    : lowerHostname
  const normalized = unbracketedHostname.endsWith('.')
    ? unbracketedHostname.slice(0, -1)
    : unbracketedHostname
  return normalized === 'localhost'
    || normalized === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

function assertNoProductionClues(values, label = 'Cible') {
  if (values.filter(Boolean).some(value => PRODUCTION_PATTERN.test(String(value)))) {
    throw new Error(`${label} : cible production interdite`)
  }
}

function requireEnvironmentValue(environment, key) {
  const value = environment[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`--target-env : variable ${key} manquante`)
  }

  return value.trim()
}

async function parseDatabaseIdentity(environment) {
  const rawDatabaseUrl = requireEnvironmentValue(environment, 'DATABASE_URL')
  let databaseUrl
  try {
    databaseUrl = new URL(rawDatabaseUrl)
  } catch {
    throw new Error('--target-env : DATABASE_URL invalide')
  }

  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
    throw new Error('--target-env : DATABASE_URL doit utiliser PostgreSQL')
  }

  if (!databaseUrl.hostname || !databaseUrl.username || !databaseUrl.password) {
    throw new Error('--target-env : DATABASE_URL doit contenir hôte, utilisateur et mot de passe')
  }

  if (databaseUrl.hash) {
    throw new Error('--target-env : DATABASE_URL ne doit contenir aucun fragment')
  }

  const allowedSearchParameters = new Set(['sslmode', 'sslrootcert'])
  for (const key of new Set(databaseUrl.searchParams.keys())) {
    if (!allowedSearchParameters.has(key)) {
      throw new Error(`--target-env : paramètre DATABASE_URL interdit (${key})`)
    }

    if (databaseUrl.searchParams.getAll(key).length !== 1) {
      throw new Error(`--target-env : paramètre DATABASE_URL dupliqué (${key})`)
    }
  }

  const sslMode = databaseUrl.searchParams.get('sslmode')
  const certificatePath = databaseUrl.searchParams.get('sslrootcert')
  const tls = sslMode === 'verify-full'
  if ((sslMode || certificatePath) && (!tls || !certificatePath)) {
    throw new Error('--target-env : TLS PostgreSQL exige sslmode=verify-full et sslrootcert')
  }

  let caSha256
  if (certificatePath) {
    if (!path.isAbsolute(certificatePath)) {
      throw new Error('--target-env : sslrootcert doit être un chemin absolu')
    }

    caSha256 = sha256(await readFile(certificatePath))
  }

  const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\//, ''))
  if (!databaseName) {
    throw new Error('--target-env : DATABASE_URL doit nommer une base')
  }

  return {
    host: databaseUrl.hostname.toLowerCase(),
    port: databaseUrl.port || '5432',
    name: databaseName,
    user: decodeURIComponent(databaseUrl.username),
    tls,
    caSha256: caSha256 ?? null
  }
}

function resolvePolicy(target, targetPolicy) {
  if (target === 'custom') {
    if (!targetPolicy) {
      throw new Error('Une policy validée est requise pour la cible custom')
    }

    return targetPolicy
  }

  const policy = BUILTIN_TARGET_POLICIES[target]
  if (!policy) {
    throw new Error(`Cible interdite : ${target}`)
  }

  return policy
}

function assertDatabaseMatchesPolicy(database, policy, target) {
  if (policy.mode === 'loopback') {
    if (!isLoopbackHostname(database.host)) {
      throw new Error(`Cible ${target} : PostgreSQL doit être loopback`)
    }

    if (database.tls !== policy.tls) {
      throw new Error(`Cible ${target} : configuration TLS PostgreSQL non autorisée`)
    }

    return
  }

  const expected = {
    host: policy.hosts,
    port: policy.port,
    name: policy.name,
    user: policy.user,
    tls: policy.tls,
    caSha256: policy.tls ? policy.caSha256 : null
  }
  const comparisons = {
    host: expected.host.includes(database.host),
    port: database.port === expected.port,
    name: database.name === expected.name,
    user: database.user === expected.user,
    tls: database.tls === expected.tls,
    caSha256: database.caSha256 === expected.caSha256
  }
  const mismatch = Object.entries(comparisons).find(([, matches]) => !matches)
  if (mismatch) {
    throw new Error(`Cible ${target} : identité PostgreSQL non autorisée (${mismatch[0]})`)
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    )
  }

  return value
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value))
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export async function buildTargetAttestation({
  target,
  targetEnvironment,
  targetPolicy,
  dataset,
  datasetSha256,
  accountsSha256
}) {
  const policy = resolvePolicy(target, targetPolicy)
  if (policy.production !== false) {
    throw new Error(`Cible ${target} : production interdite`)
  }

  const database = await parseDatabaseIdentity(targetEnvironment)
  const appEnv = requireEnvironmentValue(targetEnvironment, 'APP_ENV')
  if (!policy.appEnvironments.includes(appEnv)) {
    throw new Error(
      `Cible ${target} : APP_ENV doit valoir ${policy.appEnvironments.join(' ou ')}`
    )
  }

  assertNoProductionClues([
    appEnv,
    targetEnvironment.SCALINGO_APP_NAME,
    targetEnvironment.SCW_CONTAINER_NAME,
    database.host,
    database.name,
    database.user
  ])
  assertNotKnownProductionDatabase({
    hosts: [database.host],
    name: database.name,
    user: database.user
  }, 'Cible')
  assertDatabaseMatchesPolicy(database, policy.database, target)

  const datasetName = assertString(dataset, 'dataset')
  const effectiveDatasetSha256 = datasetSha256 ?? sha256(datasetName)
  if (!SHA256_PATTERN.test(effectiveDatasetSha256)) {
    throw new Error('datasetSha256 doit être un SHA-256 hexadécimal')
  }

  if (!SHA256_PATTERN.test(accountsSha256 ?? '')) {
    throw new Error('accountsSha256 doit être un SHA-256 hexadécimal')
  }

  const policySha256 = sha256(stableStringify(policy))
  const safeIdentity = {
    target,
    policyName: policy.name,
    policySha256,
    appEnv,
    dataset: datasetName,
    datasetSha256: effectiveDatasetSha256,
    database
  }
  const fingerprint = sha256(stableStringify({
    ...safeIdentity,
    accountsSha256
  })).slice(0, 12)

  return {
    ...safeIdentity,
    fingerprint,
    confirmation: `${target}:${fingerprint}`
  }
}

export function assertApplyConfirmation(options, attestation) {
  if (!options.apply) {
    return {authorized: false, dryRun: options.command === 'apply'}
  }

  if (options.command !== 'apply') {
    throw new Error('--apply est réservé à la commande apply')
  }

  if (attestation.target !== options.target) {
    throw new Error('L’attestation ne correspond pas à la cible demandée')
  }

  if (options.confirmTarget !== attestation.confirmation) {
    throw new Error(
      `Écriture refusée : ajouter --confirm-target ${attestation.confirmation}`
    )
  }

  return {authorized: true, dryRun: false}
}

function redactUrlCredentials(value) {
  if (typeof value !== 'string' || !value.includes('://')) {
    return value
  }

  try {
    const url = new URL(value)
    if (!url.password) {
      return value
    }

    url.password = '[REDACTED]'
    return url.toString()
  } catch {
    return value.replaceAll(/(:\/\/[^:@/\s]+:)[^@/\s]+@/g, '$1[REDACTED]@')
  }
}

export function redactSensitive(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    return value.map(item => redactSensitive(item, seen))
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (!value || typeof value !== 'object') {
    return redactUrlCredentials(value)
  }

  if (seen.has(value)) {
    return '[CIRCULAR]'
  }

  seen.add(value)
  const redacted = {}
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key)
      ? '[REDACTED]'
      : redactSensitive(item, seen)
  }

  seen.delete(value)
  return redacted
}
