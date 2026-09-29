import test from 'ava'
import ExcelJS from 'exceljs'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {CAMPAIGN_PREFILL_HEADERS, CAMPAIGN_PREFILL_SHEET, loadCampaignPrefillSource, parseCampaignPrefillRows} from '../campaign-prefill-source.js'

function sourceRow(overrides = {}) {
  const values = Array(25).fill(null)
  const fields = {
    A: '00123', B: 'POINT-001CACG_123', C: '12345678900001', D: '1000', E: '12', F: '3', G: '987',
    H: '4', I: '15', J: '888', K: '999', L: '100', M: '888', N: '200', O: '888', P: '999', Q: '0',
    R: '00124', S: '00124', T: 'SERIAL-001', U: '40', V: '10000', W: 'Irrigation', X: 'Remplissage retenue',
    ...overrides
  }
  for (const [column, value] of Object.entries(fields)) values[column.charCodeAt(0) - 65] = value
  return values
}

function parse(...rows) {
  return parseCampaignPrefillRows([[...CAMPAIGN_PREFILL_HEADERS], ...rows])
}

test('proposes future needs from explicit columns and retains unallocated physical index', t => {
  const result = parse(sourceRow())
  const record = result.records[0]
  t.deepEqual(record.needs, {
    season: {volume: '1000', flow: '12', surface: '3', usageCode: '2'},
    offSeason: {volume: '300', flow: '15', surface: '4', usageCode: '12E'}
  })
  t.deepEqual(record.reading, {date: '2025-10-31', index: '10000'})
  t.is(record.indexEvidence, '10000')
  t.deepEqual(record.sourceRows, [2])
  t.is(record.identity.pointOugc, 'POINT-001CACG_123')
  t.is(record.identity.pointAeag, '00123')
  t.is(record.identity.countingOugc, '00124')
  t.true(record.eligible)
  t.deepEqual(result.issues, [])
  t.false('meters' in record)
  t.false('comment' in record)
  t.false('crops' in record.needs.season)
  t.deepEqual(record.sourceValues[0].values, sourceRow())
})

test('decimal addition is exact and rounds once, preserving up to twelve integer digits', t => {
  const record = parse(sourceRow({D: '999999999999.9999', L: '0.00004', N: '0.00004', Q: '0.00004', E: '3,25', F: '1e-5'})).records[0]
  t.is(record.needs.offSeason.volume, '0.0001')
  t.is(record.needs.season.volume, '999999999999.9999')
  t.is(record.needs.season.flow, '3.25')
  t.is(record.needs.season.surface, '0')
  t.is(parse(sourceRow({L: 1e-7, N: 1e-7, Q: 0.10005})).records[0].needs.offSeason.volume, '0.1001')
  t.is(parse(sourceRow({D: '000003.40000'})).records[0].needs.season.volume, '3.4')
})

test('missing or invalid winter components never become zero or fall back to authorized G', t => {
  for (const invalid of [null, '', '-1', 'Y20RI000000', '15+42', '8/10', '1e100', '1e30', '999999999999.99996']) {
    const record = parse(sourceRow({L: invalid, G: '9000'})).records[0]
    t.false('volume' in record.needs.offSeason)
    t.true(record.issues.some(issue => issue.code === 'INCOMPLETE_WINTER_VOLUME'))
  }
  const record = parse(sourceRow({L: 0, N: '0', Q: '0.00', D: 0})).records[0]
  t.is(record.needs.offSeason.volume, '0')
  t.is(record.needs.season.volume, '0')
  t.is(record.needs.offSeason.flow, '15')
})

test('rounding cannot overflow twelve digits and negative or annotated fields stay empty', t => {
  for (const invalid of ['1000000000000', '999999999999.99996', '-2', 'Volume attribué sur un autre point', '15+42']) {
    const record = parse(sourceRow({D: invalid})).records[0]
    t.false('volume' in record.needs.season)
    t.true(record.issues.some(issue => issue.code === 'INVALID_NUMBER'))
  }
})

test('a real second winter usage excludes the entire winter block but preserves summer and readings', t => {
  const record = parse(sourceRow({Y: 'Lutte anti-gel'})).records[0]
  t.deepEqual(record.needs.offSeason, {})
  t.is(record.needs.season.volume, '1000')
  t.is(record.reading.index, '10000')
  t.true(record.issues.some(issue => issue.code === 'MULTIPLE_WINTER_USAGES'))
  t.is(parse(sourceRow({Y: 'Sans usage'})).records[0].needs.offSeason.volume, '300')
})

