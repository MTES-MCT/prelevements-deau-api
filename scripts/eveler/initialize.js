import process from 'node:process'
import {createHash} from 'node:crypto'
import {parseArgs} from 'node:util'
import {pathToFileURL} from 'node:url'
import pg from 'pg'
import {getPostgresConnectionOptions} from '../../db/connection-options.js'
import {validateTestingAdminDatabaseUrl, assertConnectedTestingAdminDatabase, TESTING_DATABASE_ENDPOINT} from '../network/testing-database-target.js'
import {validateProdAdminDatabaseUrl, assertConnectedProdAdminDatabase, PROD_DATABASE_ENDPOINT} from '../network/prod-database-target.js'
import {normalizeManifest, digest} from './manifest.js'
import {buildPlan} from './plan.js'
import {readInventory, applyPlan} from './database.js'
import {readPrivateFile, reservePrivateReport} from './private-files.js'

const targets = {
  testing: {validate: validateTestingAdminDatabaseUrl, identity: assertConnectedTestingAdminDatabase, endpoint: TESTING_DATABASE_ENDPOINT},
  prod: {validate: validateProdAdminDatabaseUrl, identity: assertConnectedProdAdminDatabase, endpoint: PROD_DATABASE_ENDPOINT}
}

const sha256 = text => createHash('sha256').update(text).digest('hex')

export function parseOptions(args) {
  const {values} = parseArgs({args, options: {
    target: {type: 'string'}, manifest: {type: 'string'}, report: {type: 'string'},
    apply: {type: 'boolean'}, verify: {type: 'boolean'}, preflight: {type: 'string'},
    'expect-sha256': {type: 'string'}, help: {type: 'boolean'}
  }, strict: true, allowPositionals: false})
  if (values.help) return values
  if (!Object.hasOwn(targets, values.target) || !values.manifest || !values.report) throw new Error('OPTIONS_REQUIRED')
  if (values.apply && values.verify) throw new Error('OPTIONS_CONFLICT')
  if (values.apply && (!values.preflight || !/^[a-f0-9]{64}$/.test(values['expect-sha256'] ?? ''))) throw new Error('APPROVED_PREFLIGHT_REQUIRED')
  if (!values.apply && (values.preflight || values['expect-sha256'])) throw new Error('PREFLIGHT_OPTIONS_WITHOUT_APPLY')
  return values
}

export async function checkTarget(client, target) {
  const identity = await targets[target].identity(client)
  const endpoint = targets[target].endpoint
  if (![endpoint.host, `${endpoint.host}/32`].includes(identity.serverAddress) || String(identity.serverPort) !== endpoint.port) {
    throw new Error('CONNECTED_DATABASE_ENDPOINT_MISMATCH')
  }
  return {...identity, serverAddress: endpoint.host}
}

export function assertReviewedPreflight({reviewed, target, manifestHash, inventoryHash, identity}) {
  if (reviewed.schemaVersion !== 1 || reviewed.operation !== 'preflight' || reviewed.status !== 'verified'
    || reviewed.target !== target || reviewed.manifestHash !== manifestHash
    || reviewed.inventoryHash !== inventoryHash || digest(reviewed.identity) !== digest(identity)) {
    throw new Error('PREFLIGHT_CHANGED_OR_WRONG_TARGET')
  }
}

function createClient(databaseUrl) {
  return new pg.Client(getPostgresConnectionOptions(databaseUrl, {
    connectionTimeoutMillis: 10_000, application_name: 'eveler-initialization'
  }))
}

export async function run(options, environment = process.env, {createDatabaseClient = createClient} = {}) {
  if (environment.APP_ENV !== options.target) throw new Error('APP_ENV_TARGET_MISMATCH')
  targets[options.target].validate(environment.DATABASE_URL)
  const manifest = normalizeManifest(JSON.parse(await readPrivateFile(options.manifest)))
  const manifestHash = digest(manifest)
  let reviewed
  if (options.apply) {
    const contents = await readPrivateFile(options.preflight)
    if (sha256(contents) !== options['expect-sha256']) throw new Error('PREFLIGHT_SHA256_MISMATCH')
    reviewed = JSON.parse(contents)
  }
  const client = createDatabaseClient(environment.DATABASE_URL)
  const output = await reservePrivateReport(options.report)
  let connected = false
  let committed = false
  let report = {schemaVersion: 1, operation: options.apply ? 'apply' : options.verify ? 'verify' : 'preflight', target: options.target, manifestHash, manifest, status: 'started'}
  try {
    await output.write(report)
    await client.connect()
    connected = true
    await client.query(options.apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '20s'")
    await client.query("SET LOCAL lock_timeout = '5s'")
    if (options.apply) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`eveler:${manifest.point.sourceId}`])
    const identity = await checkTarget(client, options.target)
    const before = await readInventory(client, manifest)
    const inventoryHash = digest(before)
    const plan = buildPlan(manifest, before)
    report = {...report, identity, inventoryHash, plan, inventory: before,
      accessScope: 'Existing service-account access rules are unchanged; declarant discovery and context access are global in the current API.'}
    if (options.verify && plan.actions.length) throw new Error('VERIFICATION_INCOMPLETE')
    if (options.apply) {
      assertReviewedPreflight({reviewed, target: options.target, manifestHash, inventoryHash, identity})
      await applyPlan(client, manifest, before)
      const after = await readInventory(client, manifest)
      const verified = buildPlan(manifest, after)
      if (verified.actions.length) throw new Error('POST_APPLY_VERIFICATION_FAILED')
      report = {...report, after, verified}
    }
    await output.write({...report, status: 'transaction-verified-not-committed'})
    await client.query('COMMIT')
    committed = true
    const contents = await output.write({...report, status: 'verified'})
    return {status: 'verified', operation: report.operation, actions: plan.actions, reportSha256: sha256(contents)}
  } catch (error) {
    if (connected && !committed) await client.query('ROLLBACK').catch(() => {})
    await output.write({...report, status: committed ? 'committed-report-finalization-failed' : 'failed', errorCode: safeError(error)}).catch(() => {})
    throw error
  } finally {
    await client.end().catch(() => {})
    await output.close()
  }
}

// Database drivers can include personal data, SQL arguments or endpoints in errors.
export function safeError(error) {
  return /^[A-Z][A-Z0-9_]+(?:: [A-Za-z,]+)?$/.test(error.message ?? '') ? error.message : 'INITIALIZATION_FAILED_REVIEW_PRIVATE_REPORT'
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const options = parseOptions(process.argv.slice(2))
    if (options.help) {
      console.log('Usage: node scripts/eveler/initialize.js --target testing|prod --manifest /private/manifest.json --report /private/new-report.json [--verify | --apply --preflight /private/preflight.json --expect-sha256 SHA256]')
    } else {
      console.log(JSON.stringify(await run(options)))
    }
  } catch (error) {
    console.error(safeError(error))
    process.exitCode = 1
  }
}
