import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {basename} from 'node:path'
import ExcelJS from 'exceljs'

export const CAMPAIGN_PREFILL_SHEET = 'BASE GLOBALE'
export const CAMPAIGN_PREFILL_HEADERS = Object.freeze([
  'N° point de prélevement AEAG', 'N°point de prélèvement OUGC', 'Code SIRET du préleveur',
  'VOLUMES AUTORISES ETIAGE 2026', 'Débit en m3/h - ÉTÉ 2026', 'Surface en ha - ÉTÉ 2026',
  'volumes autorisés HIVER 2026-27', 'somme surface HE 2026', 'débit HE 2026',
  'm³/h hiver - irrigation 2026', 'ha hiver - irrigation 2026', 'm³ hiver - irrigation 2026',
  'm³/h hiver - remplissage 2026', 'm³ hiver - remplissage 2026',
  'm³/h hiver - antigel 2026', 'Ha hiver - antigel 2026', 'm³ hiver - antigel 2026',
  'N°Comptage OUGC', 'N° Comptage AEAG', 'N°de serie', '% de répartition compteur',
  'INDEX 31/10/25', 'Usage étiage', 'Usage hors étiage 1', 'Usage hors étiage 2'
])

const MAX_ROWS = 10_000
const MAX_BYTES = 20 * 1024 * 1024
const clean = value => String(value ?? '').trim()
const normalized = value => clean(value).normalize('NFD').replaceAll(/[\u0300-\u036f]/g, '').toLowerCase().replaceAll(/\s+/g, ' ')
const columnName = index => String.fromCharCode(65 + index)
const nullable = value => clean(value) || null
const USAGE_CODES = new Map([
  ['irrigation', '2'], ['lutte antigel', '2E'], ['lutte anti-gel', '2E'],
  ['remplissage retenue', '12E']
])

// Source precision is retained until a proposed field is rounded, including sums.
// Campaign decimals are strings: a JS Number cannot preserve 12+4 significant digits.
function decimal(value) {
  if (!['string', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) return null
  const text = clean(value)
  if (text.length > 80) return null
  const match = /^([+-]?)([0-9]+)(?:[.,]([0-9]+))?(?:[eE]([+-]?[0-9]{1,2}))?$/.exec(text)
  if (!match) return null
  const exponent = Number(match[4] ?? 0)
  if (Math.abs(exponent) > 30) return null
  let coefficient = BigInt(`${match[1]}${match[2]}${match[3] ?? ''}`)
  let scale = (match[3]?.length ?? 0) - exponent
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale)
    scale = 0
  }
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n
    scale--
  }
  return {coefficient, scale}
}

function decimalText({coefficient, scale}) {
  const sign = coefficient < 0n ? '-' : ''
  const digits = (coefficient < 0n ? -coefficient : coefficient).toString().padStart(scale + 1, '0')
  if (!scale) return sign + digits
  let fraction = digits.slice(-scale)
  while (fraction.endsWith('0')) fraction = fraction.slice(0, -1)
  return sign + digits.slice(0, -scale) + (fraction ? `.${fraction}` : '')
}

function roundedDecimal(value) {
  if (!value || value.coefficient < 0n) return null
  let coefficient
  if (value.scale > 4) {
    const divisor = 10n ** BigInt(value.scale - 4)
    coefficient = (value.coefficient + divisor / 2n) / divisor
  } else {
    coefficient = value.coefficient * 10n ** BigInt(4 - value.scale)
  }
  if (coefficient > 9999999999999999n) return null
  return decimalText({coefficient, scale: 4})
}

function sumDecimals(values) {
  if (values.some(value => !value || value.coefficient < 0n)) return null
  const scale = Math.max(...values.map(value => value.scale))
  const coefficient = values.reduce((sum, value) => sum + value.coefficient * 10n ** BigInt(scale - value.scale), 0n)
  return {coefficient, scale}
}

function addIssue(record, code, field, columns, details = {}) {
  record.issues.push({code, field, columns, sourceRows: [...record.sourceRows], ...details})
}

function proposeDecimal(record, target, field, value, columns) {
  const parsed = decimal(value)
  const result = roundedDecimal(parsed)
  if (result === null) {
    addIssue(record, clean(value) ? 'INVALID_NUMBER' : 'MISSING_NUMBER', field, columns)
    return
  }
  target[field.split('.').at(-1)] = result
}

function proposeUsage(record, target, value, field, column) {
  const label = normalized(value)
  if (!label || label === 'sans usage') return
  const code = USAGE_CODES.get(label)
  if (code) target.usageCode = code
  else addIssue(record, 'UNKNOWN_USAGE', field, [column])
}