test('sans usage is authorization metadata, not a future usage or fabricated zero', t => {
  const record = parse(sourceRow({X: '  Sans usage  ', L: null, N: null, Q: null})).records[0]
  t.true(record.metadata.noAuthorizedOffSeasonUsage)
  t.false('usageCode' in record.needs.offSeason)
  t.false('volume' in record.needs.offSeason)
  t.is(record.reading.index, '10000')
  t.is(parse(sourceRow({X: 'Lutte anti-gel'})).records[0].needs.offSeason.usageCode, '2E')
  const unknown = parse(sourceRow({X: 'Usage inconnu'})).records[0]
  t.false('usageCode' in unknown.needs.offSeason)
  t.true(unknown.issues.some(issue => issue.code === 'UNKNOWN_USAGE'))
})

test('zero, negative and annotated index observations remain evidence without prefilling', t => {
  for (const [value, evidence] of [[0, '0'], ['-5.000', '-5'], ['10939 (x10)', 'text:10939 (x10)'], [null, null]]) {
    const record = parse(sourceRow({V: value})).records[0]
    t.is(record.reading, null)
    t.is(record.indexEvidence, evidence)
  }
  t.is(parse(sourceRow({V: '0.0000001'})).records[0].reading, null)
})

test('serial contradictions are detected before zeros are discarded, including out of scope CACG rows', t => {
  for (const contrary of [0, -3, '20', '10000.00001', '10939 (x10)']) {
    const result = parse(sourceRow({B: 'LOCAL'}), sourceRow({B: 'CACG_123', V: contrary}))
    t.is(result.summary.serialConflicts, 1)
    t.true(result.records.every(record => record.reading === null))
    t.true(result.records.every(record => record.issues.some(issue => issue.code === 'CONFLICTING_SERIAL_INDEX')))
  }
  const identical = parse(sourceRow(), sourceRow({B: 'OTHER', V: '1e4'}))
  t.is(identical.summary.serialConflicts, 0)
  t.true(identical.records.every(record => record.reading.index === '10000'))
})

test('blank and descriptive serials require unique database allocation instead of invented meters', t => {
  for (const serial of [null, '0', 'ND', 'Pas de compteur installé', 'Compteur linky 636', 'Pas encore équipé', 'SERIAL – Diam 100', 'A/B']) {
    const record = parse(sourceRow({T: serial})).records[0]
    t.is(record.identity.serialNumber, null)
    t.is(record.reading.index, '10000')
    t.true(record.issues.some(issue => issue.code === 'UNUSABLE_SERIAL'))
  }
  t.is(parse(sourceRow({T: ' WA032 A172 '})).records[0].identity.serialNumber, 'WA032 A172')
  const unreferenced = parse(sourceRow({T: 'Pas de compteur installé'}), sourceRow({B: 'OTHER', T: 'Pas de compteur installé', V: 0}))
  t.is(unreferenced.summary.serialConflicts, 0)
  t.is(unreferenced.records[0].reading.index, '10000')
})

test('duplicate rows collapse without adding volumes and keep all provenance rows', t => {
  const result = parse(sourceRow(), sourceRow())
  t.is(result.records.length, 1)
  t.deepEqual(result.records[0].sourceRows, [2, 3])
  t.is(result.records[0].sourceValues.length, 2)
  t.is(result.records[0].needs.season.volume, '1000')
  t.is(result.records[0].needs.offSeason.volume, '300')
  t.true(result.records[0].eligible)
  t.is(result.summary.duplicateGroups, 1)
})

test('conflicting duplicate data or secondary identifiers cannot be silently chosen', t => {
  for (const change of [{D: '2000'}, {A: '9999'}, {F: null}, {S: '9999'}, {V: '20000'}]) {
    const record = parse(sourceRow(), sourceRow(change)).records[0]
    t.false(record.eligible)
    t.deepEqual(record.needs, {season: {}, offSeason: {}})
    t.is(record.reading, null)
    t.true(record.issues.some(issue => issue.code === 'CONFLICTING_DUPLICATE'))
  }
  t.deepEqual(parse(sourceRow(), sourceRow({V: '0'})).records[0].indexEvidenceValues, ['10000', '0'])
  const record = parse(sourceRow(), sourceRow({U: '20', G: '200000'})).records[0]
  t.true(record.eligible)
  t.is(record.reading.index, '10000')
})

