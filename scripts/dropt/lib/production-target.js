import path from 'node:path'
import {validateProdAdminDatabaseUrl, assertConnectedProdAdminDatabase} from '../../network/prod-database-target.js'

const PROD_OPERATIONS = new Set(['apply', 'verify', 'enable-logins', 'seed-campaign'])

export function assertDroptTargetOptions({operation, target, targetEnv, tunnelPort, apply = false, againstReport}) {
  if (!['local', 'testing', 'prod'].includes(target)) throw new Error('Cible explicite local, testing ou prod obligatoire.')
  if (['review', 'rebuild', 'recompute-rebuild'].includes(operation) && target !== 'testing') {
    throw new Error('La correction en ligne est réservée à testing.')
  }
  if (target !== 'prod') return
  if (!PROD_OPERATIONS.has(operation)) throw new Error('Cette opération Dropt est interdite en production.')
  if (!targetEnv) throw new Error('--target-env explicite obligatoire pour la production.')
  if (!/^\d+$/.test(tunnelPort ?? '') || Number(tunnelPort) < 1024 || Number(tunnelPort) > 65535) {
    throw new Error('--tunnel-port local explicite entre 1024 et 65535 obligatoire pour la production.')
  }
  if (operation === 'verify' && apply) throw new Error('La vérification de production reste en lecture seule.')
  if (apply && !againstReport) throw new Error('--against-report simulation de production obligatoire avant application.')
}

export function getDroptProdDatabaseUrl(databaseUrl) {
  // Validate the deployed identity before changing only the local CA path.
  // A local tunnel must never turn an arbitrary URL into an authorized target.
  const url = validateProdAdminDatabaseUrl(databaseUrl)
  url.searchParams.set('sslrootcert', path.resolve('deploy/certs/prod/postgres-ca.pem'))
  return url
}

export async function assertDroptConnectedDatabase(client, {target, url}) {
  if (target === 'prod') return assertConnectedProdAdminDatabase(client)
  const [identity] = await client.$queryRaw`SELECT current_database() AS name, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls`
  if (identity.name !== decodeURIComponent(url.pathname.slice(1)) || (target === 'testing' && !identity.tls)) {
    throw new Error('Identité ou TLS de la base incorrect.')
  }
}

export function assertDroptProdReport(report, {operation, manifestHash, apply = false}) {
  if (!report && !apply) return
  const expectedOperation = operation === 'verify' ? 'apply' : operation
  if (!report || report.target !== 'prod' || report.operation !== expectedOperation
    || report.manifestHash !== manifestHash || report.complete !== true
    || report.applied !== (operation === 'verify') || !report.planHash) {
    throw new Error('Rapport de production incompatible : mêmes opération, manifeste et cible requis, avec une simulation complète avant application.')
  }
}
