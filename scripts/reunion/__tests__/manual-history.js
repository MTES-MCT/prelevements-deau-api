import test from 'ava'
import {extractManualHistory, withdrawalDeclaration} from '../lib/manual-history.js'

const champ = (id, stringValue, rest = {}) => ({champDescriptorId: Buffer.from(`Champ-${id}`).toString('base64'), stringValue, ...rest})
const volume = (id, date, year) => ({id, champs: [champ(3888497, '412 | Point synthétique'), champ(3888512, '12.123456789012345'), champ(3888496, date), champ(3888520, year)]})
const payload = (rows, champs = []) => ({dossier: {ds: {dossierNumber: 1}}, rawDossier: {champs: [champ(3888490, '', {rows}), ...champs]}})

test('manual volumes retain the explicit aggregate period when precise dates are unknown', t => {
  const result = extractManualHistory(payload([volume('r1')], [champ(3888495, 'false'), champ(4460662, 'true'), champ(4460669, '04/2024'), champ(4460678, '12/2024')]))
  t.is(result.errors.length, 0)
  t.is(result.series.length, 1)
  t.is(result.series[0].frequency, 'irregular')
  t.is(result.series[0].data[0].periodStart, '2024-03-31T20:00:00.000Z')
  t.is(result.series[0].data[0].periodEnd, '2024-12-31T20:00:00.000Z')
  t.is(result.series[0].data[0].value, '12.123456789012345')
  t.deepEqual(result.series[0].data[0].metadata.periodEvidence, {preciseDatesKnown: false, multipleMonths: true, startMonth: '04/2024', endMonth: '12/2024'})
})

test('aggregate metadata cannot repair invalid explicit dates or contradict precise-date mode', t => {
  const fields = [champ(3888495, 'false'), champ(4460662, 'true'), champ(4460669, '01/2024'), champ(4460678, '12/2024')]
  t.is(extractManualHistory(payload([volume('r1', '15 juin 0024')], fields)).series.length, 0)
  t.is(extractManualHistory(payload([volume('r1', '', '204')], fields)).series.length, 0)
  t.is(extractManualHistory(payload([volume('r1')], fields.map(item => item.champDescriptorId === champ(3888495).champDescriptorId ? champ(3888495, 'true') : item))).series.length, 0)
  t.is(extractManualHistory(payload([volume('r1')], [champ(3888495, 'false'), champ(4460662, 'true'), champ(4460669, '12/2024'), champ(4460678, '01/2024')])).series.length, 0)
})

test('a reviewed period correction preserves the original row and requires exact source evidence', t => {
  const input = payload([volume('r1', '', '203')])
  const review = {sha256: 'a'.repeat(64), rows: [{row: 1, before: {pointPrelevement: 412, volumePompeM3: '12.123456789012345', datePrelevement: '', anneePrelevement: '203'}, after: {anneePrelevement: '2023'}, reason: 'Année confirmée par deux sources indépendantes'}]}
  const result = extractManualHistory({...input, review})
  t.is(result.series[0].frequency, '1 year')
  t.is(result.series[0].data[0].metadata.rawRow.anneePrelevement, '203')
  t.is(result.series[0].data[0].metadata.reviewedCorrection.reviewSha256, review.sha256)
  t.is(extractManualHistory(input).series.length, 0)
  t.throws(() => extractManualHistory({...input, review: {...review, sha256: ''}}))
  t.throws(() => extractManualHistory({...input, review: {...review, rows: [{...review.rows[0], before: {...review.rows[0].before, volumePompeM3: '99'}}]}}))
  t.throws(() => extractManualHistory({...input, review: {...review, rows: [{...review.rows[0], after: {volumePompeM3: '99'}}]}}))
  t.throws(() => extractManualHistory({...input, review: {...review, rows: [...review.rows, ...review.rows]}}))
})

test('no-withdrawal reporting includes nested points without treating missing answers or comments as zero', t => {
  const point = (id, answer) => ({id, champs: [champ(4017191, `${id} | Point synthétique`), champ(4465807, answer)]})
  const input = rows => ({champs: [champ(3642783, '', {rows})]})
  t.is(withdrawalDeclaration(input([point(1, 'false'), point(2, 'false')])).declaredWithdrawal, false)
  t.is(withdrawalDeclaration(input([point(1, 'false'), point(2, undefined)])).declaredWithdrawal, null)
  t.is(withdrawalDeclaration(input([point(1, 'false'), point(2, 'true')])).declaredWithdrawal, true)
  t.is(withdrawalDeclaration({champs: [champ(3645094, 'Pas de prélèvement')]}).declaredWithdrawal, null)
  const contradiction = input([point(1, 'true')]); contradiction.champs.push(champ(4152855, 'false'))
  t.true(withdrawalDeclaration(contradiction).conflict)
  t.is(withdrawalDeclaration(contradiction).declaredWithdrawal, null)
})
