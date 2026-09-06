// Prisma's Rust migration engine does not use node-postgres/libpq TLS options.
// Keep the application URL strict, and translate its TLS dialect for the CLI.
export function getPrismaDatabaseUrl(databaseUrl) {
  if (!databaseUrl) {
    return databaseUrl
  }

  let parsed
  try {
    parsed = new URL(databaseUrl)
  } catch {
    throw new Error('DATABASE_URL invalide pour Prisma.')
  }

  if (!parsed.searchParams.getAll('sslmode').includes('verify-full')) {
    return databaseUrl
  }

  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslaccept']) {
    if (parsed.searchParams.getAll(key).length > 1) {
      throw new Error('Paramètres TLS PostgreSQL dupliqués.')
    }
  }

  if (parsed.searchParams.has('sslaccept')
    && parsed.searchParams.get('sslaccept') !== 'strict') {
    throw new Error('Refus de désactiver la validation TLS Prisma.')
  }

  const rootCertificate = parsed.searchParams.get('sslrootcert')
  const prismaCertificate = parsed.searchParams.get('sslcert')
  if (rootCertificate && prismaCertificate && rootCertificate !== prismaCertificate) {
    throw new Error('Certificats TLS PostgreSQL contradictoires.')
  }

  parsed.searchParams.set('sslmode', 'require')
  parsed.searchParams.set('sslaccept', 'strict')
  if (rootCertificate) {
    parsed.searchParams.set('sslcert', rootCertificate)
  }

  parsed.searchParams.delete('sslrootcert')
  return parsed.toString()
}
