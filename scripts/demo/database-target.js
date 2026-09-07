const EXPECTED_DATABASE_NAME = 'prelevements_demo'
const EXPECTED_DATABASE_USER = 'demo_admin'
const EXPECTED_DATABASE_PORT = '17063'
const EXPECTED_SSL_MODE = 'verify-full'
const EXPECTED_SSL_ROOT_CERT = '/usr/local/share/ca-certificates/scw-postgres-ca.crt'
const EXPECTED_DATABASE_HOSTS = new Set([
  '163.172.7.73',
  'rw-ea5a07db-05df-4869-9e57-fa5f5c6c81cc.rdb.fr-par.scw.cloud'
])
const ALLOWED_SEARCH_PARAMETERS = new Set(['sslmode', 'sslrootcert'])

const DATABASE_IDENTITY_QUERY = `
  SELECT
    current_database()::text AS "databaseName",
    current_user::text AS "databaseUser",
    inet_server_addr()::text AS "serverAddress",
    inet_server_port()::integer AS "serverPort",
    COALESCE(
      (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()),
      false
    ) AS "tls"
`

function assertSafeSearchParameters(databaseUrl) {
  for (const key of new Set(databaseUrl.searchParams.keys())) {
    if (!ALLOWED_SEARCH_PARAMETERS.has(key)) {
      throw new Error(`Refus : paramètre DATABASE_URL interdit (${key}).`)
    }

    if (databaseUrl.searchParams.getAll(key).length !== 1) {
      throw new Error(`Refus : paramètre DATABASE_URL dupliqué (${key}).`)
    }
  }
}

export function validateDemoAdminDatabaseUrl(databaseUrl) {
  if (!databaseUrl?.trim()) {
    throw new Error('Refus : DATABASE_URL est absente.')
  }

  let parsedDatabaseUrl
  try {
    parsedDatabaseUrl = new URL(databaseUrl)
  } catch {
    throw new Error('Refus : DATABASE_URL est invalide.')
  }

  if (!['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol)) {
    throw new Error('Refus : DATABASE_URL doit utiliser PostgreSQL.')
  }

  if (parsedDatabaseUrl.hash) {
    throw new Error('Refus : DATABASE_URL ne doit contenir aucun fragment.')
  }

  assertSafeSearchParameters(parsedDatabaseUrl)

  const databaseName = decodeURIComponent(parsedDatabaseUrl.pathname.replace(/^\//, ''))
  const databaseUser = decodeURIComponent(parsedDatabaseUrl.username)

  if (databaseName !== EXPECTED_DATABASE_NAME) {
    throw new Error(`Refus : la base doit être ${EXPECTED_DATABASE_NAME}.`)
  }

  if (databaseUser !== EXPECTED_DATABASE_USER) {
    throw new Error(`Refus : l'utilisateur doit être ${EXPECTED_DATABASE_USER}.`)
  }

  if (!parsedDatabaseUrl.password) {
    throw new Error('Refus : DATABASE_URL doit contenir le mot de passe de migration.')
  }

  if (!EXPECTED_DATABASE_HOSTS.has(parsedDatabaseUrl.hostname.toLowerCase())) {
    throw new Error('Refus : DATABASE_URL ne cible pas l’instance PostgreSQL demo attendue.')
  }

  if (parsedDatabaseUrl.port !== EXPECTED_DATABASE_PORT) {
    throw new Error(`Refus : le port PostgreSQL demo doit être ${EXPECTED_DATABASE_PORT}.`)
  }

  if (parsedDatabaseUrl.searchParams.get('sslmode') !== EXPECTED_SSL_MODE) {
    throw new Error(`Refus : DATABASE_URL doit utiliser sslmode=${EXPECTED_SSL_MODE}.`)
  }

  if (parsedDatabaseUrl.searchParams.get('sslrootcert') !== EXPECTED_SSL_ROOT_CERT) {
    throw new Error(`Refus : DATABASE_URL doit utiliser sslrootcert=${EXPECTED_SSL_ROOT_CERT}.`)
  }

  return parsedDatabaseUrl
}

async function queryConnectedDatabaseIdentity(database) {
  if (typeof database?.query === 'function') {
    const result = await database.query(DATABASE_IDENTITY_QUERY)
    return result?.rows?.[0]
  }

  if (typeof database?.$queryRawUnsafe === 'function') {
    const rows = await database.$queryRawUnsafe(DATABASE_IDENTITY_QUERY)
    return rows?.[0]
  }

  throw new Error('Refus : client PostgreSQL invalide pour le contrôle de cible.')
}

export async function assertConnectedDemoAdminDatabase(database) {
  const identity = await queryConnectedDatabaseIdentity(database)

  if (!identity) {
    throw new Error('Refus : impossible de lire l’identité PostgreSQL connectée.')
  }

  const checks = [
    [identity.databaseName === EXPECTED_DATABASE_NAME, 'nom de base'],
    [identity.databaseUser === EXPECTED_DATABASE_USER, 'utilisateur'],
    [identity.tls === true, 'TLS']
  ]
  const failedCheck = checks.find(([matches]) => !matches)

  if (failedCheck) {
    throw new Error(
      `Refus : l’identité PostgreSQL connectée ne correspond pas à demo (${failedCheck[1]}).`
    )
  }

  return {
    databaseName: identity.databaseName,
    databaseUser: identity.databaseUser,
    serverAddress: identity.serverAddress,
    serverPort: Number(identity.serverPort),
    tls: true
  }
}
