import {pick} from 'lodash-es'
import * as XLSX from 'xlsx'

import {readSheet, readAsString, readAsDateString, readAsNumber} from '../xlsx.js'
import {validateNumericValue} from '../validate.js'
import {dedupe} from '../dedupe.js'

// Mapping des colonnes Aquasys vers les champs utilisés pour l'extraction.
// L'export Aquasys mélange métadonnées (points/préleveurs) et mesures (index/volumes).
const COLUMN_DEFS = [
  {key: 'pointId', matchers: ['point_de_prelevement', 'point_de_prélèvement']},
  {key: 'siret', matchers: ['siret']},
  {key: 'raisonSociale', matchers: ['denomination_usager', 'dénomination_usager', 'raison_sociale']},
  {key: 'typePrelevement', matchers: ['type_de_prelevement', 'type_de_prélèvement']},
  {key: 'naturePrelevement', matchers: ['nature_du_prelevement', 'nature_du_prélèvement']},
  {key: 'codeCommune', matchers: ['code_insee_commune', 'code_insee']},
  {key: 'compteur', matchers: ['compteur']},
  {key: 'coefficientLecture', matchers: ['coefficient_de_lecture', 'coefficient_lecture']},
  {key: 'indexOuVolume', matchers: ['index_ou_volume']},
  {key: 'dateMesure', matchers: ['date_de_mesure']},
  {key: 'dateFin', matchers: ['date_de_fin']},
  {key: 'mesure', matchers: ['mesure']}
]

// Colonnes minimales nécessaires pour interpréter la donnée (index/volume).
const REQUIRED_HEADERS = ['point_de_prelevement', 'date_de_mesure', 'mesure']

export async function extractAquasys(buffer) {
  let workbook
  try {
    workbook = await readSheet(buffer)
  } catch (error) {
    return {
      errors: [formatError(error)],
      data: {series: [], metadata: {pointsPrelevement: [], preleveurs: []}}
    }
  }

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    return {
      errors: [{message: 'Le fichier Aquasys est vide ou ne contient pas de feuille.', severity: 'error'}],
      data: {series: [], metadata: {pointsPrelevement: [], preleveurs: []}}
    }
  }

  const sheetName = workbook.SheetNames.find(name => normalizeHeader(name) === 'export') || workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]
  const errors = []

  if (!sheet || !sheet['!ref']) {
    return {
      errors: [{message: `La feuille "${sheetName}" est vide.`, severity: 'error'}],
      data: {series: [], metadata: {pointsPrelevement: [], preleveurs: []}}
    }
  }

  const range = XLSX.utils.decode_range(sheet['!ref'])
  const headerRow = findHeaderRow(sheet, range, REQUIRED_HEADERS, errors, sheetName)
  if (headerRow === -1) {
    return {
      errors: errors.map(formatError),
      data: {series: [], metadata: {pointsPrelevement: [], preleveurs: []}}
    }
  }

  const columnMap = mapColumns(sheet, headerRow, range)
  if (columnMap.pointId === undefined || columnMap.dateMesure === undefined || columnMap.mesure === undefined) {
    errors.push({
      message: 'Colonnes requises manquantes dans le fichier Aquasys (point de prélèvement, date de mesure, mesure).',
      severity: 'error'
    })
    return {
      errors: errors.map(formatError),
      data: {series: [], metadata: {pointsPrelevement: [], preleveurs: []}}
    }
  }

  // Aquasys fournit des "index" de compteurs et parfois des "volumes".
  // On conserve à la fois :
  // - des séries de volumes (compatibles avec le reste du système)
  // - des séries d'index (indispensables pour recalculer un volume en
  //   différence avec un index déjà présent en base).
  const {rawRows, metadata} = extractRows(sheet, headerRow, range, columnMap, errors)
  const {volumeRows, indexRows} = buildVolumeRows(rawRows, errors)
  const consolidated = consolidateData(volumeRows, indexRows)
  consolidated.metadata = metadata

  const result = {
    rawData: {
      volumeData: {rows: volumeRows},
      indexData: {rows: indexRows},
      metadata
    },
    data: consolidated,
    errors: [...errors, ...(consolidated.warnings || [])].map(formatError)
  }

  return dedupe(result)
}

