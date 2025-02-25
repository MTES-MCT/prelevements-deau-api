import * as XLSX from 'xlsx'

import {
  getCellValue,
  readAsDateString,
  readAsTimeString
} from '../../xlsx.js'

import {validateDateInPeriod, validateNumericValue} from '../../validate.js'
import {ErrorCollector} from '../error-collector.js'

export function validateAndExtract(dataSheet, {startDate, endDate}) {
  const data = {}
  const errors = []
  const result = {errors, data}

  data.period = extractPeriod(dataSheet.name)

  const {errors: structureErrors} = validateStructure(dataSheet, {startDate, endDate})

  if (structureErrors.length > 0) {
    errors.push(...structureErrors)
    return result
  }

  data.hasData = checkIfSheetHasData(dataSheet.sheet)

  if (!data.hasData) {
    return result
  }

  const errorCollector = new ErrorCollector()

  // Valider les lignes de données et récupérer les colonnes de paramètres utilisées
  const {dataRows, usedParameterColumns} = getDataRows(dataSheet, {errorCollector})

  // Valider les champs de métadonnées pour les colonnes de paramètres utilisées
  validateMetadataFields(dataSheet, usedParameterColumns, {errorCollector})

  // Valider que le champ 'frequence' n'a pas été modifié (Test T0003.6)
  validateFrequenceField(dataSheet, usedParameterColumns, {errorCollector})

  // Pour chaque paramètre utilisé, valider les entrées de données
  for (const paramIndex of usedParameterColumns) {
    const paramName = getCellValue(dataSheet.sheet, 1, paramIndex) || `Paramètre ${paramIndex - 1}`
    const frequence = getCellValue(dataSheet.sheet, 3, paramIndex)

    if (!frequence) {
      errorCollector.addSingleError({
        message: `Fréquence non renseignée pour le paramètre ${paramName}`
      })
    }

    // Valider les entrées de données pour ce paramètre
    const isHeureMandatory = isFrequencyLessThanOneDay(frequence)
    validateParameterData(dataRows, {startDate, endDate, paramIndex, paramName, isHeureMandatory, errorCollector})
    validateTimeStepConsistency(dataRows, {frequence, paramName, errorCollector})
  }

  errors.push(...errorCollector.getErrors())

  return result
}

const NORMALIZED_PERIODS = {
  '15 min': '15 minutes',
  '15mn': '15 minutes',
  '15m': '15 minutes',
  '1jour': '1 jour',
  jour: '1 jour',
  trimestre: '1 trimestre',
  autres: 'autre'
}

function extractPeriod(sheetName) {
  const match = sheetName.match(/^data\s\|\s*t\s*=([a-z\d\s]+)$/i)

  if (!match) {
    return
  }

  const period = match[1].trim().toLowerCase()
  return NORMALIZED_PERIODS[period] || period
}

function validateStructure(dataSheet) {
  const errors = []

  const expectedDataHeaders = ['date', 'heure']
  const startingColIndex = 0 // Colonne A

  // Vérifier les en-têtes 'date' et 'heure'
  for (const [offset, expectedHeader] of expectedDataHeaders.entries()) {
    const cellValue = getCellValue(dataSheet.sheet, 11, startingColIndex + offset) // Les en-têtes sont à la ligne 12 (index 11)
    if (!cellValue || cellValue.toString().trim().toLowerCase() !== expectedHeader.toLowerCase()) {
      errors.push({
        message: `L'intitulé de la colonne ${String.fromCodePoint(65 + startingColIndex + offset)}12 dans l'onglet '${dataSheet.name}' a été modifié. Attendu : '${expectedHeader}', trouvé : '${cellValue}'`
      })
    }
  }

  // Vérifier que les colonnes de valeurs des paramètres ont les en-têtes corrects
  // À partir de la colonne C (index 2) jusqu'à la dernière colonne de paramètre
  let colIndex = 2 // Commence à la colonne C
  let cellValue = getCellValue(dataSheet.sheet, 11, colIndex)
  while (cellValue && cellValue.toString().trim().toLowerCase().startsWith('valeur_parametre')) {
    // Passer à la colonne suivante
    colIndex++
    cellValue = getCellValue(dataSheet.sheet, 11, colIndex)
  }

  // Après les colonnes de paramètres, on s'attend à l'en-tête 'Remarque'
  const remarqueCellValue = getCellValue(dataSheet.sheet, 11, colIndex)
  if (!remarqueCellValue || remarqueCellValue.toString().trim().toLowerCase() !== 'remarque') {
    errors.push({
      message: `L'intitulé de la colonne ${String.fromCodePoint(65 + colIndex)}12 dans l'onglet '${dataSheet.sheetName}' a été modifié. Attendu : 'Remarque', trouvé : '${remarqueCellValue}'`
    })
  }

  return {errors}
}

