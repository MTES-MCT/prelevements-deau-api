import test from 'ava'
import {randomUUID} from 'node:crypto'
import {digest, validateManifest} from '../reconcile.js'
import {parseReconcileOptions, assertReconcileReport, assertQuiescenceProof, reconcileCodeHash} from '../reconcile-cli.js'

const args = command => [command, '--manifest', '/tmp/manifest.json', '--payload', '/tmp/payload.json',
  '--target', 'prod', '--target-env', '/tmp/prod.env', '--tunnel-port', '55441', '--report', '/tmp/report.json']
const writeArgs = command => [...args(command), '--apply', '--quiescence-proof', '/tmp/quiescence.json',
  ...(command === 'rollback' ? ['--against-receipt', '/tmp/receipt.json'] : ['--against-report', '/tmp/review.json', '--backup-proof', '/tmp/backup.json'])]

test('Willie reconcile CLI: lecture seule par défaut, application explicite avec revue, sauvegarde et queue arrêtée', t => {
  for (const command of ['review', 'apply', 'verify']) t.false(parseReconcileOptions(args(command)).values.apply)
  t.throws(() => parseReconcileOptions([...args('review'), '--apply']))
  t.throws(() => parseReconcileOptions([...args('apply'), '--apply']))
  t.throws(() => parseReconcileOptions([...args('apply'), '--apply', '--quiescence-proof', '/tmp/quiescence.json']))
  t.true(parseReconcileOptions(writeArgs('apply')).values.apply)
  t.true(parseReconcileOptions(writeArgs('rollback')).values.apply)
  for (const target of ['demo', 'local', 'production']) t.throws(() => parseReconcileOptions([...args('review'), '--target', target]))
  for (const port of ['0', '1023', '65536', '5432x']) t.throws(() => parseReconcileOptions([...args('review'), '--tunnel-port', port]))
  t.throws(() => parseReconcileOptions(args('rollback')))
  t.throws(() => parseReconcileOptions([...args('verify'), '--against-report', '/tmp/review.json']))
  t.throws(() => parseReconcileOptions([...args('review'), '--quiescence-proof', '/tmp/quiescence.json']))
})

test('Willie reconcile CLI: les fichiers de sortie ne peuvent écraser aucune entrée ni preuve', t => {
  for (const output of ['/tmp/manifest.json', '/tmp/payload.json', '/tmp/prod.env', '/tmp/review.json',
    '/tmp/backup.json', '/tmp/quiescence.json']) {
    t.throws(() => parseReconcileOptions([...writeArgs('apply'), '--report', output]))
  }
  t.throws(() => parseReconcileOptions([...writeArgs('rollback'), '--report', '/tmp/receipt.json']))
  t.throws(() => parseReconcileOptions([...writeArgs('apply'), '--payload', '/tmp/report.json.before.json']))
  t.throws(() => parseReconcileOptions([...writeArgs('apply'), '--manifest', '/tmp/report.json.prepared.json']))
})

test('Willie reconcile CLI: preuve de pause récente, vide et liée au manifeste et à la cible', t => {
  const identity = {target: 'prod', manifestHash: 'a'.repeat(64)}
  const now = Date.parse('2026-11-02T12:00:00Z')
  const proof = {...identity, checkedAt: '2026-11-02T11:59:00Z', queue: 'pull-updated-data', paused: true, active: 0}
  t.notThrows(() => assertQuiescenceProof(proof, identity, now))
  for (const change of [{target: 'testing'}, {manifestHash: 'b'.repeat(64)}, {paused: false}, {active: 1},
    {active: '0'}, {queue: 'other'}, {checkedAt: 'invalid'}, {checkedAt: '2026-11-02T11:29:00Z'}, {checkedAt: '2026-11-02T12:01:00Z'}]) {
    t.throws(() => assertQuiescenceProof({...proof, ...change}, identity, now))
  }
})

test('Willie reconcile CLI: cible, code, données et revue vérifiés avant application ou restauration', async t => {
  const identity = {target: 'prod', codeHash: 'a'.repeat(64), manifestHash: 'b'.repeat(64), payloadHash: 'c'.repeat(64)}
  const before = {tables: {}, outside: {}}
  const report = {...identity, operation: 'willie-reconcile', applied: false, complete: true,
    blocked: [], before, stateHash: digest(before), planHash: 'd'.repeat(64)}
  t.notThrows(() => assertReconcileReport(report, identity))
  for (const change of [{target: 'testing'}, {codeHash: 'b'.repeat(64)}, {manifestHash: 'a'.repeat(64)},
    {payloadHash: 'd'.repeat(64)}, {complete: false}, {applied: true}, {before: {}}, {blocked: [{code: 'BLOCKED'}]}]) {
    t.throws(() => assertReconcileReport({...report, ...change}, identity))
  }
  t.notThrows(() => assertReconcileReport({...report, applied: true, status: 'COMMITTED'}, identity, true))
  t.throws(() => assertReconcileReport({...report, applied: true, status: 'PREPARED'}, identity, true))
  t.regex(await reconcileCodeHash(), /^[a-f0-9]{64}$/)
})

test('Willie reconcile manifest: rejet des stations répétées, jours invalides, valeurs nulles et hashes incohérents', t => {
  const entry = Object.fromEntries(['connectorId', 'sourcePointId', 'exploitationId', 'pointId', 'preleveurId'].map(key => [key, randomUUID()]))
  entry.rate = 100
  const window = {start: '2026-01-01', end: '2026-01-03'}
  const value = {periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-01-02T00:00:00.000Z', value: 0}
  const data = {version: 1, provider: 'willie', window, stations: [{sourcePointId: entry.sourcePointId, rawSha256: 'a'.repeat(64), values: [value]}]}
  const make = (changedData = data, entries = [entry]) => {
    const payload = {...changedData, payloadHash: digest(changedData)}
    const body = {version: 1, operation: 'willie-reconcile', createdAt: '2026-11-02T12:00:00.000Z',
      window, conflictPolicy: 'ARCHIVE_WHOLE_ROW', entries, retireConnectors: [], transfers: [],
      sourceHashes: {workbook: 'b'.repeat(64)}, payloadHash: payload.payloadHash}
    return [{...body, manifestHash: digest(body)}, payload]
  }
  const [manifest, payload] = make()
  t.notThrows(() => validateManifest(manifest, payload))
  t.throws(() => validateManifest({...manifest, entries: []}, payload))
  t.throws(() => validateManifest(manifest, {...payload, stations: []}))
  t.throws(() => validateManifest(...make(data, [entry, entry])))
  for (const values of [[{...value, value: null}], [{...value, value: -1}], [value, value],
    [{...value, periodStart: '2026-01-01T01:00:00.000Z'}], [{...value, periodEnd: '2026-01-03T00:00:00.000Z'}]]) {
    t.throws(() => validateManifest(...make({...data, stations: [{...data.stations[0], values}]})))
  }
})