function normalizeHeader(value) {
  return stripDiacritics(String(value ?? ''))
    .toLowerCase()
    .trim()
    .replaceAll(/\s+/g, '_')
    .replaceAll(/_+/g, '_')
}

function stripDiacritics(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036F]/g, '')
}

function findHeaderRow(sheet, range, requiredHeaders, errors, sheetLabel) {
  for (let r = 0; r <= Math.min(10, range.e.r); r++) {
    const rowValues = []
    for (let c = 0; c <= range.e.c; c++) {
      const cellValue = readAsString(sheet, r, c) || ''
      rowValues.push(normalizeHeader(cellValue))
    }

    const hasAll = requiredHeaders.every(header =>
      rowValues.some(value => value === header || value.includes(header))
    )

    if (hasAll) {
      return r
    }
  }

  errors.push({
    message: `Impossible de trouver la ligne d'en-tête dans le fichier "${sheetLabel}".`,
    severity: 'error'
  })

  return -1
}

function mapColumns(sheet, headerRow, range) {
  const columnMap = {}
  for (let c = 0; c <= range.e.c; c++) {
    const headerValue = readAsString(sheet, headerRow, c) || ''
    const normalized = normalizeHeader(headerValue)
    for (const def of COLUMN_DEFS) {
      if (columnMap[def.key] !== undefined) {
        continue
      }

      if (def.matchers.some(matcher => normalized === matcher || normalized.includes(matcher))) {
        columnMap[def.key] = c
      }
    }
  }

  return columnMap
}

// Extraction des lignes brutes :
// - métadonnées points/préleveurs
// - mesures (index/volume) avec date de mesure
function extractRows(sheet, headerRow, range, columnMap, errors) {
  const rawRows = []
  const pointsById = new Map()
  const preleveursBySiret = new Map()

  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const pointId = readAsString(sheet, r, columnMap.pointId)
    const dateMesure = readDateSafe(sheet, r, columnMap.dateMesure, errors)
    const mesure = readNumberSafe(sheet, r, columnMap.mesure, errors)

    if (!pointId && !dateMesure && mesure === undefined) {
      continue
    }

    if (!pointId) {
      errors.push({
        message: `Ligne ${r + 1}: Point de prélèvement manquant.`,
        severity: 'error'
      })
      continue
    }

    const normalizedPointId = String(pointId).trim()
    if (!normalizedPointId) {
      continue
    }

    const siret = normalizeSiret(readStringSafe(sheet, r, columnMap.siret))
    const raisonSociale = readStringSafe(sheet, r, columnMap.raisonSociale)
    const typePrelevement = readStringSafe(sheet, r, columnMap.typePrelevement)
    const naturePrelevement = readStringSafe(sheet, r, columnMap.naturePrelevement)
    const codeCommune = normalizeCodeCommune(readStringSafe(sheet, r, columnMap.codeCommune))
    const compteur = readStringSafe(sheet, r, columnMap.compteur)
    const coefficientLecture = readNumberSafe(sheet, r, columnMap.coefficientLecture, errors)
    const indexOuVolume = readStringSafe(sheet, r, columnMap.indexOuVolume)
    const dateFin = readDateSafe(sheet, r, columnMap.dateFin, errors)

    let pointEntry = pointsById.get(normalizedPointId)
    if (!pointEntry) {
      pointEntry = {
        point: {id_point_de_prelevement_ou_rejet: normalizedPointId},
        compteurs: new Set(),
        coefficients: new Set()
      }
      pointsById.set(normalizedPointId, pointEntry)
    }

    if (siret) {
      pointEntry.point.siret = siret
      if (!preleveursBySiret.has(siret)) {
        preleveursBySiret.set(siret, {
          siret,
          ...(raisonSociale ? {raison_sociale: String(raisonSociale).trim()} : {})
        })
      }
    }

    if (typePrelevement) {
      pointEntry.point.type_point_prelevement_ou_rejet = String(typePrelevement).trim()
    }

    if (naturePrelevement) {
      pointEntry.point.nature_prelevement_ou_rejet = String(naturePrelevement).trim()
    }

    if (codeCommune) {
      pointEntry.point.code_INSEE = codeCommune
    }

    if (compteur) {
      pointEntry.compteurs.add(String(compteur).trim())
    }

    if (coefficientLecture !== undefined && coefficientLecture !== null && !Number.isNaN(coefficientLecture)) {
      pointEntry.coefficients.add(coefficientLecture)
    }

    rawRows.push({
      pointId: normalizedPointId,
      compteur: compteur ? String(compteur).trim() : undefined,
      indexOuVolume: indexOuVolume ? String(indexOuVolume).trim().toLowerCase() : undefined,
      dateMesure,
      dateFin,
      mesure,
      coefficientLecture
    })
  }

  const pointsPrelevement = []
  for (const entry of pointsById.values()) {
    const point = {...entry.point}
    if (entry.compteurs.size === 1) {
      point.id_compteur = [...entry.compteurs][0]
    }

    if (entry.coefficients.size === 1) {
      point.coefficient_de_lecture = [...entry.coefficients][0]
    }

    pointsPrelevement.push(point)
  }

  return {
    rawRows,
    metadata: {
      pointsPrelevement,
      preleveurs: [...preleveursBySiret.values()]
    }
  }
}