function validateMetadataFields(dataSheet, usedParameterColumns, {errorCollector}) {
  const {sheet, name: sheetName} = dataSheet

  // Positions des champs de métadonnées :
  // Lignes index 1 à 8 (Lignes 2 à 9)
  const metadataFields = [
    {fieldName: 'nom_parametre', row: 1, mandatory: true},
    {fieldName: 'type', row: 2, mandatory: true},
    {fieldName: 'frequence', row: 3, mandatory: true},
    {fieldName: 'unite', row: 4, mandatory: true},
    {fieldName: 'detail_point_suivi', row: 5, mandatory: false},
    {fieldName: 'profondeur', row: 6, mandatory: false},
    {fieldName: 'date_debut', row: 7, mandatory: false},
    {fieldName: 'date_fin', row: 8, mandatory: false},
    {fieldName: 'remarque', row: 9, mandatory: false}
  ]

  for (const colIndex of usedParameterColumns) {
    const paramName = getCellValue(sheet, 1, colIndex) || `Paramètre ${colIndex - 1}`

    for (const {fieldName, row, mandatory} of metadataFields) {
      const value = getCellValue(sheet, row, colIndex)
      const cellAddress = XLSX.utils.encode_cell({c: colIndex, r: row})

      if (mandatory && !value) {
        errorCollector.addSingleError({
          message: `Le champ '${fieldName}' (cellule ${cellAddress} de l'onglet '${sheetName}') est manquant pour le paramètre '${paramName}'`
        })
      } else if (fieldName === 'profondeur' && value) {
        // Valider que 'profondeur' est un nombre réel positif
        validateNumericValue(value)
      } else if (fieldName === 'date_debut' && value) {
        // Valider que 'date_debut' est une date valide
        const date = readAsDateString(sheet, row, colIndex)

        if (!date) {
          errorCollector.addSingleError({
            message: `Le champ 'date_debut' (cellule ${cellAddress} de l'onglet '${sheetName}') doit être une date valide pour le paramètre '${paramName}'`
          })
        }
      } else if (fieldName === 'date_fin' && value) {
        // Valider que 'date_fin' est une date valide
        const date = readAsDateString(sheet, row, colIndex)

        if (!date) {
          errorCollector.addSingleError({
            message: `Le champ 'date_fin' (cellule ${cellAddress} de l'onglet '${sheetName}') doit être une date valide pour le paramètre '${paramName}'`
          })
        }
      }
      // Ne pas appeler validateNumericValue sur les autres champs comme 'detail_point_suivi'
    }
  }
}

function validateFrequenceField(dataSheet, usedParameterColumns, {errorCollector}) {
  const {sheet, name: sheetName} = dataSheet
  const expectedFrequences = getFrequencesFromSheetName(sheetName)

  for (const colIndex of usedParameterColumns) {
    const paramName = getCellValue(sheet, 1, colIndex) || `Paramètre ${colIndex - 1}`
    const frequenceCell = getCellValue(sheet, 3, colIndex) // Ligne 4 (index 3)

    if (expectedFrequences && !expectedFrequences.includes(frequenceCell)) {
      errorCollector.addSingleError({
        message: `Le champ 'frequence' (cellule ${String.fromCodePoint(65 + colIndex)}4 de l'onglet '${sheetName}') a été modifié pour le paramètre '${paramName}'. Attendu : '${expectedFrequences.join(',')}', trouvé : '${frequenceCell}'`
      })
    }
  }
}

