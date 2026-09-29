import test from 'ava'
import path from 'node:path'
import process from 'node:process'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {assertDroptTargetOptions, getDroptProdDatabaseUrl, assertDroptProdReport} from '../production-target.js'
import {PROD_DATABASE_ENDPOINT, assertConnectedProdAdminDatabase} from '../../../network/prod-database-target.js'

const options = {operation: 'apply', target: 'prod', targetEnv: '/synthetic/prod.env', tunnelPort: '55440'}
const nativeUrl = () => new URL(`postgresql://prod-partageons-leau-api:synthetic-only@${PROD_DATABASE_ENDPOINT.host}:${PROD_DATABASE_ENDPOINT.port}/prod-partageons-leau-api?sslmode=verify-full&sslrootcert=/usr/local/share/ca-certificates/scw-postgres-ca.crt`)
const manifestHash = 'a'.repeat(64)
const report = {target: 'prod', operation: 'apply', manifestHash, complete: true, applied: false, planHash: 'b'.repeat(64)}

test('production Dropt autorise seulement les opérations prévues et exige fichier, tunnel et simulation pour appliquer', t => {
  for (const operation of ['apply', 'verify', 'enable-logins', 'seed-campaign']) t.notThrows(() => assertDroptTargetOptions({...options, operation}))
  for (const operation of ['review', 'rebuild', 'recompute-rebuild', 'prepare', 'unknown']) t.throws(() => assertDroptTargetOptions({...options, operation}))
  for (const target of ['demo', 'production', '', undefined]) t.throws(() => assertDroptTargetOptions({...options, target}))
  for (const tunnelPort of [undefined, '', '0', '1023', '65536', '5e4', '55440x']) t.throws(() => assertDroptTargetOptions({...options, tunnelPort}))
  t.throws(() => assertDroptTargetOptions({...options, targetEnv: undefined}))
  t.throws(() => assertDroptTargetOptions({...options, apply: true}))
  t.notThrows(() => assertDroptTargetOptions({...options, apply: true, againstReport: '/synthetic/preview.json'}))
  t.throws(() => assertDroptTargetOptions({...options, operation: 'verify', apply: true, againstReport: '/synthetic/preview.json'}))
  t.notThrows(() => assertDroptTargetOptions({operation: 'apply', target: 'local'}))
  t.notThrows(() => assertDroptTargetOptions({operation: 'review', target: 'testing'}))
})

test('le tunnel production conserve identité et TLS natifs, sans accepter une cible réécrite depuis localhost', t => {
  const converted = getDroptProdDatabaseUrl(nativeUrl().toString())
  t.is(converted.hostname, PROD_DATABASE_ENDPOINT.host)
  t.is(converted.port, PROD_DATABASE_ENDPOINT.port)
  t.is(converted.searchParams.get('sslrootcert'), path.resolve('deploy/certs/prod/postgres-ca.pem'))
  t.is(converted.searchParams.get('sslmode'), 'verify-full')
  for (const mutate of [url => { url.hostname = '127.0.0.1' }, url => { url.pathname = '/testing-partageons-leau-api' },
    url => { url.username = 'postgres' }, url => { url.port = '55440' }, url => { url.password = '' },
    url => { url.hash = '#ignored' },
    url => { url.searchParams.set('sslmode', 'require') }, url => { url.searchParams.set('sslrootcert', '/tmp/unreviewed.crt') },
    url => { url.searchParams.append('sslmode', 'verify-full') }, url => { url.searchParams.set('host', 'other.example.test') }]) {
    const url = nativeUrl()
    mutate(url)
    t.throws(() => getDroptProdDatabaseUrl(url.toString()))
  }
  for (const url of ['', undefined, 'invalid', nativeUrl().toString().replace('postgresql:', 'https:')]) t.throws(() => getDroptProdDatabaseUrl(url))
})

test('le contrôle SQL refuse le bon nom avec mauvais utilisateur ou sans TLS', async t => {
  const identity = {databaseName: 'prod-partageons-leau-api', databaseUser: 'prod-partageons-leau-api', tls: true}
  await t.notThrowsAsync(assertConnectedProdAdminDatabase({$queryRawUnsafe: async () => [identity]}))
  for (const change of [{databaseName: 'security_tests'}, {databaseUser: 'postgres'}, {tls: false}]) {
    await t.throwsAsync(assertConnectedProdAdminDatabase({$queryRawUnsafe: async () => [{...identity, ...change}]}))
  }
})

test('un rapport testing, déjà appliqué, incomplet ou d’une autre opération ne peut autoriser un import prod', t => {
  const context = {operation: 'apply', manifestHash, apply: true}
  t.notThrows(() => assertDroptProdReport(report, context))
  for (const value of [undefined, {...report, target: 'testing'}, {...report, operation: 'enable-logins'},
    {...report, manifestHash: 'c'.repeat(64)}, {...report, applied: true}, {...report, complete: false}, {...report, planHash: undefined}]) {
    t.throws(() => assertDroptProdReport(value, context))
  }
  t.notThrows(() => assertDroptProdReport(undefined, {...context, apply: false}))
  t.notThrows(() => assertDroptProdReport({...report, applied: true}, {operation: 'verify', manifestHash}))
  t.throws(() => assertDroptProdReport(report, {operation: 'verify', manifestHash}))
})

test('la CLI refuse les opérations destructives et options prod incomplètes avant accès aux identifiants', t => {
  const cli = fileURLToPath(new URL('../../import-epidropt.js', import.meta.url))
  for (const args of [
    ['apply', '--target', 'prod'],
    ['apply', '--target', 'prod', '--target-env', '/nonexistent-prod.env'],
    ['apply', '--target', 'prod', '--target-env', '/nonexistent-prod.env', '--tunnel-port', '55440', '--apply'],
    ...['review', 'rebuild', 'recompute-rebuild', 'prepare'].map(operation => [operation, '--target', 'prod', '--target-env', '/nonexistent-prod.env', '--tunnel-port', '55440'])
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8'})
    t.is(result.status, 1)
    t.regex(result.stderr, /production|testing/)
    t.notRegex(result.stderr, /ENOENT|Connexion/)
    t.is(result.stdout, '')
  }
})