function readDateSafe(sheet, rowIndex, colIndex, errors) {
  if (colIndex === undefined) {
    return
  }

  try {
    return readAsDateString(sheet, rowIndex, colIndex)
  } catch (error) {
    errors.push({
      message: `Ligne ${rowIndex + 1}: ${error.message}`,
      severity: 'error'
    })
  }
}

function readStringSafe(sheet, rowIndex, colIndex) {
  if (colIndex === undefined) {
    return
  }

  return readAsString(sheet, rowIndex, colIndex)
}

function readNumberSafe(sheet, rowIndex, colIndex, errors) {
  if (colIndex === undefined) {
    return
  }

  const number = readAsNumber(sheet, rowIndex, colIndex)
  if (number !== undefined) {
    return number
  }

  const raw = readAsString(sheet, rowIndex, colIndex)
  if (raw) {
    errors.push({
      message: `Ligne ${rowIndex + 1}: Valeur numérique invalide: ${raw}`,
      severity: 'error'
    })
  }
}

function normalizeSiret(value) {
  if (!value) {
    return
  }

  const cleaned = String(value).trim().replaceAll(/\s+/g, '').replace(/\.0$/, '')
  return cleaned.length === 14 ? cleaned : undefined
}

function normalizeCodeCommune(value) {
  if (!value) {
    return
  }

  return String(value).replace(/\.0$/, '').trim().padStart(5, '0')
}

// Normalise les mesures Aquasys :
// - si "Index", on stocke l'index et on calcule ensuite les volumes par différence
// - si "Volume", on garde le volume tel quel
// Les index sont "ramenés" en m³ via le coefficient de lecture (mesure * coefficient).
function buildVolumeRows(rawRows, errors) {
  const indexRows = []
  const volumeRows = []

  for (const row of rawRows) {
    if (!row.pointId || !row.dateMesure || row.mesure === undefined || row.mesure === null) {
      continue
    }

    const mesureValue = safeNumericValue(row.mesure, errors, row.pointId, row.dateMesure)
    if (mesureValue === undefined || mesureValue === null) {
      continue
    }

    if (row.indexOuVolume && row.indexOuVolume.startsWith('volume')) {
      volumeRows.push({
        pointId: row.pointId,
        dateDebut: row.dateMesure,
        dateFin: row.dateFin || row.dateMesure,
        volumePreleve: mesureValue
      })
    } else {
      const coefficient = row.coefficientLecture ?? 1
      indexRows.push({
        pointId: row.pointId,
        compteur: row.compteur || 'default',
        dateMesure: row.dateMesure,
        mesure: mesureValue,
        coefficient,
        scaledMesure: mesureValue * coefficient
      })
    }
  }

  // Les volumes calculés par différence d'index s'ajoutent aux volumes directs.
  const computedRows = computeVolumesFromIndex(indexRows)
  return {
    volumeRows: [...computedRows, ...volumeRows].filter(row => row.dateDebut && row.dateFin),
    indexRows
  }
}

