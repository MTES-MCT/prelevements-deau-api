const EXPECTED_DATABASE_NAME = 'prelevements_demo'
const EXPECTED_DATABASE_USER = 'demo_admin'
const EXPECTED_DATABASE_PORT = '17063'
const EXPECTED_SSL_MODE = 'verify-full'
const EXPECTED_SSL_ROOT_CERT = '/usr/local/share/ca-certificates/scw-postgres-ca.crt'
const EXPECTED_DATABASE_HOSTS = new Set([
  '163.172.7.73',
  'rw-ea5a07db-05df-4869-9e57-fa5f5c6c81cc.rdb.fr-par.scw.cloud'
])

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
