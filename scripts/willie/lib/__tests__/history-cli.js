import test from 'ava'
import {randomUUID} from 'node:crypto'
import {digest, validateScope} from '../history.js'
import {parseHistoryOptions, assertHistoryReport, historyCodeHash} from '../history-cli.js'

const args = command => [command, '--scope', '/tmp/scope.json', '--target', 'prod', '--target-env', '/tmp/prod.env',
  '--tunnel-port', '55441', '--report', '/tmp/report.json']
test('Willie CLI lecture seule par défaut, prod/testing explicites, écriture strictement annoncée', t => {
  for (const command of ['review', 'apply', 'verify']) t.false(parseHistoryOptions(args(command)).values.apply)
  t.throws(() => parseHistoryOptions([...args('review'), '--apply']), {message: 'WILLIE_APPLY_INVALID'})
  t.throws(() => parseHistoryOptions([...args('apply'), '--apply']), {message: 'WILLIE_REVIEW_BACKUP_REQUIRED'})
  t.true(parseHistoryOptions([...args('apply'), '--apply', '--against-report', '/tmp/review.json', '--backup-proof', '/tmp/proof.json']).values.apply)
  for (const target of ['demo', 'local', 'production']) t.throws(() => parseHistoryOptions([...args('review'), '--target', target]), {message: 'WILLIE_ARGUMENTS_REQUIRED'})
  for (const port of ['0', '1023', '65536', '5432x']) t.throws(() => parseHistoryOptions([...args('review'), '--tunnel-port', port]), {message: 'WILLIE_TUNNEL_REQUIRED'})
})
test('Willie rollback et sorties privées exigent reçu distinct et option explicite', t => {
  t.throws(() => parseHistoryOptions(args('rollback')), {message: 'WILLIE_ROLLBACK_RECEIPT_REQUIRED'})
  t.true(parseHistoryOptions([...args('rollback'), '--apply', '--against-receipt', '/tmp/receipt.json']).values.apply)
  for (const output of ['/tmp/prod.env', '/tmp/scope.json', '/tmp/receipt.json']) {
    t.throws(() => parseHistoryOptions([...args('rollback'), '--apply', '--against-receipt', '/tmp/receipt.json', '--report', output]), {message: 'WILLIE_OUTPUT_OVERWRITES_INPUT'})
  }
  t.throws(() => parseHistoryOptions([...args('verify'), '--against-report', '/tmp/review.json']), {message: 'WILLIE_OPTIONS_INCOMPATIBLE'})
})
test('Willie scope signé exige identités exactes et refuse duplication ou altération', t => {
  const payload = {version: 1, connector: 'willie', entries: [{connectorId: randomUUID(), exploitationId: randomUUID(),
    preleveurId: randomUUID(), pointId: randomUUID(), sourcePointId: 'synthetic-station', rate: 50}]}
  const scope = {...payload, scopeHash: digest(payload)}
  t.notThrows(() => validateScope(scope))
  t.throws(() => validateScope({...scope, entries: []}), {message: 'WILLIE_SCOPE_INVALID'})
  const duplicate = {...payload, entries: [payload.entries[0], payload.entries[0]]}
  t.throws(() => validateScope({...duplicate, scopeHash: digest(duplicate)}), {message: 'WILLIE_SCOPE_DUPLICATE'})
  const malformed = {...payload, entries: [{...payload.entries[0], rate: 101}]}
  t.throws(() => validateScope({...malformed, scopeHash: digest(malformed)}), {message: 'WILLIE_SCOPE_ENTRY_INVALID'})
})
test('Willie reporte cible, code, scope et status avant toute mutation', async t => {
  const identity = {target: 'prod', codeHash: 'a'.repeat(64), scopeHash: 'b'.repeat(64)}
  const report = {...identity, operation: 'willie-history', applied: false, complete: true, blocked: [], stateHash: 'c'.repeat(64), planHash: 'd'.repeat(64)}
  t.notThrows(() => assertHistoryReport(report, identity))
  for (const change of [{target: 'testing'}, {scopeHash: 'a'.repeat(64)}, {codeHash: 'b'.repeat(64)}, {complete: false}, {applied: true}]) {
    t.throws(() => assertHistoryReport({...report, ...change}, identity), {message: 'WILLIE_REPORT_MISMATCH'})
  }
  t.notThrows(() => assertHistoryReport({...report, applied: true, status: 'COMMITTED'}, identity, true))
  t.regex(await historyCodeHash(), /^[a-f0-9]{64}$/)
})
