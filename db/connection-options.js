import fs from 'node:fs'
import tls from 'node:tls'

const TLS_PARAMETERS = new Set(['sslmode', 'sslrootcert', 'sslcert', 'sslkey'])
const CONFLICTING_PARAMETERS = new Set([
  'host',
  'port',
  'user',
  'password',
  'database',
  'ssl',
  'sslaccept',
  'sslidentity',
  'sslnegotiation',
  'sslpassword',
  'uselibpqcompat'
])

/**
 * Preserve existing/local pg settings; make verify-full verify the URL identity
 * explicitly, including IP literals. pg otherwise checks "localhost" for IPs.
 */
export function getPostgresConnectionOptions(connectionString, options = {}) {
  if (!connectionString) {
    return {...options, connectionString}
  }

  let url
  try {
    url = new URL(connectionString)
  } catch {
    throw new Error('DATABASE_URL invalide.')
  }

  if (!url.searchParams.getAll('sslmode').includes('verify-full')) {
    return {...options, connectionString}
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash) {
    throw new Error('DATABASE_URL TLS doit être une URL PostgreSQL sans fragment.')
  }

  for (const name of url.searchParams.keys()) {
    if (CONFLICTING_PARAMETERS.has(name)) {
      throw new Error(`DATABASE_URL TLS : paramètre incompatible (${name}).`)
    }

    if (TLS_PARAMETERS.has(name) && url.searchParams.getAll(name).length !== 1) {
      throw new Error(`DATABASE_URL TLS : paramètre dupliqué (${name}).`)
    }
  }

  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  const ssl = {
    ...options.ssl,
    rejectUnauthorized: true,
    checkServerIdentity: (_servername, certificate) => tls.checkServerIdentity(hostname, certificate)
  }

  for (const [parameter, property] of [['sslrootcert', 'ca'], ['sslcert', 'cert'], ['sslkey', 'key']]) {
    if (url.searchParams.has(parameter)) {
      const filename = url.searchParams.get(parameter)
      if (!filename) {
        throw new Error(`DATABASE_URL TLS : chemin vide (${parameter}).`)
      }

      ssl[property] = fs.readFileSync(filename, 'utf8')
    }
  }

  // The pg client parses connectionString after the options object. Leaving sslmode or a
  // certificate URL parameter would replace this explicit ssl configuration.
  for (const parameter of TLS_PARAMETERS) {
    url.searchParams.delete(parameter)
  }

  return {...options, connectionString: url.toString(), ssl}
}
