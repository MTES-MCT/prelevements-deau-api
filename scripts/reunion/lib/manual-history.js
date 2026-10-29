import {createHash} from 'node:crypto'

const field = (items, id) => items?.find(item => (item.champDescriptorId ?? item.id) === Buffer.from(`Champ-${id}`).toString('base64'))
const value = item => item?.stringValue ?? item?.date
const pointId = text => /^\s*\d+(?:\s|$)/.test(String(text ?? '')) ? Number(String(text).trim().match(/^\d+/)[0]) : null
const seriesKey = value => createHash('sha256').update(value).digest('hex')
const MONTHS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre']
const checked = item => typeof item?.checked === 'boolean' ? item.checked : ({true: true, false: false})[value(item)]

// Only structured answers establish a dossier-wide absence. A comment is
// evidence for a human review, never a reason to silently discard measurements.
export function withdrawalDeclaration(rawDossier) {
  const champs = rawDossier?.champs
  const global = [4152855, 4324950].map(id => ({field: id, checked: checked(field(champs, id))})).filter(item => item.checked !== undefined)
  const rows = field(champs, 3642783)?.rows ?? []
  const points = rows.map(row => ({rowId: row.id, point: value(field(row.champs, 4017191)), field: 4465807, checked: checked(field(row.champs, 4465807))}))
  const evidence = [...global, ...points]
  const hasTrue = evidence.some(item => item.checked === true)
  const globalFalse = global.some(item => item.checked === false)
  const conflict = (globalFalse && hasTrue) || global.some(item => item.checked === true) && points.length > 0 && points.every(item => item.checked === false)
  const declaredWithdrawal = conflict ? null : hasTrue ? true : globalFalse || points.length > 0 && points.every(item => item.checked === false) ? false : null
  return {declaredWithdrawal, conflict, evidence, comment: value(field(champs, 3645094)) ?? ''}
}

function declaredAggregatePeriod(rawDossier) {
  const champs = rawDossier?.champs
  if (checked(field(champs, 3888495)) !== false) return null
  const multiple = checked(field(champs, 4460662))
  const startRaw = value(field(champs, multiple === true ? 4460669 : 4460664))
  const endRaw = multiple === true ? value(field(champs, 4460678)) : startRaw
  if (multiple === undefined) return null
  const startParts = /^(0[1-9]|1[0-2])\/(20\d{2})$/.exec(startRaw ?? '')
  const endParts = /^(0[1-9]|1[0-2])\/(20\d{2})$/.exec(endRaw ?? '')
  if (!startParts || !endParts) return null
  const start = localDate(`${startParts[2]}-${startParts[1]}-01`)
  const last = new Date(Date.UTC(Number(endParts[2]), Number(endParts[1]), 1))
  const end = new Date(+last - 4 * 3600000).toISOString()
  if (!start || start >= end) return null
  const months = (Number(endParts[2]) - Number(startParts[2])) * 12 + Number(endParts[1]) - Number(startParts[1]) + 1
  return {start, end, frequency: months === 1 ? '1 month' : months === 12 && startParts[1] === '01' ? '1 year' : 'irregular',
    evidence: {preciseDatesKnown: false, multipleMonths: multiple, startMonth: startRaw, endMonth: endRaw}}
}

function reviewedRow(row, index, review) {
  const correction = review?.rows?.find(item => item.row === index + 1)
  if (!correction) return {row}
  if (!/^[a-f\d]{64}$/.test(review.sha256 ?? '') || !correction.reason || !correction.before || !correction.after
    || Object.entries(correction.before).some(([key, expected]) => (row[key] ?? null) !== expected)
    || !['pointPrelevement', 'volumePompeM3', 'datePrelevement', 'anneePrelevement'].every(key => Object.hasOwn(correction.before, key))
    || Object.keys(correction.after).some(key => !['datePrelevement', 'anneePrelevement'].includes(key))) {
    throw new Error('Correction de période revue invalide ou source modifiée')
  }
  return {row: {...row, ...correction.after}, correction: {...correction, reviewSha256: review.sha256}}
}

function manualPeriod(row, kind, aggregatePeriod) {
  const date = localDate(kind === 'index' ? row.date : row.datePrelevement)
  if (kind === 'index') return {start: date, end: date, frequency: 'instant'}
  if (date) return {start: date, end: new Date(+new Date(date) + 86400000).toISOString(), frequency: '1 day'}
  if (!row.datePrelevement && /^20\d{2}$/.test(String(row.anneePrelevement ?? ''))) {
    const year = Number(row.anneePrelevement)
    return {start: localDate(`${year}-01-01`), end: localDate(`${year + 1}-01-01`), frequency: '1 year'}
  }
  if (!row.datePrelevement && !row.anneePrelevement && aggregatePeriod) return aggregatePeriod
  return {start: null, end: null, frequency: '1 day'}
}

