import test from 'ava'
import {spawnSync} from 'node:child_process'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {getTransactionTimeoutMs} from '../import-options.js'
import {applyManifest} from '../apply-epidropt.js'
import {digest} from '../epidropt.js'

test('la durée de transaction vaut 15 minutes et accepte uniquement une borne explicite', t => {
  t.is(getTransactionTimeoutMs(), 900_000)
  t.is(getTransactionTimeoutMs('900'), 900_000)
  t.is(getTransactionTimeoutMs(1), 1000)
  t.is(getTransactionTimeoutMs('1800'), 1_800_000)
  for (const value of [0, 1801, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null, true, {}, '', ' ', '1.5', '1e3', '+900', '900ms']) {
    t.throws(() => getTransactionTimeoutMs(value), {message: /entre 1 et 1800/})
  }
})

test('la CLI rejette une durée invalide avant de lire les accès ou de connecter la base', t => {
  const cli = fileURLToPath(new URL('../../import-epidropt.js', import.meta.url))
  const result = spawnSync(process.execPath, [cli, 'apply', '--target', 'testing', '--target-env', '/nonexistent-dropt-test.env', '--transaction-timeout-seconds', '1801'], {encoding: 'utf8'})
  t.is(result.status, 1)
  t.regex(result.stderr, /entre 1 et 1800 secondes/)
  t.notRegex(result.stderr, /ENOENT|Connexion/)
  t.is(result.stdout, '')
})

test('le budget configure une transaction unique sans désactiver le rollback par défaut', async t => {
  const payload = {formatVersion: 1, scope: 'epidropt', points: [], declarants: [], exploitations: [], meters: [], allocations: [], issues: []}
  const manifest = {...payload, manifestHash: digest(payload)}
  let transactions = 0
  const client = {$transaction: async (execute, options) => {
    transactions++
    t.deepEqual(options, {maxWait: 10_000, timeout: 42_000})
    const error = await t.throwsAsync(execute({$executeRaw: async () => 0, meterAllocation: {findMany: async () => []}}), {message: 'DRY_RUN_ROLLBACK'})
    throw error
  }}
  const result = await applyManifest(client, manifest, {transactionTimeoutSeconds: '42'})
  t.is(transactions, 1)
  t.false(result.applied)
  t.deepEqual(result.counts, {points: 0, declarants: 0, exploitations: 0, meters: 0})
  await t.throwsAsync(applyManifest(client, manifest, {transactionTimeoutSeconds: 1801}), {message: /entre 1 et 1800/})
  t.is(transactions, 1)
})