test('matching keys never collapse separate owners or counting codes and invalid identities stay excluded', t => {
  const result = parse(sourceRow(), sourceRow({C: '12345678900002'}), sourceRow({R: '00125'}))
  t.is(result.records.length, 3)
  for (const change of [{C: 'INCONNU'}, {C: '123'}, {B: null}, {R: null}]) {
    t.false(parse(sourceRow(change)).records[0].eligible)
  }
  t.is(parse(sourceRow({C: 12345678900001})).records[0].identity.siret, '12345678900001')
})

test('duplicate rows preserve each original meter identity with its own index evidence', t => {
  const record = parse(
    sourceRow({T: 'SERIAL-A', V: '100'}),
    sourceRow({T: 'SERIAL-B', V: '200', A: 'SECONDARY-B'}),
    sourceRow({T: null, V: 0}),
    sourceRow({T: 'SERIAL-C', V: '10939 (x10)'}),
    sourceRow({T: 'SERIAL-D', V: null})
  ).records[0]
  t.false(record.eligible)
  t.deepEqual(record.indexSources.map(({identity, indexEvidence, sourceRows}) => ({
    serial: identity.serialNumber, pointAeag: identity.pointAeag, evidence: indexEvidence, rows: sourceRows
  })), [
    {serial: 'SERIAL-A', pointAeag: '00123', evidence: '100', rows: [2]},
    {serial: 'SERIAL-B', pointAeag: 'SECONDARY-B', evidence: '200', rows: [3]},
    {serial: null, pointAeag: '00123', evidence: '0', rows: [4]},
    {serial: 'SERIAL-C', pointAeag: '00123', evidence: 'text:10939 (x10)', rows: [5]},
    {serial: 'SERIAL-D', pointAeag: '00123', evidence: null, rows: [6]}
  ])
  record.identity.serialNumber = 'MUTATED'
  t.is(record.indexSources[0].identity.serialNumber, 'SERIAL-A')
})

test('rejects shifted or extra columns, formulas, errors, unsupported values and oversized input', t => {
  const headers = [...CAMPAIGN_PREFILL_HEADERS]
  const summerHeader = headers[3]
  headers[3] = headers[6]
  headers[6] = summerHeader
  t.throws(() => parseCampaignPrefillRows([headers, sourceRow()]), {message: /D1/})
  t.throws(() => parse([...sourceRow(), 'unexpected']), {message: /Colonne inattendue/})
  for (const value of [{formula: '1+1', result: 2}, {sharedFormula: 'D2', result: 2}, {error: '#REF!'}, new Date(), true, Infinity]) {
    t.throws(() => parse(sourceRow({D: value})))
  }
  t.throws(() => parseCampaignPrefillRows(Array(10001).fill([])), {message: /trop grand/})
  t.throws(() => parseCampaignPrefillRows([CAMPAIGN_PREFILL_HEADERS]), {message: /aucune ligne/})
})

test('source parsing is deterministic and does not mutate input', t => {
  const rows = [[...CAMPAIGN_PREFILL_HEADERS], sourceRow(), Array(25).fill(null), sourceRow({B: 'OTHER'})]
  const before = structuredClone(rows)
  const first = parseCampaignPrefillRows(rows)
  t.deepEqual(rows, before)
  t.deepEqual(first, parseCampaignPrefillRows(rows))
  t.deepEqual(first.records[1].sourceRows, [4])
  t.is(first.summary.sourceRows, 2)
})

test('loads exact expected sheet and computes source hash on private input bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dropt-prefill-source-test-'))
  t.teardown(() => rm(directory, {recursive: true, force: true}))
  const path = join(directory, 'synthetic.xlsx')
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet(CAMPAIGN_PREFILL_SHEET)
  sheet.addRow([...CAMPAIGN_PREFILL_HEADERS])
  sheet.addRow(sourceRow())
  await writeFile(path, await workbook.xlsx.writeBuffer())
  const result = await loadCampaignPrefillSource(path)
  t.regex(result.source.sha256, /^[a-f0-9]{64}$/)
  t.is(result.source.sheetName, CAMPAIGN_PREFILL_SHEET)
  t.is(result.source.fileName, 'synthetic.xlsx')
  t.is(result.records[0].needs.offSeason.volume, '300')
  sheet.name = 'OTHER'
  await writeFile(path, await workbook.xlsx.writeBuffer())
  await t.throwsAsync(loadCampaignPrefillSource(path), {message: /Feuille absente/})
})
