import process from 'node:process'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {readFile, mkdir, open, unlink} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import pg from 'pg'
import prismaPkg from '@prisma/client'
import {PrismaPg} from '@prisma/adapter-pg'
import {getPostgresConnectionOptions} from '../../../db/connection-options.js'
import {readTargetEnvironment} from '../../dropt/lib/target-environment.js'
import {validateTestingAdminDatabaseUrl, assertConnectedTestingAdminDatabase} from '../../network/testing-database-target.js'
import {validateProdAdminDatabaseUrl, assertConnectedProdAdminDatabase} from '../../network/prod-database-target.js'
import {loadAccessSource} from './access-source.js'
import {syncAccess, verifyAccess} from './access-apply.js'

const run = promisify(execFile)
const ROOT = path.resolve(import.meta.dirname, '../../..')

export async function reservePrivateReport(filename) {
  const resolved = path.resolve(filename)
  if (path.extname(resolved) !== '.json') throw new Error('Le rapport doit être un nouveau fichier .json privé.')
  await mkdir(path.dirname(resolved), {recursive: true, mode: 0o700})
  let insideGit = false
  try {
    await run('git', ['-C', path.dirname(resolved), 'rev-parse', '--absolute-git-dir'], {env: {...process.env, LC_ALL: 'C'}})
    insideGit = true
  } catch (error) {
    if (error.code !== 128 || !/^fatal: not a git repository/u.test(error.stderr ?? '')) {
      throw new Error('Impossible de vérifier le stockage privé du rapport.', {cause: error})
    }
  }
  if (insideGit) throw new Error('Conserver le rapport hors de tout dépôt Git.')
  return open(resolved, 'wx', 0o600)
}

export async function validateAccessBackup(filename, target) {
  if (!filename) throw new Error('--backup-evidence est obligatoire avant application.')
  const evidence = JSON.parse(await readFile(filename, 'utf8'))
  if (evidence.target !== target || evidence.restore?.success !== true
    || evidence.restore?.matchesPreflight !== true || !/^[a-f\d]{64}$/.test(evidence.backup?.sha256 ?? '')
    || !evidence.backupFile) throw new Error('Sauvegarde restaurée et vérifiée de la même cible obligatoire.')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(evidence.backupFile)) hash.update(chunk)
  if (hash.digest('hex') !== evidence.backup.sha256) throw new Error('Empreinte de la sauvegarde différente de la preuve.')
  return {sha256: evidence.backup.sha256, evidence: path.resolve(filename)}
}

export function accessConnectionOptions(configuration, {target, tunnelPort}) {
  if (!['testing', 'prod'].includes(target)) throw new Error('Les accès exigent une cible explicite testing ou prod.')
  if (!/^\d+$/.test(tunnelPort ?? '') || Number(tunnelPort) < 1024 || Number(tunnelPort) > 65535) {
    throw new Error('--tunnel-port local explicite obligatoire.')
  }
  const url = target === 'testing'
    ? validateTestingAdminDatabaseUrl(configuration.DATABASE_URL)
    : validateProdAdminDatabaseUrl(configuration.DATABASE_URL)
  url.searchParams.set('sslrootcert', path.join(ROOT, `deploy/certs/${target}/postgres-ca.pem`))
  const {ssl} = getPostgresConnectionOptions(url.toString())
  return {
    host: '127.0.0.1', port: Number(tunnelPort),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)), ssl,
    max: 2, connectionTimeoutMillis: 10_000
  }
}

function parseAccessArguments(arguments_) {
  const {positionals, values} = parseArgs({args: arguments_, allowPositionals: true, options: {
    'access-file': {type: 'string'}, 'effective-date': {type: 'string'},
    mappings: {type: 'string'}, report: {type: 'string'},
    target: {type: 'string'}, 'target-env': {type: 'string'}, 'tunnel-port': {type: 'string'},
    apply: {type: 'boolean', default: false}, 'against-report': {type: 'string'},
    'backup-evidence': {type: 'string'}
  }})
  const [command] = positionals
  if (positionals.length !== 1 || !['access-prepare', 'access-apply', 'access-verify'].includes(command)) {
    throw new Error('Commande access-prepare, access-apply ou access-verify requise.')
  }
  if (!values['access-file'] || !values['effective-date'] || !values.report) {
    throw new Error('--access-file, --effective-date et --report sont obligatoires.')
  }
  if (values.apply && command !== 'access-apply') throw new Error('--apply est réservé à access-apply.')
  if ((values.apply || command === 'access-verify') && !values['against-report']) {
    throw new Error('--against-report est obligatoire avant application ou vérification.')
  }
  return {command, values}
}

function summarizeResult(command, values, source, result) {
  console.log(JSON.stringify({command, target: values.target, sourceHash: source.sourceHash,
    summary: result.summary, counts: result.counts, complete: result.complete,
    applied: result.applied, verified: result.ok, blocked: result.blocked,
    changes: result.changes, preservedGlobalAdmins: result.preservedGlobalAdmins?.length,
    report: path.resolve(values.report)}))
  if (result.complete === false || result.ok === false || result.blocked === true) process.exitCode = 2
}

export async function runAccessCommand(arguments_) {
  process.umask(0o077)
  const {command, values} = parseAccessArguments(arguments_)
  const source = await loadAccessSource(values['access-file'], {effectiveDate: values['effective-date']})
  const reportFile = await reservePrivateReport(values.report)
  let written = false
  let prisma
  let pool
  try {
    let result
    if (command === 'access-prepare') result = source
    else {
      if (!values['target-env'] || !values.mappings) throw new Error('--target-env et --mappings sont obligatoires.')
      const mappings = JSON.parse(await readFile(values.mappings, 'utf8'))
      const expectedReport = values['against-report'] ? JSON.parse(await readFile(values['against-report'], 'utf8')) : undefined
      if (command === 'access-verify' && (expectedReport?.applied !== true || expectedReport?.target !== values.target
        || expectedReport?.sourceHash !== source.sourceHash)) throw new Error('Vérification liée à une application de la même source et cible obligatoire.')
      const backup = values.apply ? await validateAccessBackup(values['backup-evidence'], values.target) : undefined
      const configuration = await readTargetEnvironment(values['target-env'])
      pool = new pg.Pool(accessConnectionOptions(configuration, {target: values.target, tunnelPort: values['tunnel-port']}))
      prisma = new prismaPkg.PrismaClient({adapter: new PrismaPg(pool)})
      const assertTarget = values.target === 'testing' ? assertConnectedTestingAdminDatabase : assertConnectedProdAdminDatabase
      await assertTarget(prisma)
      const options = {target: values.target, mappings, apply: values.apply, expectedReport, assertTarget,
        onBeforeApply: async snapshot => {
          const file = await reservePrivateReport(values.report.replace(/\.json$/, '.before.json'))
          try { await file.writeFile(`${JSON.stringify({backup, ...snapshot}, null, 2)}\n`) } finally { await file.close() }
        }}
      result = command === 'access-verify'
        ? await verifyAccess(prisma, source, options)
        : await syncAccess(prisma, source, options)
      if (backup) result.backup = backup
    }
    await reportFile.writeFile(`${JSON.stringify(result, null, 2)}\n`)
    written = true
    summarizeResult(command, values, source, result)
    return result
  } finally {
    await prisma?.$disconnect()
    await pool?.end()
    await reportFile.close()
    if (!written) await unlink(values.report)
  }
}