function checkIfSheetHasData(sheet) {
  // Définir la plage de la feuille
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1')
  const firstDataRow = 12 // Les données commencent à la ligne 13 (index 12)

  // Parcourir chaque ligne de données
  for (let rowNum = firstDataRow; rowNum <= range.e.r; rowNum++) {
    // Parcourir chaque colonne de la ligne
    for (let col = 0; col <= range.e.c; col++) {
      const cellAddress = XLSX.utils.encode_cell({c: col, r: rowNum})
      const cell = sheet[cellAddress]

      if (cell && cell.v !== undefined && cell.v !== null && cell.v !== '') {
        return true // Donnée trouvée
      }
    }
  }

  return false // Aucune donnée trouvée
}

function combineDateAndTime(date, time) {
  if (!date) {
    return
  }

  return `${date}T${time || '00:00:00'}Z`
}

function validateParameterData(dataRows, {startDate, endDate, paramIndex, paramName, isHeureMandatory, errorCollector}) {
  for (const row of dataRows) {
    const {rowNum} = row
    const valeur = row.values[paramIndex]

    if (valeur === null) {
      // Si 'Valeur' est manquante, 'Remarque' doit être renseignée
      const {remarque} = row
      if (!remarque) {
        const cellAddress = XLSX.utils.encode_cell({c: paramIndex, r: rowNum})
        errorCollector.addError('missingRemarque', cellAddress, {paramName})
      }

      continue
    }

    // Vérifier si 'date' et 'heure' sont présents comme requis
    if (!row.date || (isHeureMandatory && !row.heure)) {
      const dateCellAddress = XLSX.utils.encode_cell({c: 0, r: rowNum})
      const heureCellAddress = XLSX.utils.encode_cell({c: 1, r: rowNum})

      if (!row.date) {
        errorCollector.addError('missingDate', dateCellAddress)
      }

      if (isHeureMandatory && !row.heure) {
        errorCollector.addError('missingHeure', heureCellAddress)
      }

      continue
    }

    const dateCellAddress = XLSX.utils.encode_cell({c: 0, r: rowNum})

    try {
      validateDateInPeriod(row.date, {startDate, endDate})
    } catch {
      errorCollector.addError('invalidDateRange', dateCellAddress, {startDate, endDate})
    }
  }
}

function validateTimeStepConsistency(dataRows, {frequence, paramName, errorCollector}) {
  const dateTimes = dataRows.map(row => {
    const {date, heure} = row

    if (isFrequencyLessThanOneDay(frequence)) {
      if (heure) {
        return combineDateAndTime(date, heure)
      }

      return null
    }

    return date
  }).filter(dateTime => dateTime && dateTime instanceof Date && !Number.isNaN(dateTime))

  if (dateTimes.length < 2) {
    // Pas assez de données pour vérifier la cohérence
    return
  }

  const expectedDiffMs = getExpectedTimeDifference(frequence)

  if (!expectedDiffMs) {
    // Impossible de déterminer la différence de temps attendue
    errorCollector.addSingleError({
      message: `Impossible de déterminer le pas de temps attendu pour le paramètre ${paramName}`
    })

    return
  }

  // Définir une tolérance pour les écarts (par exemple, 1 seconde)
  const toleranceMs = 1000

  // Calculer les différences de temps entre les entrées consécutives

  for (let i = 1; i < dateTimes.length; i++) {
    const diffMs = dateTimes[i] - dateTimes[i - 1]

    if (Math.abs(diffMs - expectedDiffMs) > toleranceMs) {
      const dateCellAddress = XLSX.utils.encode_cell({r: dataRows[i].rowNum, c: 0})
      errorCollector.addError('invalidInterval', dateCellAddress)
    }
  }
}

