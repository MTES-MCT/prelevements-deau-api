import {parseArgs, parseEnv} from 'node:util'
import {readFile, writeFile, mkdir, rename, access, link, unlink} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import path from 'node:path'
import process from 'node:process'
import {createHash, randomUUID} from 'node:crypto'
import {readWorkbook, EPIDROPT_SHEETS, RIVES_SHEETS, buildManifest, digest} from './lib/epidropt.js'
import {getTransactionTimeoutMs} from './lib/import-options.js'

const {positionals, values} = parseArgs({allowPositionals: true, options: {
  input: {type: 'string', default: 'data/dropt/epidropt-2026'}, target: {type: 'string'},
  manifest: {type: 'string'}, overrides: {type: 'string'}, dataset: {type: 'string'}, report: {type: 'string'}, 'against-report': {type: 'string'},
  'consolidation-plan': {type: 'string'},
  'backup-evidence': {type: 'string'}, resume: {type: 'string'},
  'rebuild-identities': {type: 'boolean', default: false},
  'login-scope': {type: 'string'},
  'allow-email-aliases': {type: 'boolean', default: false},
  'campaign-config': {type: 'string'}, 'actor-user-id': {type: 'string'},
  'prefill-file': {type: 'string'}, 'campaign-id': {type: 'string'},
  'epidropt-file': {type: 'string'}, snapshot: {type: 'string'}, 'previous-manifest': {type: 'string'},
  apply: {type: 'boolean', default: false}, 'activate-at': {type: 'string'}, 'effective-at': {type: 'string'}, 'service-account-id': {type: 'string'},
  'target-env': {type: 'string'}, 'tunnel-port': {type: 'string'}, 'transaction-timeout-seconds': {type: 'string'}
}})
const operation = positionals[0]
const prefillOperation = ['prepare-prefill', 'prefill-campaign', 'verify-prefill-campaign'].includes(operation)
if (!['prepare', 'apply', 'review', 'verify', 'rebuild', 'recompute-rebuild', 'enable-logins', 'seed-campaign', 'prepare-prefill', 'prefill-campaign', 'verify-prefill-campaign'].includes(operation)) throw new Error('Usage : npm run import:dropt -- prepare|apply|review|verify|rebuild|recompute-rebuild|enable-logins|seed-campaign|prepare-prefill|prefill-campaign|verify-prefill-campaign [--input dossier] [--target local|testing] [--apply]')
if (prefillOperation && (!values['prefill-file'] || !values.report)) throw new Error('--prefill-file et --report hors Git sont obligatoires pour le préremplissage.')
if (prefillOperation && operation !== 'prepare-prefill' && (!values['campaign-id'] || !values['actor-user-id'])) throw new Error('--campaign-id et --actor-user-id sont obligatoires.')
if (operation === 'prepare-prefill' && values.apply) throw new Error('La préparation du préremplissage ne modifie aucune base.')
if (operation === 'verify-prefill-campaign' && (values.apply || !values['against-report'])) throw new Error('La vérification exige le rapport appliqué et ne prend pas --apply.')
if ((values['prefill-file'] || values['campaign-id']) && !prefillOperation) throw new Error('Options réservées au préremplissage de campagne.')
if (operation === 'enable-logins' && !['non-realimente', 'all'].includes(values['login-scope'])) throw new Error('--login-scope non-realimente|all obligatoire.')
if (values['login-scope'] && operation !== 'enable-logins') throw new Error('--login-scope est réservé à enable-logins.')
if (values['allow-email-aliases'] && operation !== 'enable-logins') throw new Error('--allow-email-aliases est réservé à enable-logins.')
if (operation === 'seed-campaign' && !values['campaign-config']) throw new Error('--campaign-config data/.../configuration.json obligatoire pour seed-campaign.')
if (values['campaign-config'] && operation !== 'seed-campaign') throw new Error('--campaign-config est réservé à seed-campaign.')
if (values['actor-user-id'] && operation !== 'seed-campaign' && !prefillOperation) throw new Error('--actor-user-id est réservé aux opérations de campagne.')
const base = path.resolve(values.input)
let dataset
try { if (!prefillOperation) dataset = JSON.parse(await readFile(values.dataset ?? path.join(base, 'mapping/dataset.json'), 'utf8')) } catch (error) {
  if (error.code !== 'ENOENT' || values.dataset) throw error
}
if (dataset && dataset.version !== 1) throw new Error('Version de jeu de données non prise en charge.')
if (dataset && (!dataset.files?.epidropt || !dataset.files?.rives)) throw new Error('Les deux classeurs sources doivent être déclarés dans le jeu de données.')
const datasetPath = filename => {
  const resolved = path.resolve(base, filename)
  if (!resolved.startsWith(`${base}${path.sep}`)) throw new Error('Les sources du jeu de données doivent rester dans son dossier privé.')
  return resolved
}
const manifestPath = path.resolve(values.manifest ?? datasetPath(dataset?.manifest ?? 'mapping/manifest.json'))

