import test from 'ava'
import {randomUUID} from 'node:crypto'
import {mkdtemp, chmod, readFile, rm, stat, symlink} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {applyCampaignPublications, assertIndependentPublicationTargets, assertPublicationRecheckReport, publicationRecheckHash,
  privatePublicationReportDirectory, readPrivatePublicationReport, summarizePublicationRecheck,
  validatePublicationRecheckScope, writePrivatePublicationReport} from '../lib/campaign-publication-recheck.js'
import {parsePublicationRecheckArguments} from '../recheck-campaign-publications.js'

function fixture() {
  const scope = {target: 'prod', campaignId: randomUUID(), responseIds: [randomUUID()]}
  const report = {version: 1, operation: 'recheck-campaign-publications', mode: 'preview', complete: true,
    ...scope, entries: [{responseId: scope.responseIds[0]}]}
  report.reportHash = publicationRecheckHash(report)
  return {scope, report}
}

test('scope refuses implicit whole-campaign selection, duplicate identifiers and unsupported targets', t => {
  const {scope} = fixture()
  t.deepEqual(validatePublicationRecheckScope(scope), scope)
  for (const change of [{responseIds: []}, {responseIds: [scope.responseIds[0], scope.responseIds[0]]},
    {responseIds: ['not-an-id']}, {campaignId: ''}, {target: 'local'}, {target: 'testing'}]) {
    t.throws(() => validatePublicationRecheckScope({...scope, ...change}))
  }
})

test('a modified report or a changed operation scope is refused before database access', async t => {
  const {scope, report} = fixture()
  t.notThrows(() => assertPublicationRecheckReport(report, report.reportHash, scope, 'preview'))
  const edited = {...report, entries: [{responseId: randomUUID()}]}
  t.throws(() => assertPublicationRecheckReport(edited, report.reportHash, scope, 'preview'), {message: /empreinte/})
  t.throws(() => assertPublicationRecheckReport(report, report.reportHash, {...scope, campaignId: randomUUID()}, 'preview'), {message: /périmètre/})
  await t.throwsAsync(applyCampaignPublications({}, {...scope, expectedReport: report, expectedReportHash: report.reportHash}),
    {message: /Sauvegarde privée/})
  await t.throwsAsync(applyCampaignPublications({}, {...scope, expectedReport: edited, expectedReportHash: report.reportHash,
    onBeforeApply: async () => ({saved: true})}), {message: /empreinte/})
})

test('canonical report hashes are stable across object key order but detect value changes', t => {
  t.is(publicationRecheckHash({b: new Date('2026-10-07Z'), a: {y: 1, x: [2, 3]}}),
    publicationRecheckHash({a: {x: [2, 3], y: 1}, b: '2026-10-07T00:00:00.000Z'}))
  t.not(publicationRecheckHash({ids: ['a', 'b']}), publicationRecheckHash({ids: ['b', 'a']}))
})

test('shared points or meters require single-response operations before any backup or write', t => {
  const first = {eligible: true, pointPrelevementId: randomUUID(), compteurIds: [randomUUID()]}
  const other = {eligible: true, pointPrelevementId: randomUUID(), compteurIds: [randomUUID()]}
  t.notThrows(() => assertIndependentPublicationTargets([first, other]))
  t.throws(() => assertIndependentPublicationTargets([first, {...other, compteurIds: first.compteurIds}]), {message: /séparément/})
  t.throws(() => assertIndependentPublicationTargets([first, {...other, pointPrelevementId: first.pointPrelevementId}]), {message: /séparément/})
  t.notThrows(() => assertIndependentPublicationTargets([first, {...first, eligible: false}]))
})

test('private reports are durable, exclusive, private and cannot follow a symbolic link', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'campaign-recheck-test-'))
  t.teardown(() => rm(directory, {recursive: true, force: true}))
  const file = path.join(directory, 'report.json')
  const report = {before: {draftData: {comment: 'Synthetic private draft'}}}
  const reference = await writePrivatePublicationReport(file, report)
  t.is(reference.sha256, publicationRecheckHash(report))
  t.is((await stat(file)).mode & 0o777, 0o600)
  t.deepEqual(await readPrivatePublicationReport(file), report)
  await t.throwsAsync(writePrivatePublicationReport(file, {overwritten: true}), {code: 'EEXIST'})
  t.deepEqual(JSON.parse(await readFile(file, 'utf8')), report)
  const link = path.join(directory, 'link.json')
  await symlink(file, link)
  await t.throwsAsync(readPrivatePublicationReport(link), {code: 'ELOOP'})
  await chmod(file, 0o644)
  await t.throwsAsync(readPrivatePublicationReport(file), {message: /0600/})
  await chmod(directory, 0o755)
  await t.throwsAsync(privatePublicationReportDirectory(directory), {message: /0700/})
})

test('CLI requires an explicit mode, fixed scope, report hash and backup directory for writes', t => {
  const {scope} = fixture()
  const common = ['--target', 'prod', '--campaign-id', scope.campaignId, '--response-ids', scope.responseIds.join(','),
    '--report', '/tmp/private/report.json']
  t.is(parsePublicationRecheckArguments(['--mode', 'preview', ...common]).mode, 'preview')
  t.throws(() => parsePublicationRecheckArguments(common), {message: /mode/})
  t.throws(() => parsePublicationRecheckArguments(['--mode', 'apply', ...common]), {message: /expected-report/})
  t.throws(() => parsePublicationRecheckArguments(['--mode', 'apply', ...common, '--expected-report', '/tmp/private/preview.json',
    '--expected-report-hash', 'a'.repeat(64)]), {message: /backup-dir/})
  t.throws(() => parsePublicationRecheckArguments(['--mode', 'preview', ...common, '--allow-any-database']), {code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION'})
})

test('operator summary counts distinct reason codes without copying personal messages', t => {
  const summary = summarizePublicationRecheck([
    {eligible: true, changed: true, publicationStatus: 'PENDING_REVIEW', publicationIssues: [
      {code: 'ATTACHMENT_REVIEW', message: 'Private name'}, {code: 'ATTACHMENT_REVIEW', message: 'Private name'}]},
    {eligible: true, changed: false, publicationStatus: 'PUBLISHED', publicationIssues: []},
    {eligible: false, publicationStatus: 'NOT_SUBMITTED', publicationIssues: []}
  ])
  t.deepEqual(summary, {counts: {total: 3, eligible: 2, changed: 1, unchanged: 2, excluded: 1, published: 1, pending: 1},
    reasons: {ATTACHMENT_REVIEW: 1}})
  t.false(JSON.stringify(summary).includes('Private'))
})
