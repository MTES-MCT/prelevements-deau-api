import {parseArgs, parseEnv} from 'node:util'
import {readFile, writeFile, mkdir, rename} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {createHash, randomUUID} from 'node:crypto'
import {readWorkbook, EPIDROPT_SHEETS, RIVES_SHEETS, buildManifest, digest} from './lib/epidropt.js'
import {getTransactionTimeoutMs} from './lib/import-options.js'

const {positionals, values} = parseArgs({allowPositionals: true, options: {
  input: {type: 'string', default: 'data/dropt/epidropt-2026'}, target: {type: 'string'},
  manifest: {type: 'string'}, overrides: {type: 'string'}, report: {type: 'string'}, 'against-report': {type: 'string'},
  'backup-evidence': {type: 'string'}, resume: {type: 'string'},
  'rebuild-identities': {type: 'boolean', default: false},
  'login-scope': {type: 'string'},
  'allow-email-aliases': {type: 'boolean', default: false},
  'epidropt-file': {type: 'string'}, snapshot: {type: 'string'}, 'previous-manifest': {type: 'string'},
  apply: {type: 'boolean', default: false}, 'activate-at': {type: 'string'}, 'effective-at': {type: 'string'}, 'service-account-id': {type: 'string'},
  'target-env': {type: 'string'}, 'tunnel-port': {type: 'string'}, 'transaction-timeout-seconds': {type: 'string'}
}})
const operation = positionals[0]
if (!['prepare', 'apply', 'verify', 'rebuild', 'recompute-rebuild', 'enable-logins'].includes(operation)) throw new Error('Usage : npm run import:dropt -- prepare|apply|verify|rebuild|recompute-rebuild|enable-logins [--input dossier] [--target local|testing] [--apply]')
if (operation === 'enable-logins' && !['non-realimente', 'all'].includes(values['login-scope'])) throw new Error('--login-scope non-realimente|all obligatoire.')
if (values['login-scope'] && operation !== 'enable-logins') throw new Error('--login-scope est réservé à enable-logins.')
if (values['allow-email-aliases'] && operation !== 'enable-logins') throw new Error('--allow-email-aliases est réservé à enable-logins.')
const base = path.resolve(values.input)
const manifestPath = path.resolve(values.manifest ?? path.join(base, 'mapping/manifest.json'))

async function writePrivate(filename, value) {
  await mkdir(path.dirname(filename), {recursive: true, mode: 0o700})
  const temporary = `${filename}.${randomUUID()}.partial`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600, flag: 'wx'})
  await rename(temporary, filename)
}

