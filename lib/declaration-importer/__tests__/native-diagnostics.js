import test from 'ava'
import {summarizeNativeIssues, mergeNativeDiagnostics} from '../native-diagnostics.js'

test('de nombreuses cellules invalides gardent leurs comptes et les conflits restent visibles dans un échantillon borné', t => {
  const errors = Array.from({length: 150000}, (_, row) => ({code: 'INVALID_VALUE', severity: 'error', row}))
  errors.push({code: 'OVERLAPPING_SERIES', severity: 'error', seriesKey: 'conflict'})
  const result = summarizeNativeIssues(errors, 25)
  t.is(result.issues.length, 25)
  t.true(result.issues.some(issue => issue.code === 'OVERLAPPING_SERIES'))
  t.is(result.issueCounts.total, 150001)
  t.deepEqual(result.issueCounts.byCode, {INVALID_VALUE: 150000, OVERLAPPING_SERIES: 1})
  t.true(result.issuesSampled)
})

test('reprise d’anciennes erreurs complètes puis cumul des nouveaux lots sans compter seulement l’échantillon', t => {
  const first = mergeNativeDiagnostics({parsingErrors: Array.from({length: 2000}, (_, row) => ({code: 'OLD', row, severity: 'warning'}))}, [{code: 'NEXT', severity: 'error'}])
  const next = mergeNativeDiagnostics(first, [{code: 'NEXT', severity: 'error'}])
  t.is(next.parsingErrors.length, 100)
  t.is(next.parsingErrorCounts.total, 2002)
  t.deepEqual(next.parsingErrorCounts.byCode, {OLD: 2000, NEXT: 2})
  t.deepEqual(next.parsingErrorCounts.bySeverity, {warning: 2000, error: 2})
  t.true(next.hasAnomalies)
})
