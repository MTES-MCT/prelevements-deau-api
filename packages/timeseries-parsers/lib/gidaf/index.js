import {pick} from 'lodash-es'

import {readSheet} from '../xlsx.js'
import {readAsString, readAsDateString, readAsNumber} from '../xlsx.js'
import {validateNumericValue} from '../validate.js'
import {dedupe} from '../dedupe.js'
import * as XLSX from 'xlsx'


export async function extractGidaf(buffer) {
  return {error}
}

function formatError(error) {
  const errorObj = pick(error, [
    'message',
    'explanation',
    'internalMessage',
    'severity'
  ])

  if (!errorObj.message) {
    errorObj.message = errorObj.explanation || errorObj.internalMessage || 'Erreur non spécifiée'
  }

  if (!errorObj.severity) {
    errorObj.severity = 'error'
  }

  return errorObj
}

function findHeaderRow(sheet, range, errors) {
  const headerKeywords = GIDAF_COLUMNS
    .filter(col => col.required)
    .flatMap(col => col.matchers)

  for (let r = 0; r <= Math.min(10, range.e.r); r++) {
    const rowValues = []
    for (let c = 0; c <= range.e.c; c++) {
      const cellValue = readAsString(sheet, r, c) || ''
      rowValues.push(cellValue.toLowerCase())
    }

    const hasKeywords = headerKeywords.some(keyword =>
      rowValues.some(val => val.includes(keyword))
    )

    if (hasKeywords && r > 0) {
      return r
    }
  }

  errors.push({
    message: 'Impossible de trouver la ligne d\'en-tête.',
    severity: 'error'
  })

  return -1
}

function mapColumns(sheet, headerRow, range, errors) {
  const columnMap = {}

  for (let c = 0; c <= range.e.c; c++) {
    const headerValue = readAsString(sheet, headerRow, c) || ''
    const normalized = normalizeColumnName(headerValue)

    for (const colDef of GIDAF_COLUMNS) {
      if (columnMap[colDef.key] !== undefined) {
        continue
      }

      const matches = colDef.matchers.some(matcher =>
        normalized.includes(matcher)
      )

      if (matches) {
        // Vérifier les exclusions
        if (colDef.exclude && colDef.exclude.some(exclude => normalized.includes(exclude))) {
          continue
        }

        columnMap[colDef.key] = c
      }
    }
  }

  // Vérifier les colonnes requises
  const requiredColumns = GIDAF_COLUMNS.filter(col => col.required)
  const missingColumns = requiredColumns.filter(col => columnMap[col.key] === undefined)

  if (missingColumns.length > 0) {
    errors.push({
      message: `Colonnes requises manquantes : ${missingColumns.map(col => col.key).join(', ')}.`,
      severity: 'error'
    })
  }

  return columnMap
}

function parseDynamicSheet(sheet, errors) {
  const range = XLSX.utils.decode_range(sheet['!ref'])
  const rows = []

  // Trouver la ligne d'en-tête
  const headerRow = findHeaderRow(sheet, range, errors)
  if (headerRow === -1) {
    return {rows: []}
  }

  // Mapper les colonnes
  const columnMap = mapColumns(sheet, headerRow, range, errors)
  if (errors.some(e => e.severity === 'error')) {
    return {rows: []}
  }

  // Lire les données
  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const row = extractRow(sheet, r, columnMap, errors)
    if (row) {
      rows.push(row)
    }
  }

  return {rows}
}

function extractRow(sheet, rowIndex, columnMap, errors) {
  // Extraire les valeurs selon les définitions de colonnes
  const values = {}

  for (const colDef of GIDAF_COLUMNS) {
    if (columnMap[colDef.key] === undefined) {
      continue
    }

    let value
    if (colDef.type === 'date') {
      // Pour Gidaf, on lit d'abord comme string pour parser le format mois-année
      value = readAsString(sheet, rowIndex, columnMap[colDef.key])
    } else if (colDef.type === 'number') {
      value = readAsNumber(sheet, rowIndex, columnMap[colDef.key])
      if (value === null || value === undefined || Number.isNaN(value)) {
        continue
      }
    } else {
      value = readAsString(sheet, rowIndex, columnMap[colDef.key])
      if (value) {
        value = String(value).trim()
      }
    }

    values[colDef.key] = value
  }

  // Vérifier les données requises
  if (!values.codeInspection && !values.dateMesure) {
    return null // Ligne vide
  }

  if (!values.codeInspection) {
    errors.push({
      message: `Ligne ${rowIndex + 1}: Code inspection manquant.`,
      severity: 'error'
    })
    return null
  }

  // Parser la date (format "mois-année" comme "juin-25" ou "juin-2025")
  let dateDebut = null
  let dateFin = null

  if (values.dateMesure) {
    const parsedDates = parseMonthYear(values.dateMesure)
    if (parsedDates) {
      dateDebut = parsedDates.start
      dateFin = parsedDates.end
    } else {
      // Essayer de parser comme date normale
      dateDebut = readAsDateString(sheet, rowIndex, columnMap.dateMesure)
      dateFin = dateDebut
    }
  }

  if (!dateDebut) {
    errors.push({
      message: `Ligne ${rowIndex + 1}: Date de mesure manquante ou invalide: ${values.dateMesure}`,
      severity: 'error'
    })
    return null
  }

  if (values.volume === null || values.volume === undefined) {
    return null // Volume manquant
  }

  const validation = validateNumericValue(values.volume, `Ligne ${rowIndex + 1}`)
  if (!validation.valid) {
    errors.push({
      message: validation.message,
      severity: 'error'
    })
    return null
  }

  const typePoint = (values.typePoint || '').toLowerCase()
  const isPrelevement = typePoint.includes('alimentation') ||
                       typePoint.includes('prélèvement') ||
                       typePoint.includes('prelevement')

  return {
    codeInspection: String(values.codeInspection).trim(),
    dateDebut,
    dateFin: dateFin || dateDebut,
    volume: validation.value,
    isPrelevement
  }
}

