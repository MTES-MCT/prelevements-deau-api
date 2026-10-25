import test from 'ava'
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {collectDossierFiles, fetchHistoricalDossiers, DN_ENDPOINT} from '../lib/dn-client.js'
import {extractManualHistory, localDate} from '../lib/manual-history.js'
import {sanitizeArchive} from '../capture-legacy.js'
import {reusePreparedDossier} from '../prepare-history.js'
import {resolveHistoricalDeclarant} from '../lib/historical-declarants.js'
import {importHistory} from '../import-history.js'
import {applyReviewedIdentity} from '../reconcile-history.js'
import {localFormatScope} from '../enable-local-formats.js'
import {manifestLines} from '../lib/core.js'

const champ = (id, stringValue) => ({champDescriptorId: Buffer.from(`Champ-${id}`).toString('base64'), stringValue})
test('manual historical values use exact DN strings and Réunion dates', t => {
  const result = extractManualHistory({dossier: {ds: {dossierNumber: 1}, pointPrelevement: 412, relevesIndex: [{date: '2024-01-01', valeur: 1}]},
    rawDossier: {number: 1, champs: [{...champ(3888549), rows: [{id: 'synthetic-row', champs: [champ(3888598, '2024-01-01'), champ(3888599, '123456789012.123456789012345')]}]}]}})
  t.is(result.series[0].data[0].value, '123456789012.123456789012345')
  t.is(result.series[0].data[0].periodStart, '2023-12-31T20:00:00.000Z')
  t.is(result.series[0].data[0].periodEnd, result.series[0].data[0].periodStart)
  t.is(result.errors.length, 0)
})
test('annual pumped volumes stay annual and bad rows do not discard good rows', t => {
  const result = extractManualHistory({dossier: {ds: {dossierNumber: 2}, volumesPompes: [
    {pointPrelevement: 412, anneePrelevement: '2023', volumePompeM3: 88},
    {pointPrelevement: 412, datePrelevement: '15 juin 0024', volumePompeM3: 7},
    {pointPrelevement: 412, volumePompeM3: 9}
  ]}})
  t.is(result.series.length, 1)
  t.is(result.series[0].frequency, '1 year')
  t.is(result.series[0].data[0].periodEnd, '2023-12-31T20:00:00.000Z')
  t.is(result.series[0].data[0].value, '88')
  t.is(result.errors.length, 2)
  t.is(result.errors[0].rawRow.datePrelevement, '15 juin 0024')
  t.is(localDate('31 février 2024'), null)
  t.is(localDate('29 février 2024'), '2024-02-28T20:00:00.000Z')
})
test('DN file collection keeps signed URLs in memory only', t => {
  const files = new Map()
  const clean = collectDossierFiles({pdf: {url: 'https://example.test/secret'}, nested: [{files: [{filename: 'synthetic.xlsx', checksum: 'synthetic', url: 'https://example.test/signed/path?token=secret'}]}]}, 123, files)
  t.is(files.size, 1)
  t.false(JSON.stringify(clean).includes('secret'))
  t.regex(clean.nested[0].files[0].storageKey, /^demarche-80149\/dossiers\/123\/attachments\/[a-f\d]{8}-synthetic.xlsx$/)
  t.deepEqual(sanitizeArchive({password: 'secret', safe: 1, token: 'secret'}), {safe: 1})
})
test('DN connector follows cursors and never exposes auth outside fixed endpoint', async t => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({url, options})
    const second = calls.length === 2
    return {ok: true, json: async () => ({data: {demarche: {number: 80149, dossiers: {
      nodes: [{number: second ? 2 : 1}], pageInfo: {hasNextPage: !second, endCursor: second ? 'b' : 'a'}
    }}}})}
  }
  const dossiers = []
  for await (const dossier of fetchHistoricalDossiers({token: 'synthetic-only', fetchImpl})) dossiers.push(dossier.number)
  t.deepEqual(dossiers, [1, 2])
  t.true(calls.every(call => call.url === DN_ENDPOINT && call.options.redirect === 'error'))
  t.is(JSON.parse(calls[1].options.body).variables.after, 'a')
})
test('DN partial GraphQL response is rejected instead of losing dossiers', async t => {
  const fetchImpl = async () => ({ok: true, json: async () => ({errors: [{message: 'synthetic'}]})})
  await t.throwsAsync(async () => { for await (const dossier of fetchHistoricalDossiers({token: 'synthetic', fetchImpl})) t.fail(String(dossier.number)) }, {message: /GraphQL DN incomplète/})
})
test('historical preparation resumes intact partitions and rejects corrupted content', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reunion-history-test-'))
  t.teardown(() => rm(root, {recursive: true, force: true}))
  const resumeFrom = path.join(root, 'previous'), destination = path.join(root, 'next')
  await mkdir(path.join(resumeFrom, 'parts'), {recursive: true})
  await mkdir(path.join(destination, 'parts'), {recursive: true})
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  const bytes = JSON.stringify({data: {nativeTemporal: true, series: []}, errors: []})
  const checksum = digest(bytes), relativePath = `parts/${checksum}.json`
  await writeFile(path.join(resumeFrom, relativePath), bytes)
  const legacy = {ds: {dossierNumber: 1}}, raw = null
  const payload = {legacy, rawDossier: raw, type: 'reunion_multi_param', parsedFiles: [{checksum, storageKey: 'synthetic', seriesCount: 0, valueCount: 0}],
    declarantResolution: {method: 'REVIEWED_SOURCE_EVIDENCE', sourceId: 'synthetic-owner', reviewSha256: 'synthetic-review'}}
  const record = {externalId: '80149:1', payload, files: [], issues: [], sourceHash: digest(JSON.stringify({payload, files: []}))}
  await writeFile(path.join(resumeFrom, 'dossier-1.json'), JSON.stringify(record))
  const context = {resumeFrom, destination, number: 1, legacy, raw, sourceFiles: new Map(), objectByKey: new Map(), legacySeries: []}
  const result = await reusePreparedDossier(context)
  t.deepEqual(result.parsedFiles, payload.parsedFiles)
  t.deepEqual(result.reviewedIdentity, payload.declarantResolution)
  t.is(await readFile(path.join(destination, relativePath), 'utf8'), bytes)
  await writeFile(path.join(resumeFrom, relativePath), 'corrupted')
  await t.throwsAsync(reusePreparedDossier(context), {message: /Partition à reprendre modifiée/})
  t.is(await reusePreparedDossier({...context, number: 2}), null)
})
test('historical owner matching requires one exact legal name and corroborated points', t => {
  const preleveurs = [{_id: 'owner-1', id_preleveur: 1, raison_sociale: 'Structure synthétique'}]
  const points = [{_id: 'point-1', id_point: 10}]
  const exploitations = [{_id: 'link-1', id_exploitation: 20, point: 'point-1', preleveur: 'owner-1'}]
  const legacy = {declarant: {raisonSociale: 'Structure synthétique'}, pointPrelevement: 10}
  const resolve = changes => resolveHistoricalDeclarant({legacy, preleveurs, points, exploitations, ...changes})
  t.is(resolve({}).owner.id_preleveur, 1)
  t.is(resolve({legacy: {...legacy, pointPrelevement: undefined}}).proposal.method, 'EXACT_LEGAL_NAME_ONLY')
  t.is(resolve({legacy: {...legacy, result: {foundPointPrelevements: [999]}}}).owner, null)
  t.is(resolve({preleveurs: [...preleveurs, {...preleveurs[0], _id: 'owner-2', id_preleveur: 2}]}).owner, null)
  t.is(resolve({legacy: {declarant: {raisonSociale: 'Structure proche'}}}).owner, null)
  t.is(resolve({exploitations: [{...exploitations[0], deletedAt: new Date('2026-01-01')}]}).owner, null)
})
test('historical import cannot include unaccepted DN dossiers', async t => {
  await t.throwsAsync(importHistory({sourcePolicy: 'all'}), {message: /Seuls les dossiers DN acceptés/})
})
test('reviewed identity changes only the declarant and rejects holds or stale associations', t => {
  const record = {externalId: '80149:1', files: [], payload: {declarantSourceId: null, type: 'reunion_multi_param', parsedFiles: [{checksum: 'synthetic'}]}}
  const evidence = {dossier: 1, status: 'IDENTITY_PROVEN', proposedSourceId: 'reunion:DEP-974:declarant:1', proofTypes: ['EXACT_NAME_AND_AOT']}
  const options = {reviewHash: 'synthetic', owners: new Map([['reunion:DEP-974:declarant:1', 'source-1']])}
  const changed = applyReviewedIdentity(record, evidence, options)
  t.is(changed.payload.declarantSourceId, evidence.proposedSourceId)
  t.deepEqual(changed.payload.parsedFiles, record.payload.parsedFiles)
  t.is(record.payload.declarantSourceId, null)
  t.throws(() => applyReviewedIdentity(record, {...evidence, status: 'HOLD_PERSON_CONFLICT'}, options))
  t.throws(() => applyReviewedIdentity(changed, evidence, options))
  t.throws(() => applyReviewedIdentity(record, evidence, {...options, owners: new Map()}))
})
test('local format grant is restricted to the 244 exact Réunion reference identities', t => {
  const rows = Array.from({length: 244}, (_, index) => ({kind: 'declarant', data: {id_preleveur: index + 1}}))
  const header = {territory: 'DEP-974', transformationContract: {}}
  t.is(localFormatScope(manifestLines(header, rows)).length, 244)
  t.throws(() => localFormatScope(manifestLines(header, rows.slice(1))))
  t.throws(() => localFormatScope(manifestLines(header, [...rows.slice(1), rows[1]])))
  t.throws(() => localFormatScope(manifestLines({...header, territory: 'DEP-33'}, rows)))
})
