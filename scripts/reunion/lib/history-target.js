import path from 'node:path'
import {readFile} from 'node:fs/promises'
import pg from 'pg'
import prismaPkg from '@prisma/client'
import {PrismaPg} from '@prisma/adapter-pg'
import {assertConnectedTestingAdminDatabase} from '../../network/testing-database-target.js'
import {assertSafeTarget, sha256, stableStringify} from './core.js'
import {accessConnectionOptions, validateAccessBackup} from './access-cli.js'
import {assertTargetCertificate, attestTargetDatabase, createS3Context, assertVersionedS3Bucket} from './runtime.js'

export function historyTargetAttestation({target = 'local', configuration, sourceHash, targetEnv, apply = false, confirmTarget}) {
  return assertSafeTarget({target, targetEnvironment: configuration, manifestSha256: sourceHash, targetEnv, apply, confirmTarget: target === 'local' ? (confirmTarget ?? 'local') : confirmTarget})
}

export function historyPlanHash(plan) {
  return sha256(stableStringify(plan))
}

export function assertHistorySimulation(expected, actual) {
  if (!expected || expected.apply !== false || expected.complete !== true
    || expected.target !== actual.target || expected.operation !== actual.operation
    || expected.sourceHash !== actual.sourceHash || expected.planHash !== actual.planHash
    || expected.attestation?.fingerprint !== actual.attestation?.fingerprint) {
    throw new Error('Simulation complète de la même source, cible et état obligatoire avant application.')
  }
}

export async function historyTarget({target = 'local', configuration, sourceHash, targetEnv, apply = false,
  confirmTarget, tunnelPort, againstReport, backupEvidence, withStorage = true}) {
  const attestation = historyTargetAttestation({target, configuration, sourceHash, targetEnv, apply, confirmTarget})
  const connection = accessConnectionOptions(configuration, {target, tunnelPort})
  if (target === 'testing') await assertTargetCertificate(target, path.resolve(import.meta.dirname, '../../../deploy/certs/testing/postgres-ca.pem'))
  const expected = againstReport ? JSON.parse(await readFile(againstReport, 'utf8')) : undefined
  const backup = apply && target === 'testing' ? await validateAccessBackup(backupEvidence, target) : undefined
  if (apply && target === 'testing' && !expected) throw new Error('--against-report est obligatoire avant application sur testing.')
  const pool = new pg.Pool(connection)
  const prisma = new prismaPkg.PrismaClient({adapter: new PrismaPg(pool)})
  const storage = withStorage ? createS3Context(configuration, 'Stockage historique cible') : undefined
  if (storage) storage.bucket = `${configuration.S3_BUCKET_PREFIX}declarations`
  try {
    await attestTargetDatabase(prisma, target)
    if (target === 'testing') await assertConnectedTestingAdminDatabase(prisma)
    if (storage && target === 'testing') await assertVersionedS3Bucket(storage, 'Déclarations historiques testing', 'fr-par')
    return {prisma, storage, attestation, expected, backup,
      async close() { await prisma.$disconnect(); await pool.end(); storage?.client.destroy() }}
  } catch (error) {
    await prisma.$disconnect(); await pool.end(); storage?.client.destroy()
    throw error
  }
}

export const HISTORY_TARGET_OPTIONS = {
  target: {type: 'string', default: 'local'}, 'tunnel-port': {type: 'string'},
  'confirm-target': {type: 'string'}, 'against-report': {type: 'string'}, 'backup-evidence': {type: 'string'}
}

export function historyTargetArguments(values) {
  return {target: values.target, tunnelPort: values['tunnel-port'], confirmTarget: values['confirm-target'],
    againstReport: values['against-report'], backupEvidence: values['backup-evidence']}
}