function safeNumericValue(value, errors) {
  try {
    return validateNumericValue(value)
  } catch (error) {
    errors.push({
      message: error.message || `Valeur numérique invalide: ${value}`,
      explanation: error.explanation,
      severity: 'error'
    })
  }
}

// Calcul des volumes à partir d'index successifs par point+compteur.
// - cas normal : (index courant - index précédent) * coefficient
// - remise à zéro : index courant * coefficient
function computeVolumesFromIndex(indexRows) {
  const byKey = new Map()
  for (const row of indexRows) {
    const key = `${row.pointId}__${row.compteur || 'default'}`
    if (!byKey.has(key)) {
      byKey.set(key, [])
    }

    byKey.get(key).push(row)
  }

  const computed = []
  for (const rows of byKey.values()) {
    rows.sort((a, b) => a.dateMesure.localeCompare(b.dateMesure))
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1]
      const curr = rows[i]
      const diff = curr.mesure - prev.mesure
      const coefficient = Number.isFinite(curr.coefficient) ? curr.coefficient : 1
      const volume = diff >= 0 ? diff * coefficient : curr.mesure * coefficient
      if (volume === null || volume === undefined || Number.isNaN(volume)) {
        continue
      }

      computed.push({
        pointId: curr.pointId,
        dateDebut: prev.dateMesure,
        dateFin: curr.dateMesure,
        volumePreleve: volume
      })
    }
  }

  return computed
}

// Consolide en séries temporelles :
// - Volume prélevé (m³) pour l'intégration standard
// - Index compteur (m³ après coefficient) pour recaler avec l'historique en base
function consolidateData(volumeRows, indexRows) {
  const series = []
  const warnings = []

  if (Array.isArray(volumeRows) && volumeRows.length > 0) {
    const rowsByPoint = new Map()
    for (const row of volumeRows) {
      if (!row.pointId) {
        continue
      }

      if (!rowsByPoint.has(row.pointId)) {
        rowsByPoint.set(row.pointId, [])
      }

      rowsByPoint.get(row.pointId).push(row)
    }

    for (const [pointId, rows] of rowsByPoint.entries()) {
      const byDate = new Map()
      const durations = []
      let minDate = null
      let maxDate = null

      for (const row of rows) {
        if (!row.dateFin || row.volumePreleve === undefined || row.volumePreleve === null) {
          continue
        }

        if (row.dateDebut && row.dateFin) {
          const duration = diffInDays(row.dateDebut, row.dateFin)
          if (Number.isFinite(duration) && duration >= 0) {
            durations.push(duration)
          }
        }

        if (!minDate || row.dateDebut < minDate) {
          minDate = row.dateDebut
        }

        if (!maxDate || row.dateFin > maxDate) {
          maxDate = row.dateFin
        }

        byDate.set(row.dateFin, (byDate.get(row.dateFin) || 0) + row.volumePreleve)
      }

      const dataEntries = [...byDate.entries()]
        .map(([date, value]) => ({date, value}))
        .sort((a, b) => a.date.localeCompare(b.date))

      if (dataEntries.length === 0) {
        continue
      }

      series.push({
        pointPrelevement: pointId,
        parameter: 'volume prélevé',
        unit: 'm³',
        frequency: inferFrequency(durations),
        valueType: 'cumulative',
        minDate,
        maxDate,
        data: dataEntries
      })
    }
  }

  const {series: indexSeries, warnings: indexWarnings} = consolidateIndexSeries(indexRows)
  series.push(...indexSeries)
  warnings.push(...indexWarnings)

  return {series, warnings}
}