function usableSerial(value) {
  const text = clean(value)
  if (!text || text.length > 100 || /[\r\n/;,–]/.test(text)) return null
  if (/^(?:0+|-+|n\.?d\.?|n\.?c\.?|\?)$/i.test(text)) return null
  if (/compteur|diam|ultrason|linky|equipe|inconnu|aucun|non renseigne|sans objet/.test(normalized(text))) return null
  return text
}

function indexEvidence(value) {
  if (!clean(value)) return null
  const parsed = decimal(value)
  return parsed ? decimalText(parsed) : `text:${clean(value)}`
}

function normalizeRow(values, rowNumber) {
  const serialNumber = usableSerial(values[19])
  const evidence = indexEvidence(values[21])
  const record = {
    sourceRows: [rowNumber], sourceValues: [{rowNumber, values}],
    identity: {
      pointOugc: nullable(values[1]), pointAeag: nullable(values[0]), siret: nullable(values[2]),
      countingOugc: nullable(values[17]), countingAeag: nullable(values[18]), serialNumber
    },
    needs: {season: {}, offSeason: {}}, reading: null, indexEvidence: evidence,
    indexEvidenceValues: evidence === null ? [] : [evidence],
    metadata: {noAuthorizedOffSeasonUsage: normalized(values[23]) === 'sans usage'},
    eligible: true, issues: []
  }
  // Retain each identity/evidence pair even if duplicate rows later disagree on
  // their meter. Aggregating just the evidence values would lose that association.
  record.indexSources = [{identity: {...record.identity}, indexEvidence: evidence, sourceRows: [rowNumber]}]
  for (const [field, column] of [['pointOugc', 'B'], ['siret', 'C'], ['countingOugc', 'R']]) {
    if (!record.identity[field] || (field === 'siret' && !/^[0-9]{14}$/.test(record.identity.siret))) {
      record.eligible = false
      addIssue(record, 'UNRESOLVED_IDENTITY', `identity.${field}`, [column])
    }
  }
  if (!serialNumber) addIssue(record, 'UNUSABLE_SERIAL', 'identity.serialNumber', ['T'])
  const {season, offSeason} = record.needs
  for (const [field, column] of [['volume', 3], ['flow', 4], ['surface', 5]]) {
    proposeDecimal(record, season, `needs.season.${field}`, values[column], [columnName(column)])
  }
  proposeUsage(record, season, values[22], 'needs.season.usageCode', 'W')
  const secondUsage = normalized(values[24])
  if (secondUsage && secondUsage !== 'sans usage') {
    addIssue(record, 'MULTIPLE_WINTER_USAGES', 'needs.offSeason', ['X', 'Y'])
  } else {
    const sum = roundedDecimal(sumDecimals([11, 13, 16].map(column => decimal(values[column]))))
    if (sum === null) addIssue(record, 'INCOMPLETE_WINTER_VOLUME', 'needs.offSeason.volume', ['L', 'N', 'Q'])
    else offSeason.volume = sum
    proposeDecimal(record, offSeason, 'needs.offSeason.flow', values[8], ['I'])
    proposeDecimal(record, offSeason, 'needs.offSeason.surface', values[7], ['H'])
    proposeUsage(record, offSeason, values[23], 'needs.offSeason.usageCode', 'X')
  }
  const index = decimal(values[21])
  const roundedIndex = roundedDecimal(index)
  if (index?.coefficient > 0n && roundedIndex !== null && roundedIndex !== '0') {
    record.reading = {date: '2025-10-31', index: roundedIndex}
  } else {
    addIssue(record, index?.coefficient === 0n ? 'AMBIGUOUS_ZERO_INDEX' : 'INVALID_INDEX', 'reading.index', ['V'])
  }
  return record
}

function rejectSerialConflicts(records) {
  const bySerial = new Map()
  for (const record of records) {
    // A generic label such as "pas de compteur" does not identify a physical meter.
    // Those rows retain indexSources for the later database-allocation check.
    // Zero and negative observations must not disappear before either comparison.
    const serial = record.identity.serialNumber
    if (!serial || record.indexEvidence === null) continue
    const group = bySerial.get(serial) ?? []
    group.push(record)
    bySerial.set(serial, group)
  }
  let conflicts = 0
  for (const group of bySerial.values()) {
    if (new Set(group.map(record => record.indexEvidence)).size < 2) continue
    conflicts++
    const conflictingSourceRows = group.flatMap(record => record.sourceRows)
    for (const record of group) {
      record.reading = null
      addIssue(record, 'CONFLICTING_SERIAL_INDEX', 'reading.index', ['T', 'V'], {conflictingSourceRows})
    }
  }
  return conflicts
}

// Include secondary identifiers and all consumed fields. An authorization total G,
// an unused component flow or U cannot silently change a proposed physical index.
const RELEVANT_COLUMNS = [0, 1, 2, 3, 4, 5, 7, 8, 11, 13, 16, 17, 18, 19, 21, 22, 23, 24]
const rowSignature = record => JSON.stringify(RELEVANT_COLUMNS.map(column => clean(record.sourceValues[0].values[column])))