try {
  getTransactionTimeoutMs(values['transaction-timeout-seconds'])
  if (operation === 'prepare') {
    const files = {epidropt: path.resolve(values['epidropt-file'] ?? path.join(base, 'raw/Prelevement_Epidropt_20_08_2026.xlsx')), rives: path.join(base, 'raw/ExportTableEpiDropt.xlsx')}
    const inputs = {}
    for (const [key, filename] of Object.entries(files)) inputs[key] = {name: path.basename(filename), sha256: createHash('sha256').update(await readFile(filename)).digest('hex')}
    const overrides = values.overrides ? JSON.parse(await readFile(values.overrides, 'utf8')) : {}
    const previousPath = path.resolve(values['previous-manifest'] ?? manifestPath)
    let previousManifest
    try { previousManifest = JSON.parse(await readFile(previousPath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT' || values['previous-manifest']) throw error }
    const snapshot = values.snapshot ? JSON.parse(await readFile(values.snapshot, 'utf8')) : undefined
    if (snapshot && (!snapshot.readOnly || !snapshot.completed || !snapshot.tables || snapshot.target !== 'testing')) throw new Error('Export testing complet et en lecture seule requis.')
    if (previousManifest) inputs.previousManifestHash = previousManifest.manifestHash
    if (snapshot) inputs.snapshot = {startedAt: snapshot.startedAt, sha256: createHash('sha256').update(await readFile(values.snapshot)).digest('hex')}
    const manifest = buildManifest({epidropt: await readWorkbook(files.epidropt, EPIDROPT_SHEETS), rives: await readWorkbook(files.rives, RIVES_SHEETS),
      overrides, inputs, previousManifest, snapshot, resetExistingPointAndExploitationIdentities: values['rebuild-identities']})
    // Keep every reviewed mapping even when refreshing the convenient latest file.
    await writePrivate(path.join(base, `mapping/manifests/${manifest.manifestHash}.json`), manifest)
    await writePrivate(manifestPath, manifest)
    console.log(JSON.stringify({manifestHash: manifest.manifestHash, counts: Object.fromEntries(['points', 'declarants', 'exploitations', 'meters', 'allocations', 'issues'].map(key => [key, manifest[key].length]))}))
  } else {
    if (!['local', 'testing'].includes(values.target)) throw new Error('Cible explicite local ou testing obligatoire ; production interdite.')
    if (['rebuild', 'recompute-rebuild'].includes(operation) && values.target !== 'testing') throw new Error('La reconstruction en ligne est réservée à testing.')
    if (values['target-env']) {
      const configuration = parseEnv(await readFile(values['target-env'], 'utf8'))
      if (!configuration.DATABASE_URL) throw new Error('DATABASE_URL absente du fichier cible.')
      process.env.DATABASE_URL = configuration.DATABASE_URL
      // Do not inherit a permissive local flag when explicitly targeting testing.
      process.env.MULTIPLE_EXPLOITATIONS_ENABLED = configuration.MULTIPLE_EXPLOITATIONS_ENABLED === 'true' ? 'true' : 'false'
    }
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL doit être chargée explicitement, sans argument de commande.')
    const url = new URL(process.env.DATABASE_URL)
    if (values['tunnel-port']) {
      const port = Number(values['tunnel-port'])
      if (values.target !== 'testing' || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Tunnel réservé à testing sur un port local explicite.')
      const {TESTING_DATABASE_ENDPOINT} = await import('../network/testing-database-target.js')
      url.hostname = TESTING_DATABASE_ENDPOINT.host
      url.port = TESTING_DATABASE_ENDPOINT.port
      url.searchParams.set('sslmode', 'verify-full')
      url.searchParams.set('sslrootcert', path.resolve('deploy/certs/testing/postgres-ca.pem'))
      const {getPostgresConnectionOptions} = await import('../../db/connection-options.js')
      const {InstrumentedPool} = await import('../../db/instrumented-pool.js')
      const {ssl} = getPostgresConnectionOptions(url.toString())
      globalThis.pgPool = new InstrumentedPool({host: '127.0.0.1', port, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.slice(1)), ssl, max: 2, connectionTimeoutMillis: 10_000})
      process.env.DATABASE_URL = url.toString()
    }
    if (values.target === 'local' && (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['prelevements-deau', 'security_tests', 'integration_tests'].includes(decodeURIComponent(url.pathname.slice(1))))) throw new Error('La cible locale ne correspond pas à une base autorisée.')
    if (values.target === 'testing') {
      const {TESTING_DATABASE_ENDPOINT} = await import('../network/testing-database-target.js')
      if (decodeURIComponent(url.pathname.slice(1)) !== 'testing-partageons-leau-api' || decodeURIComponent(url.username) !== 'testing-partageons-leau-api' || url.hostname !== TESTING_DATABASE_ENDPOINT.host || url.port !== TESTING_DATABASE_ENDPOINT.port || url.searchParams.get('sslmode') !== 'verify-full') throw new Error('La cible ne correspond pas au PostgreSQL privé testing avec TLS vérifié.')
    }
    process.env.APP_ENV = values.target === 'testing' ? 'testing' : 'development'
    const {prisma} = await import('../../db/prisma.js')
    try {
      const [identity] = await prisma.$queryRaw`SELECT current_database() AS name, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls`
      if (identity.name !== decodeURIComponent(url.pathname.slice(1)) || (values.target === 'testing' && !identity.tls)) throw new Error('Identité ou TLS de la base incorrect.')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      const {manifestHash, ...payload} = manifest
      if (digest(payload) !== manifestHash) throw new Error('Manifeste modifié ; relancer prepare.')
      const {applyManifest, verifyManifest} = await import('./lib/apply-epidropt.js')
      const report = values['against-report'] ? JSON.parse(await readFile(values['against-report'], 'utf8')) : undefined
      const stamp = new Date().toISOString().replaceAll(':', '-')
      const reportPath = path.resolve(values.report ?? path.join(base, `reports/${stamp}-${values.target}-${operation}${values.apply ? '-applied' : ''}.json`))
      const options = {
        apply: values.apply, activateAt: values['activate-at'], effectiveAt: values['effective-at'], serviceAccountId: values['service-account-id'],
        transactionTimeoutSeconds: values['transaction-timeout-seconds'], expectedReport: report
      }
      let result
      if (operation === 'verify') result = await verifyManifest(prisma, manifest, {report})
      else if (operation === 'enable-logins') {
        const {enableManifestLogins} = await import('./lib/enable-logins.js')
        result = await enableManifestLogins(prisma, manifest, {...options, scope: values['login-scope'], allowEmailAliases: values['allow-email-aliases']})
      }
      else if (operation === 'rebuild') {
        const {rebuildManifest} = await import('./lib/rebuild-epidropt.js')
        const backupEvidence = values['backup-evidence'] ? JSON.parse(await readFile(values['backup-evidence'], 'utf8')) : undefined
        result = await rebuildManifest(prisma, manifest, {...options, target: values.target, backupEvidence})
      } else if (operation === 'recompute-rebuild') {
        const {recomputeRebuiltManifest} = await import('./lib/rebuild-epidropt.js')
        const resume = values.resume ? JSON.parse(await readFile(values.resume, 'utf8')) : undefined
        result = await recomputeRebuiltManifest(prisma, manifest, {...options, target: values.target, report, resume,
          onProgress: progress => writePrivate(reportPath, progress)})
      } else result = await applyManifest(prisma, manifest, options)
      await writePrivate(reportPath, result)
      console.log(JSON.stringify({manifestHash: result.manifestHash, applied: result.applied ?? false, counts: result.counts, issues: result.issues?.length, complete: result.complete}))
      if (result.complete === false) process.exitCode = 1
    } finally {
      await prisma.$disconnect()
      await globalThis.pgPool?.end()
    }
  }
} catch (error) {
  // No ORM, provider or connection error may disclose credentials or source rows.
  console.error(error.name === 'PrismaClientKnownRequestError' ? `Import interrompu (${error.code}).` : error.name === 'PrismaClientInitializationError' ? 'Connexion à la base impossible.' : error.message.replace(/postgres(?:ql)?:\/\/\S+/g, '[connexion masquée]'))
  process.exitCode = 1
}
