import {createHash} from 'node:crypto'

const field = (items, id) => items?.find(item => (item.champDescriptorId ?? item.id) === Buffer.from(`Champ-${id}`).toString('base64'))
const value = item => item?.stringValue ?? item?.date
const pointId = text => /^\s*\d+(?:\s|$)/.test(String(text ?? '')) ? Number(String(text).trim().match(/^\d+/)[0]) : null
const seriesKey = value => createHash('sha256').update(value).digest('hex')
const MONTHS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre']

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

export function extractManualHistory({dossier, rawDossier}) {
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
  const consume = (row, index, kind) => {
    const reference = kind === 'index' ? point : row.pointPrelevement
    const raw = kind === 'index' ? row.valeur : row.volumePompeM3
    const decimal = exactValue(raw)
    const date = localDate(kind === 'index' ? row.date : row.datePrelevement)
    let start = date, end = date, frequency = 'instant'
    if (kind === 'volume') {
      frequency = '1 day'
      if (date) end = new Date(+new Date(date) + 86400000).toISOString()
      else if (!row.datePrelevement && /^20\d{2}$/.test(String(row.anneePrelevement ?? ''))) {
        const year = Number(row.anneePrelevement)
        start = localDate(`${year}-01-01`); end = localDate(`${year + 1}-01-01`); frequency = '1 year'
      }
    }
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
      metadata: {timezone: 'Indian/Reunion', parser: 'dn-manual', parserVersion: 1,
        sourceFile: 'Saisie du dossier DN', meter: dossier.compteur ?? null}, data: []})
    series.get(key).data.push({date: start, periodStart: start, periodEnd: end, value: decimal,
      metadata: {row: index + 1, cell: `DN:${kind}:${index + 1}`, rawValue: String(raw), rawRow: row}})
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