async function writePrivate(filename, value) {
  await mkdir(path.dirname(filename), {recursive: true, mode: 0o700})
  const temporary = `${filename}.${randomUUID()}.partial`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600, flag: 'wx'})
  if (prefillOperation) {
    // Publish exclusively: a report must never replace the source workbook or
    // a previously reviewed report, including symlinks and concurrent writers.
    try { await link(temporary, filename) } finally { await unlink(temporary) }
  } else await rename(temporary, filename)
}

try {
  getTransactionTimeoutMs(values['transaction-timeout-seconds'])
  if (prefillOperation) {
    if (path.extname(values.report).toLowerCase() !== '.json') throw new Error('Le rapport privé doit être un nouveau fichier .json.')
    try {
      await access(path.resolve(values.report))
      throw new Error('Le rapport existe déjà ; choisir un nouveau fichier sans écraser la source ou un rapport précédent.')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    const directory = path.dirname(path.resolve(values.report))
    await mkdir(directory, {recursive: true, mode: 0o700})
    let insideGit = false
    try {
      const {stdout} = await promisify(execFile)('git', ['-C', directory, 'rev-parse', '--is-inside-work-tree'])
      insideGit = stdout.trim() === 'true'
    } catch (error) { if (error.code !== 128) throw new Error('Impossible de vérifier le dossier privé du rapport.', {cause: error}) }
    if (insideGit) throw new Error('Le rapport de préremplissage doit être stocké hors de tout dépôt Git.')
  }
  if (operation === 'prepare-prefill') {
    const {loadCampaignPrefillSource} = await import('./lib/campaign-prefill-source.js')
    const source = await loadCampaignPrefillSource(values['prefill-file'])
    await writePrivate(path.resolve(values.report), source)
    console.log(JSON.stringify({operation, sourceSha256: source.source.sha256, summary: source.summary}))
  } else if (operation === 'prepare') {
    const files = Object.fromEntries(Object.entries(dataset?.files ?? {
      epidropt: 'raw/Prelevement_Epidropt_20_08_2026.xlsx', rives: 'raw/ExportTableEpiDropt.xlsx'
    }).map(([key, filename]) => [key, datasetPath(filename)]))
    if (values['epidropt-file']) files.epidropt = path.resolve(values['epidropt-file'])
    const inputs = {}
    for (const [key, filename] of Object.entries(files)) inputs[key] = {name: path.basename(filename), sha256: createHash('sha256').update(await readFile(filename)).digest('hex')}
    const overridesPath = values.overrides ?? (dataset?.overrides ? datasetPath(dataset.overrides) : undefined)
    const overrides = overridesPath ? JSON.parse(await readFile(overridesPath, 'utf8')) : {}
    const previousPath = path.resolve(values['previous-manifest'] ?? (dataset?.previousManifest ? datasetPath(dataset.previousManifest) : manifestPath))
    let previousManifest
    try { previousManifest = JSON.parse(await readFile(previousPath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT' || values['previous-manifest'] || dataset?.previousManifest) throw error }
    const snapshotPath = values.snapshot ?? (dataset?.snapshot ? datasetPath(dataset.snapshot) : undefined)
    const snapshot = snapshotPath ? JSON.parse(await readFile(snapshotPath, 'utf8')) : undefined
    if (snapshot && (!snapshot.readOnly || !snapshot.completed || !snapshot.tables || snapshot.target !== 'testing')) throw new Error('Export testing complet et en lecture seule requis.')
    if (previousManifest) inputs.previousManifestHash = previousManifest.manifestHash
    if (snapshot) inputs.snapshot = {startedAt: snapshot.startedAt, sha256: createHash('sha256').update(await readFile(snapshotPath)).digest('hex')}
    const manifest = buildManifest({epidropt: await readWorkbook(files.epidropt, EPIDROPT_SHEETS), rives: await readWorkbook(files.rives, RIVES_SHEETS),
      overrides, inputs, previousManifest, snapshot, resetExistingPointAndExploitationIdentities: values['rebuild-identities']})
    // Keep every reviewed mapping even when refreshing the convenient latest file.
    await writePrivate(path.join(base, `mapping/manifests/${manifest.manifestHash}.json`), manifest)
    await writePrivate(manifestPath, manifest)
    console.log(JSON.stringify({source: inputs.epidropt, manifestHash: manifest.manifestHash, counts: Object.fromEntries(['points', 'declarants', 'exploitations', 'meters', 'allocations', 'issues'].map(key => [key, manifest[key].length]))}))
  } else {
    if (!['local', 'testing'].includes(values.target)) throw new Error('Cible explicite local ou testing obligatoire ; production interdite.')
    if (['review', 'rebuild', 'recompute-rebuild'].includes(operation) && values.target !== 'testing') throw new Error('La correction en ligne est réservée à testing.')
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
      let manifest
      if (!prefillOperation) {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        const {manifestHash, ...payload} = manifest
        if (digest(payload) !== manifestHash) throw new Error('Manifeste modifié ; relancer prepare.')
      }
      const {applyManifest, verifyManifest} = await import('./lib/apply-epidropt.js')
      const report = values['against-report'] ? JSON.parse(await readFile(values['against-report'], 'utf8')) : undefined
      const stamp = new Date().toISOString().replaceAll(':', '-')
      const reportPath = path.resolve(values.report ?? path.join(base, `reports/${stamp}-${values.target}-${operation}${values.apply ? '-applied' : ''}.json`))
      const options = {
        apply: values.apply, activateAt: values['activate-at'], effectiveAt: values['effective-at'], serviceAccountId: values['service-account-id'],
        transactionTimeoutSeconds: values['transaction-timeout-seconds'], expectedReport: report
      }
      let result
      if (prefillOperation) {
        const {loadCampaignPrefillSource} = await import('./lib/campaign-prefill-source.js')
        const {prefillCampaign, verifyCampaignPrefill} = await import('./lib/campaign-prefill.js')
        const source = await loadCampaignPrefillSource(values['prefill-file'])
        const prefillOptions = {...options, target: values.target, campaignId: values['campaign-id'], actorUserId: values['actor-user-id']}
        result = operation === 'verify-prefill-campaign'
          ? await verifyCampaignPrefill(prisma, source, prefillOptions)
          : await prefillCampaign(prisma, source, prefillOptions)
      } else if (operation === 'verify') result = await verifyManifest(prisma, manifest, {report})
      else if (operation === 'review') {
        if (options.activateAt || options.effectiveAt) throw new Error('La revue de référentiel ne doit ni activer ni recalculer les volumes.')
        const {applyReviewedManifest} = await import('./lib/apply-reviewed.js')
        const consolidationPlan = values['consolidation-plan'] ? JSON.parse(await readFile(values['consolidation-plan'], 'utf8')) : manifest.reviewedConsolidationPlan
        const backupEvidence = values['backup-evidence'] ? JSON.parse(await readFile(values['backup-evidence'], 'utf8')) : undefined
        result = await applyReviewedManifest(prisma, manifest, {...options, target: values.target, consolidationPlan, backupEvidence})
      }
      else if (operation === 'enable-logins') {
        const {enableManifestLogins} = await import('./lib/enable-logins.js')
        result = await enableManifestLogins(prisma, manifest, {...options, scope: values['login-scope'], allowEmailAliases: values['allow-email-aliases']})
      } else if (operation === 'seed-campaign') {
        const {readCampaignSeedConfig, seedManifestCampaign} = await import('./lib/seed-campaign.js')
        const config = await readCampaignSeedConfig(values['campaign-config'], {actorUserId: values['actor-user-id']})
        result = await seedManifestCampaign(prisma, manifest, config, {...options, target: values.target})
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
  console.error(error.name === 'PrismaClientKnownRequestError' ? `Import interrompu (${error.code}).` : error.name === 'PrismaClientInitializationError' ? 'Connexion à la base impossible.' : error.name?.startsWith('PrismaClient') ? 'Import interrompu ; vérifier le schéma et les migrations de la cible.' : error.message.replace(/postgres(?:ql)?:\/\/\S+/g, '[connexion masquée]'))
  process.exitCode = 1
}
