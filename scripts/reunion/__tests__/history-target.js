import test from 'ava'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {TESTING_DATABASE_ENDPOINT} from '../../network/testing-database-target.js'
import {parseArguments} from '../lib/core.js'
import {historyTargetAttestation, assertHistorySimulation, historyPlanHash, historyTargetCloser} from '../lib/history-target.js'

const configuration = (target = 'testing') => ({
  APP_ENV: target,
  DATABASE_URL: `postgresql://${target}-partageons-leau-api:synthetic@${TESTING_DATABASE_ENDPOINT.host}:${TESTING_DATABASE_ENDPOINT.port}/${target}-partageons-leau-api?sslmode=verify-full&sslrootcert=/usr/local/share/ca-certificates/scw-postgres-ca.crt`,
  S3_ENDPOINT: 'https://s3.fr-par.scw.cloud', S3_REGION: 'fr-par', S3_BUCKET_PREFIX: `${target}-`
})

test('historical target binds source, exact testing database and exact S3 bucket', t => {
  const options = {target: 'testing', configuration: configuration(), sourceHash: 'synthetic-source'}
  const attestation = historyTargetAttestation(options)
  t.is(attestation.s3.bucket, 'testing-documents')
  t.throws(() => historyTargetAttestation({...options, apply: true}), {message: /confirm-target/})
  t.deepEqual(historyTargetAttestation({...options, apply: true, confirmTarget: attestation.confirmation}), attestation)
  t.throws(() => historyTargetAttestation({...options, sourceHash: 'other', apply: true, confirmTarget: attestation.confirmation}))
  for (const change of [{APP_ENV: 'prod'}, {S3_BUCKET_PREFIX: 'prod-'}, {S3_ENDPOINT: 'https://example.test'}, {S3_REGION: 'nl-ams'}]) {
    t.throws(() => historyTargetAttestation({...options, configuration: {...options.configuration, ...change}}))
  }
  t.throws(() => historyTargetAttestation({...options, target: 'prod', configuration: configuration('prod')}), {message: /production est interdite/})
})

test('historical application rejects stale, incomplete or different simulations', t => {
  const actual = {target: 'testing', operation: 'history-import', sourceHash: 'source', planHash: historyPlanHash({id: 1}), attestation: {fingerprint: 'target'}}
  const expected = {...actual, apply: false, complete: true}
  t.notThrows(() => assertHistorySimulation(expected, actual))
  for (const change of [{apply: true}, {complete: false}, {target: 'local'}, {operation: 'history-formats'}, {sourceHash: 'other'}, {planHash: 'stale'}, {attestation: {fingerprint: 'other'}}]) {
    t.throws(() => assertHistorySimulation({...expected, ...change}, actual), {message: /Simulation complète/})
  }
  t.throws(() => assertHistorySimulation(undefined, actual))
})

test('local historical application retains isolated target compatibility', t => {
  const local = {APP_ENV: 'reunion-local', DATABASE_URL: 'postgresql://pe_reunion:synthetic@127.0.0.1:5433/pe_reunion',
    S3_ENDPOINT: 'http://127.0.0.1:9002', S3_REGION: 'fr-par', S3_BUCKET_PREFIX: 'reunion-migration-'}
  t.is(historyTargetAttestation({target: 'local', configuration: local, sourceHash: 'synthetic', apply: true}).target, 'local')
  t.throws(() => historyTargetAttestation({target: 'local', configuration: {...local, S3_BUCKET_PREFIX: 'testing-'}, sourceHash: 'synthetic'}))
})

test('reference migration accepts explicit tunnel transport without changing its target', t => {
  const options = parseArguments(['preflight', '--target', 'testing', '--tunnel-port', '55440'])
  t.is(options.target, 'testing')
  t.is(options.tunnelPort, '55440')
})

test('real historical services reuse the attested client without reading the runtime CA or creating another pool', async t => {
  const code = `
    import assert from 'node:assert/strict'
    import {bindHistoryTargetGlobals} from './scripts/reunion/lib/history-target.js'
    process.env.DATABASE_URL = 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic?sslmode=verify-full&sslrootcert=/nonexistent-runtime-ca/history-test.pem'
    const prisma = {marker: 'attested-client'}
    const pool = {marker: 'attested-pool'}
    const adapter = {marker: 'attested-adapter'}
    const restore = bindHistoryTargetGlobals({prisma, pool, adapter})
    try {
      const services = await import('./lib/services/external-declarations.js')
      const native = await import('./lib/declaration-importer/native.js')
      assert.equal(typeof services.materializeExternalDeclaration, 'function')
      assert.equal(typeof native.normalizeNativeValues, 'function')
      assert.equal((await import('./db/prisma.js')).prisma, prisma)
      assert.equal(globalThis.pgPool, pool)
      assert.equal(globalThis.prismaAdapter, adapter)
      assert.throws(() => bindHistoryTargetGlobals({prisma: {}, pool, adapter}))
    } finally { restore() }
    for (const key of ['prisma', 'pgPool', 'prismaAdapter']) assert.equal(Object.hasOwn(globalThis, key), false)
    console.log('attested-services-loaded')
  `
  const {stdout} = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], {
    cwd: new URL('../../../', import.meta.url), env: {...process.env, NODE_ENV: 'test', SENTRY_DSN: ''}, timeout: 20000
  })
  t.regex(stdout, /attested-services-loaded/)
})

test('target cleanup disconnects each owned resource only once, including failure cleanup', async t => {
  for (const fail of [false, true]) {
    const calls = []
    const close = historyTargetCloser({prisma: {$disconnect: async () => { calls.push('prisma'); if (fail) throw new Error('synthetic disconnect failure') }},
      pool: {end: async () => { calls.push('pool') }}, storage: {client: {destroy: () => { calls.push('s3') }}}})
    if (fail) await t.throwsAsync(close(), {message: /synthetic disconnect failure/})
    else await close()
    await close()
    t.deepEqual(calls, ['prisma', 'pool', 's3'])
  }
})