export function localDate(value) {
  const text = String(value ?? '').trim().normalize('NFD').replaceAll(/\p{M}/gu, '').toLowerCase()
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  let year, month, day
  if (match) [, year, month, day] = match
  else {
    match = text.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/)
    if (match) { day = match[1]; month = MONTHS.indexOf(match[2]) + 1; year = match[3] }
    else {
      match = text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/)
      if (match) { day = match[1]; month = match[2]; year = match[3] }
    }
  }
  year = Number(year); month = Number(month); day = Number(day)
  if (year < 1900 || year > 2100 || !month || !day) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return new Date(+date - 4 * 3600000).toISOString()
}

function exactValue(raw) {
  const normalized = String(raw ?? '').trim().replaceAll(/[\s\u00a0\u202f]/g, '').replace(',', '.')
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) return null
  return normalized
}

export function extractManualHistory({dossier, rawDossier, review}) {
  const number = dossier.ds?.dossierNumber ?? rawDossier?.number
  const rawIndexRows = field(rawDossier?.champs, 3888549)?.rows
  const indices = rawIndexRows ? rawIndexRows.map(row => ({date: value(field(row.champs, 3888598)),
    valeur: value(field(row.champs, 3888599)), rowId: row.id})) : dossier.relevesIndex ?? []
  const rawVolumeRows = field(rawDossier?.champs, 3888490)?.rows
  const volumes = rawVolumeRows ? rawVolumeRows.map(row => ({pointPrelevement: pointId(value(field(row.champs, 3888497))),
    datePrelevement: value(field(row.champs, 3888496)), anneePrelevement: value(field(row.champs, 3888520)),
    volumePompeM3: value(field(row.champs, 3888512)), rowId: row.id})) : dossier.volumesPompes ?? []
  const point = pointId(value(field(rawDossier?.champs, 2378771))) ?? dossier.pointPrelevement
  const series = new Map()
  const errors = []
  const aggregatePeriod = declaredAggregatePeriod(rawDossier)
  const meter = dossier.compteur ?? null
  if (review?.rows && (new Set(review.rows.map(item => item.row)).size !== review.rows.length
    || review.rows.some(item => !Number.isSafeInteger(item.row) || item.row < 1 || item.row > volumes.length))) throw new Error('Ligne de correction revue absente ou dupliquée')
  const consume = (rawRow, index, kind) => {
    const {row, correction} = kind === 'volume' ? reviewedRow(rawRow, index, review) : {row: rawRow}
    const reference = kind === 'index' ? point : row.pointPrelevement
    const raw = kind === 'index' ? row.valeur : row.volumePompeM3
    const decimal = exactValue(raw)
    const {start, end, frequency, evidence} = manualPeriod(row, kind, aggregatePeriod)
    const key = seriesKey(`DN:80149:${number}:${kind}:${reference}:${frequency}`)
    if (!start || !end || decimal === null) {
      errors.push({code: !start || !end ? 'MANUAL_PERIOD_INVALID' : 'MANUAL_VALUE_INVALID',
        severity: 'error', filename: 'Saisie du dossier DN', row: index + 1, seriesKey: key,
        message: !start || !end ? 'Date ou période de saisie à préciser' : 'Valeur saisie invalide', rawValue: raw == null ? null : String(raw), rawRow: row})
      return
    }
    if (!Number.isSafeInteger(reference) && !series.has(key)) errors.push({code: 'MANUAL_POINT_MISSING', severity: 'warning',
      filename: 'Saisie du dossier DN', seriesKey: key, message: 'Point de la saisie à associer'})
    if (!series.has(key)) series.set(key, {nativeTemporal: true, seriesKey: key, pointPrelevement: Number.isSafeInteger(reference) ? `reunion:DEP-974:point:${reference}` : '',
      parameter: kind === 'index' ? 'relevé d’index de compteur' : 'volume prélevé', unit: 'm³', frequency,
      valueType: kind === 'index' ? 'instantaneous' : 'cumulative', autoCalculateVolumes: false,
      metadata: {timezone: 'Indian/Reunion', parser: 'dn-manual', parserVersion: 2,
        sourceFile: 'Saisie du dossier DN', meter}, data: []})
    series.get(key).data.push({date: start, periodStart: start, periodEnd: end, value: decimal,
      metadata: {row: index + 1, cell: `DN:${kind}:${index + 1}`, rawValue: String(raw), rawRow,
        ...(correction && {reviewedCorrection: correction}),
        ...(evidence && {periodEvidence: evidence})}})
  }
  indices.forEach((row, index) => consume(row, index, 'index'))
  volumes.forEach((row, index) => consume(row, index, 'volume'))
  return {series: [...series.values()], errors, counts: {indices: indices.length, volumes: volumes.length}}
}

export function historicalType(dossier, rawDossier) {
  const label = value(field(rawDossier?.champs, 3888472))
  const type = label ? ({'Prélèvement par camion citerne': 'camion-citerne', 'Prélèvement AEP ou en ZRE': 'aep-zre',
    'Prélèvement ICPE hors ZRE': 'icpe-hors-zre', 'Autre prélèvement (agricole, domestique...)': 'autre'})[label] : dossier.typePrelevement
  return type === 'camion-citerne' ? 'reunion_camion_citerne' : 'reunion_multi_param'
}