function getDataRows(dataSheet, {errorCollector}) {
  const {sheet} = dataSheet

  const dataRows = []
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1')
  const firstDataRow = 12 // Les données commencent à la ligne 13 (index 12)

  const parameterColumns = getParameterColumns(sheet)
  const remarqueColIndex = parameterColumns.length + 2 // 'Remarque' est après les colonnes de paramètres

  const usedParameterColumns = new Set()

  for (let rowNum = firstDataRow; rowNum <= range.e.r; rowNum++) {
    const rowIndex = rowNum + 1

    // Utiliser les valeurs calculées pour les dates et heures
    const dateCellValue = getCellValue(sheet, rowNum, 0)
    const heureCellValue = getCellValue(sheet, rowNum, 1)

    const dateCellAddress = XLSX.utils.encode_cell({c: 0, r: rowNum})
    const heureCellAddress = XLSX.utils.encode_cell({c: 1, r: rowNum})

    // Conversion des dates et heures
    let date

    try {
      date = readAsDateString(sheet, rowNum, 0)
    } catch {
      errorCollector.addError('invalidDates', dateCellAddress)
    }

    if (dateCellValue && !date) {
      errorCollector.addError('invalidDates', dateCellAddress)
    }

    let heure

    try {
      heure = readAsTimeString(sheet, rowNum, 1)
    } catch {
      errorCollector.addError('invalidTimes', heureCellAddress)
    }

    if (heureCellValue && !heure) {
      errorCollector.addError('invalidTimes', heureCellAddress)
    }

    const remarque = getCellValue(sheet, rowNum, remarqueColIndex)

    const values = {}
    let hasValueInRow = false

    for (const param of parameterColumns) {
      const cellValue = getCellValue(sheet, rowNum, param.colIndex)
      const valeur = cellValue !== undefined && cellValue !== null && cellValue !== '' ? cellValue : null
      values[param.colIndex] = valeur

      if (valeur !== null) {
        hasValueInRow = true
        usedParameterColumns.add(param.colIndex)
      }
    }

    if (date || heure || hasValueInRow || remarque) {
      dataRows.push({
        rowNum,
        rowIndex,
        date,
        heure,
        values,
        remarque
      })
    }
  }

  return {
    dataRows,
    usedParameterColumns: [...usedParameterColumns]
  }
}

function getParameterColumns(sheet) {
  // Retourne un tableau d'objets avec les noms des paramètres et les index de colonnes
  const parameterColumns = []
  let colIndex = 2 // Commence à la colonne C (index 2)

  let cellValue = getCellValue(sheet, 11, colIndex) // Ligne des en-têtes (index 11)
  while (cellValue && cellValue.toString().trim().toLowerCase().startsWith('valeur_parametre')) {
    parameterColumns.push({
      paramName: cellValue,
      colIndex
    })
    colIndex++
    cellValue = getCellValue(sheet, 11, colIndex)
  }

  return parameterColumns
}

function getFrequencesFromSheetName(sheetName) {
  if (sheetName.includes('15 minutes')) {
    return ['15 minutes']
  }

  if (sheetName.includes('1 jour')) {
    return ['1 jour', 'jour']
  }

  if (sheetName.includes('1 trimestre')) {
    return ['1 trimestre', 'trimestre']
  }

  if (sheetName.includes('autre')) {
    return null // La fréquence devra être récupérée au niveau du paramètre
  }

  return null
}

// Fonction pour déterminer si la fréquence est inférieure à un jour
function isFrequencyLessThanOneDay(frequency) {
  const frequenciesLessThanOneDay = ['15 minutes', 'heure', 'minute', 'seconde']
  return frequenciesLessThanOneDay.includes(frequency) || false
}

function getExpectedTimeDifference(frequency) {
  const msPerMinute = 60 * 1000
  const msPerHour = 60 * msPerMinute
  const msPerDay = 24 * msPerHour

  switch (frequency) {
    case 'seconde': {
      return 1000
    }

    case 'minute': {
      return msPerMinute
    }

    case '15 minutes': {
      return 15 * msPerMinute
    }

    case 'heure': {
      return msPerHour
    }

    case 'jour': {
      return msPerDay
    }

    case '1 jour': {
      return msPerDay
    }

    case 'mois': {
      return 30 * msPerDay
    } // Approximation

    case 'trimestre': {
      return 91 * msPerDay
    } // Approximation pour un trimestre

    case 'année': {
      return 365 * msPerDay
    } // Approximation

    default: {
      return null
    } // Fréquence inconnue ou 'autre'
  }
}
