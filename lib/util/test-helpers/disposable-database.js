import process from 'node:process'

export function requireDisposableDatabase(databaseUrl = process.env.DATABASE_URL, environment = process.env) {
  const invalid = () => new Error('Les tests d’intégration exigent une base PostgreSQL jetable locale ou un service CI dédié.')
  let url
  let name
  try {
    url = new URL(databaseUrl)
    name = decodeURIComponent(url.pathname.slice(1))
  } catch {
    throw invalid()
  }

  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  const ci = environment.CI === 'true' && url.hostname === 'postgres'
  if (environment.NODE_ENV !== 'test'
    || !['postgres:', 'postgresql:'].includes(url.protocol)
    || (!local && !ci)
    || !['campaign_tests', 'security_tests'].includes(name)
    || (local && url.port !== '55439')
    || (ci && !['', '5432'].includes(url.port))
    // PostgreSQL query options can override host/port and other connection properties.
    || url.search !== ''
    || url.hash !== '') {
    throw invalid()
  }

  return url
}
