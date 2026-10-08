import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs, parseEnv} from 'node:util'
import {createReadStream} from 'node:fs'
import {mkdir, open, readFile, rename, unlink, realpath, lstat} from 'node:fs/promises'
import {createHash, randomUUID} from 'node:crypto'
import {getPostgresConnectionOptions} from '../../../db/connection-options.js'
import {validateProdAdminDatabaseUrl, assertConnectedProdAdminDatabase} from '../../network/prod-database-target.js'
import {validateTestingAdminDatabaseUrl, assertConnectedTestingAdminDatabase} from '../../network/testing-database-target.js'

const repository = fileURLToPath(new URL('../../../', import.meta.url))

export class CliError extends Error {}

export function parseOptions(args) {
  let parsed
  try {
    parsed = parseArgs({args, allowPositionals: true, options: Object.fromEntries([
      'target', 'target-env', 'tunnel-port', 'report', 'against-report', 'against-receipt', 'receipt', 'backup-proof'
    ].map(key => [key, {type: 'string'}]))})
  } catch {
    throw new CliError('Arguments invalides. Consultez scripts/sage-overlap/README.md.')
  }
  const command = parsed.positionals[0] ?? 'review'
  const values = parsed.values
  if (parsed.positionals.length > 1 || !['review', 'apply', 'rollback'].includes(command)) {
    throw new CliError('Commande attendue : review, apply ou rollback.')
  }
  if (!['testing', 'prod'].includes(values.target) || !values['target-env']) {
    throw new CliError('--target testing|prod et --target-env sont obligatoires.')
  }
  const port = Number(values['tunnel-port'])
  if (!/^\d+$/.test(values['tunnel-port'] ?? '') || !Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new CliError('--tunnel-port doit désigner un tunnel local explicite (1024–65535).')
  }
  const allowed = {review: ['report'], apply: ['against-report', 'receipt', 'backup-proof'],
    rollback: ['against-receipt', 'receipt']}[command]
  for (const name of allowed) {
    if (!values[name]) throw new CliError(`--${name} est obligatoire pour ${command}.`)
  }
  for (const name of ['report', 'against-report', 'against-receipt', 'receipt', 'backup-proof']) {
    if (values[name] && !allowed.includes(name)) throw new CliError(`--${name} est incompatible avec ${command}.`)
  }
  const output = path.resolve(values[command === 'review' ? 'report' : 'receipt'])
  if ([values['target-env'], values['against-report'], values['against-receipt'], values['backup-proof']]
    .filter(Boolean).some(input => path.resolve(input) === output)) {
    throw new CliError('Le fichier de sortie doit être distinct des entrées.')
  }
  return {command, values, port, output}
}

export async function assertPrivateOutput(filename) {
  await mkdir(path.dirname(filename), {recursive: true, mode: 0o700})
  let directory = await realpath(path.dirname(filename))
  for (;;) {
    try {
      await lstat(path.join(directory, '.git'))
      throw new CliError('Conservez les rapports dans un dossier privé hors de tout dépôt Git.')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
}

export async function writePrivateJson(filename, value, {replace = false} = {}) {
  await assertPrivateOutput(filename)
  const destination = replace ? `${filename}.${randomUUID()}.tmp` : filename
  const file = await open(destination, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + '\n')
    await file.sync()
  } finally {
    await file.close()
  }
  if (replace) {
    try {
      await rename(destination, filename)
    } catch (error) {
      await unlink(destination)
      throw error
    }
  }
  const directory = await open(path.dirname(filename), 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

export async function verifyBackupProof(filename, target, review) {
  const proof = JSON.parse(await readFile(filename, 'utf8'))
  if (proof.target !== target || proof.restoreMatched !== true || !Number.isFinite(Date.parse(proof.restoredAt))
    || !path.isAbsolute(proof.backupFile ?? '') || !/^[a-f0-9]{64}$/.test(proof.backupSha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(proof.stateHash ?? '') || proof.stateHash !== review?.stateHash) {
    throw new CliError('Preuve de sauvegarde restaurée invalide pour cette cible.')
  }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(proof.backupFile)) hash.update(chunk)
  if (hash.digest('hex') !== proof.backupSha256) throw new CliError('L’empreinte de la sauvegarde ne correspond pas à la preuve.')
}

export async function connectionOptions({values, port}) {
  const environment = parseEnv(await readFile(values['target-env'], 'utf8'))
  const validate = values.target === 'prod' ? validateProdAdminDatabaseUrl : validateTestingAdminDatabaseUrl
  const url = validate(environment.DATABASE_URL)
  // Keep certificate verification bound to the canonical server identity even
  // though the TCP connection goes through a loopback-only SSH tunnel.
  url.searchParams.set('sslrootcert', path.join(repository, 'deploy/certs', values.target, 'postgres-ca.pem'))
  const {ssl} = getPostgresConnectionOptions(url.toString())
  return {
    host: '127.0.0.1', port, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)), ssl, connectionTimeoutMillis: 10000,
    application_name: 'sage-overlap-repair', options: '-c statement_timeout=60000 -c lock_timeout=5000'
  }
}

export async function assertTarget(client, target) {
  return target === 'prod' ? assertConnectedProdAdminDatabase(client) : assertConnectedTestingAdminDatabase(client)
}