function parseMonthYear(str) {
  if (!str) return null

  const normalized = str.trim().toLowerCase()
  
  // Formats: "juin-25", "juin-2025", "juin 25", "juin 2025"
  const monthNames = {
    'janvier': 1, 'jan': 1,
    'février': 2, 'fevrier': 2, 'fév': 2, 'fev': 2,
    'mars': 3, 'mar': 3,
    'avril': 4, 'avr': 4,
    'mai': 5,
    'juin': 6, 'jun': 6,
    'juillet': 7, 'jul': 7,
    'août': 8, 'aout': 8, 'aug': 8,
    'septembre': 9, 'sep': 9, 'sept': 9,
    'octobre': 10, 'oct': 10,
    'novembre': 11, 'nov': 11,
    'décembre': 12, 'decembre': 12, 'déc': 12, 'dec': 12
  }

  // Pattern: mois-année ou mois année
  const match = normalized.match(/([a-zéèêà]+)[\s-]+(\d{2,4})/)
  if (!match) return null

  const monthName = match[1]
  const yearStr = match[2]
  const month = monthNames[monthName]

  if (!month) return null

  let year = parseInt(yearStr, 10)
  if (year < 100) {
    year = 2000 + year
  }

  // Calculer le premier et dernier jour du mois
  const firstDay = new Date(year, month - 1, 1)
  const lastDay = new Date(year, month, 0)

  return {
    start: firstDay.toISOString().slice(0, 10),
    end: lastDay.toISOString().slice(0, 10)
  }
}

function consolidateData(parsedData, errors) {
  const seriesMap = new Map()

  for (const row of parsedData.rows) {
    const pointId = row.codeInspection
    const serieKey = `${pointId}_${row.isPrelevement ? 'prelevement' : 'rejet'}`
    
    if (!seriesMap.has(serieKey)) {
      seriesMap.set(serieKey, {
        pointPrelevement: pointId,
        parameter: row.isPrelevement ? 'Volume prélevé' : 'Volume rejeté',
        unit: 'm³',
        frequency: '1 month',
        valueType: 'cumulative',
        data: [],
        minDate: null,
        maxDate: null
      })
    }

    const serie = seriesMap.get(serieKey)
    
    // Pour les volumes mensuels, on crée une entrée par jour du mois
    const startDate = new Date(row.dateDebut)
    const endDate = new Date(row.dateFin)
    const daysDiff = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1
    
    if (daysDiff > 0 && daysDiff <= 31) {
      const dailyVolume = row.volume / daysDiff
      const currentDate = new Date(startDate)
      
      for (let i = 0; i < daysDiff; i++) {
        const dateStr = currentDate.toISOString().slice(0, 10)
        serie.data.push({
          date: dateStr,
          value: dailyVolume
        })
        
        if (!serie.minDate || dateStr < serie.minDate) {
          serie.minDate = dateStr
        }
        if (!serie.maxDate || dateStr > serie.maxDate) {
          serie.maxDate = dateStr
        }
        
        currentDate.setDate(currentDate.getDate() + 1)
      }
    } else {
      // Si la période est invalide, on utilise juste la date de début
      serie.data.push({
        date: row.dateDebut,
        value: row.volume
      })
      
      if (!serie.minDate || row.dateDebut < serie.minDate) {
        serie.minDate = row.dateDebut
      }
      if (!serie.maxDate || row.dateDebut > serie.maxDate) {
        serie.maxDate = row.dateDebut
      }
    }
  }

  // Trier les données par date pour chaque série
  for (const serie of seriesMap.values()) {
    serie.data.sort((a, b) => a.date.localeCompare(b.date))
  }

  return {
    series: Array.from(seriesMap.values())
  }
}