function mergeDuplicates(records) {
  const groups = new Map()
  for (const record of records) {
    const {pointOugc, siret, countingOugc} = record.identity
    const key = JSON.stringify([pointOugc, siret, countingOugc])
    const group = groups.get(key) ?? []
    group.push(record)
    groups.set(key, group)
  }
  let duplicates = 0
  const merged = []
  for (const group of groups.values()) {
    const record = group[0]
    if (group.length > 1) {
      duplicates++
      const ambiguous = new Set(group.map(rowSignature)).size > 1
      record.sourceRows = group.flatMap(item => item.sourceRows)
      record.sourceValues = group.flatMap(item => item.sourceValues)
      record.indexSources = group.flatMap(item => item.indexSources)
      record.indexEvidenceValues = [...new Set(group.flatMap(item => item.indexEvidenceValues))]
      record.issues = group.flatMap(item => item.issues)
      addIssue(record, ambiguous ? 'CONFLICTING_DUPLICATE' : 'DUPLICATE_ROWS_COLLAPSED', 'sourceRows', [])
      if (ambiguous) {
        record.eligible = false
        record.needs = {season: {}, offSeason: {}}
        record.reading = null
        record.indexEvidence = null
      }
    }
    merged.push(record)
  }
  return {records: merged, duplicateGroups: duplicates}
}

function explicitCell(value, address) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value
  if (typeof value === 'object' && !(value instanceof Date)) {
    if ('formula' in value || 'sharedFormula' in value || 'error' in value) {
      throw new Error(`Formule ou erreur Excel interdite : ${address}. Fournir une valeur explicite.`)
    }
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text).join('')
    if (typeof value.text === 'string') return value.text
  }
  throw new Error(`Type de cellule non pris en charge : ${address}.`)
}

export function parseCampaignPrefillRows(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS) throw new Error('Classeur vide ou trop grand (10 000 lignes maximum).')
  const explicitRows = rows.map((row, index) => {
    if (!Array.isArray(row)) throw new Error(`Ligne invalide : ${index + 1}.`)
    if (row.slice(25).some(value => clean(value))) throw new Error(`Colonne inattendue après Y, ligne ${index + 1}.`)
    return Array.from({length: 25}, (_, column) => explicitCell(row[column], `${columnName(column)}${index + 1}`))
  })
  for (const [column, expected] of CAMPAIGN_PREFILL_HEADERS.entries()) {
    if (normalized(explicitRows[0][column]) !== normalized(expected)) {
      throw new Error(`En-tête inattendu en ${columnName(column)}1 : attendu « ${expected} ».`)
    }
  }
  const sourceRecords = explicitRows.slice(1).flatMap((values, index) => values.some(value => clean(value)) ? [normalizeRow(values, index + 2)] : [])
  if (!sourceRecords.length) throw new Error('Le classeur ne contient aucune ligne de données.')
  const serialConflicts = rejectSerialConflicts(sourceRecords)
  const {records, duplicateGroups} = mergeDuplicates(sourceRecords)
  const issues = records.flatMap(record => record.issues)
  return {
    records, issues,
    summary: {
      sourceRows: sourceRecords.length, records: records.length, eligibleRecords: records.filter(record => record.eligible).length,
      readingCandidates: records.filter(record => record.eligible && record.reading).length,
      duplicateGroups, serialConflicts,
      issuesByCode: issues.reduce((counts, issue) => ({...counts, [issue.code]: (counts[issue.code] ?? 0) + 1}), {})
    }
  }
}

export async function loadCampaignPrefillSource(filePath) {
  const bytes = await readFile(filePath)
  if (bytes.length > MAX_BYTES) throw new Error('Classeur trop volumineux (20 Mo maximum).')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes)
  const sheet = workbook.getWorksheet(CAMPAIGN_PREFILL_SHEET)
  if (!sheet || sheet.rowCount > MAX_ROWS) throw new Error(`Feuille absente ou trop grande : ${CAMPAIGN_PREFILL_SHEET}.`)
  sheet.eachRow(row => row.eachCell((cell, column) => {
    if (column > 25 && clean(cell.value)) throw new Error(`Colonne inattendue après Y, ligne ${row.number}.`)
  }))
  const rows = Array.from({length: sheet.rowCount}, (_, row) => Array.from(
    {length: 25}, (_, column) => sheet.getRow(row + 1).getCell(column + 1).value
  ))
  return {
    ...parseCampaignPrefillRows(rows),
    source: {fileName: basename(filePath), sha256: createHash('sha256').update(bytes).digest('hex'), sheetName: CAMPAIGN_PREFILL_SHEET}
  }
}