// Regroupe les index par point+compteur pour créer une série d'index.
// Ces séries permettent de recalculer les volumes sur des périodes
// où l'index de départ est déjà connu en base.
function consolidateIndexSeries(indexRows) {
  if (!Array.isArray(indexRows) || indexRows.length === 0) {
    return {series: [], warnings: []}
  }

  const rowsByKey = new Map()
  for (const row of indexRows) {
    if (!row.pointId || !row.dateMesure) {
      continue
    }

    const compteur = row.compteur || 'default'
    const key = `${row.pointId}__${compteur}`
    if (!rowsByKey.has(key)) {
      rowsByKey.set(key, [])
    }

    rowsByKey.get(key).push(row)
  }

  const series = []
  const warnings = []
  for (const [key, rows] of rowsByKey.entries()) {
    rows.sort((a, b) => a.dateMesure.localeCompare(b.dateMesure))
    const durations = []
    let minDate = null
    let maxDate = null
    const byDate = new Map()
    const duplicateDates = []

    for (const row of rows) {
      if (row.scaledMesure === undefined || row.scaledMesure === null || Number.isNaN(row.scaledMesure)) {
        continue
      }

      const existing = byDate.get(row.dateMesure)
      if (existing !== undefined && row.scaledMesure !== existing) {
        duplicateDates.push(row.dateMesure)
      }

      if (existing === undefined || row.scaledMesure > existing) {
        byDate.set(row.dateMesure, row.scaledMesure)
      }
    }

    const uniqueDates = [...byDate.keys()].sort()
    for (let i = 1; i < uniqueDates.length; i++) {
      const duration = diffInDays(uniqueDates[i - 1], uniqueDates[i])
      if (Number.isFinite(duration) && duration >= 0) {
        durations.push(duration)
      }
    }

    if (uniqueDates.length > 0) {
      minDate = uniqueDates[0]
      maxDate = uniqueDates.at(-1)
    }

    const dataEntries = uniqueDates.map(date => ({
      date,
      value: byDate.get(date)
    }))

    if (dataEntries.length === 0) {
      continue
    }

    const [pointId, compteur] = key.split('__')
    const parameter = compteur && compteur !== 'default'
      ? `Index compteur ${compteur}`
      : 'Index compteur'

    series.push({
      pointPrelevement: pointId,
      parameter,
      unit: 'm³',
      frequency: inferFrequency(durations),
      valueType: 'cumulative',
      minDate,
      maxDate,
      data: dataEntries
    })

    if (duplicateDates.length > 0) {
      const uniqueDates = [...new Set(duplicateDates)].sort()
      warnings.push({
        message: `Doublons d'index détectés pour ${parameter} (point ${pointId}) aux dates: ${uniqueDates.join(', ')}`,
        severity: 'warning'
      })
    }
  }

  return {series, warnings}
}

function diffInDays(start, end) {
  const startDate = new Date(`${start}T00:00:00Z`)
  const endDate = new Date(`${end}T00:00:00Z`)
  return Math.round((endDate - startDate) / 86_400_000)
}

function inferFrequency(durations) {
  if (!Array.isArray(durations) || durations.length === 0) {
    return '1 day'
  }

  const sorted = [...durations].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]

  if (median >= 330) {
    return '1 year'
  }

  if (median >= 80) {
    return '1 quarter'
  }

  if (median >= 25) {
    return '1 month'
  }

  return '1 day'
}

function formatError(error) {
  const errorObj = pick(error, [
    'message',
    'explanation',
    'internalMessage',
    'severity'
  ])

  errorObj.message ||= errorObj.explanation || errorObj.internalMessage || 'Erreur non spécifiée'

  errorObj.severity ||= 'error'

  return errorObj
}
