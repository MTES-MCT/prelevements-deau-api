import * as XLSX from 'xlsx'

import {
  getCellValue,
  readAsDateString,
  readAsTimeString
} from '../../xlsx.js'

import {validateDateInPeriod, validateNumericValue} from '../../validate.js'

export function validateMetadataFields(sheet, context, usedParameterColumns) {
  const {errors, sheetName} = context

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
        errors.push({
          message: `Le champ '${fieldName}' (cellule ${cellAddress} de l'onglet '${sheetName}') est manquant pour le paramètre '${paramName}'`
        })
      } else if (fieldName === 'profondeur' && value) {
        // Valider que 'profondeur' est un nombre réel positif
        validateNumericValue(value, row + 1, colIndex, context)
      } else if (fieldName === 'date_debut' && value) {
        // Valider que 'date_debut' est une date valide
        const date = readAsDateString(sheet, row, colIndex)

        if (!date) {
          errors.push({
            message: `Le champ 'date_debut' (cellule ${cellAddress} de l'onglet '${sheetName}') doit être une date valide pour le paramètre '${paramName}'`
          })
        }
      } else if (fieldName === 'date_fin' && value) {
        // Valider que 'date_fin' est une date valide
        const date = readAsDateString(sheet, row, colIndex)

        if (!date) {
          errors.push({
            message: `Le champ 'date_fin' (cellule ${cellAddress} de l'onglet '${sheetName}') doit être une date valide pour le paramètre '${paramName}'`
          })
        }
      }
      // Ne pas appeler validateNumericValue sur les autres champs comme 'detail_point_suivi'
    }
  }
}

export function validateFrequenceField(context, usedParameterColumns) {
  const {errors, sheetName, sheet} = context
  const expectedFrequences = getFrequencesFromSheetName(sheetName)

  for (const colIndex of usedParameterColumns) {
    const paramName = getCellValue(sheet, 1, colIndex) || `Paramètre ${colIndex - 1}`
    const frequenceCell = getCellValue(sheet, 3, colIndex) // Ligne 4 (index 3)

    if (expectedFrequences && !expectedFrequences.includes(frequenceCell)) {
      errors.push({
        message: `Le champ 'frequence' (cellule ${String.fromCodePoint(65 + colIndex)}4 de l'onglet '${sheetName}') a été modifié pour le paramètre '${paramName}'. Attendu : '${expectedFrequences.join(',')}', trouvé : '${frequenceCell}'`
      })
    }
  }
}

export function checkIfSheetHasData(sheet) {
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

export function validateParameterData(dataRows, paramIndex, paramName, context) {
  const {sheet, sheetName, errorCollector} = context

  // Obtenir la fréquence depuis la cellule du paramètre
  const frequence = getCellValue(sheet, 3, paramIndex) // Ligne index 3 (ligne 4)

  for (const row of dataRows) {
    const {rowNum} = row
    const valeur = row.values[paramIndex]

    if (valeur === null) {
      // Si 'Valeur' est manquante, 'Remarque' doit être renseignée
      const {remarque} = row
      if (!remarque) {
        const cellAddress = XLSX.utils.encode_cell({c: paramIndex, r: rowNum})
        errorCollector.addError('missingRemarque', sheetName, cellAddress, {paramName})
      }

      continue
    }

    // Déterminer si 'heure' est obligatoire
    const isHeureMandatory = isFrequencyLessThanOneDay(frequence)

    // Vérifier si 'date' et 'heure' sont présents comme requis
    if (!row.date || (isHeureMandatory && !row.heure)) {
      const dateCellAddress = XLSX.utils.encode_cell({c: 0, r: rowNum})
      const heureCellAddress = XLSX.utils.encode_cell({c: 1, r: rowNum})
      if (!row.date) {
        errorCollector.addError('missingDate', sheetName, dateCellAddress)
      }

      if (isHeureMandatory && !row.heure) {
        errorCollector.addError('missingHeure', sheetName, heureCellAddress, {frequence})
      }

      continue
    }

    // Combiner la date et l'heure si nécessaire
    const dateTime = isHeureMandatory ? combineDateAndTime(row.date, row.heure) : row.date

    if (dateTime) {
      validateDateInPeriod(dateTime, rowNum + 1, context)
    } else {
      const dateCellAddress = XLSX.utils.encode_cell({c: 0, r: rowNum})
      const heureCellAddress = XLSX.utils.encode_cell({c: 1, r: rowNum})
      errorCollector.addError('invalidDateTime', sheetName, `${dateCellAddress} et ${heureCellAddress}`)
    }
  }
}

export function validateTimeStepConsistency(dataRows, paramIndex, sheetContext) {
  const {sheetName, sheet, errors} = sheetContext

  // Obtenir la fréquence depuis la cellule du paramètre
  const frequence = getCellValue(sheet, 3, paramIndex) // Ligne 4 (index 3)

  if (!frequence) {
    // Impossible de déterminer la fréquence
    errors.push({
      message: `La fréquence pour le paramètre dans l'onglet '${sheetName}' ne peut pas être déterminée.`
    })
    return
  }

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
    errors.push({
      message: `La fréquence '${frequence}' dans l'onglet '${sheetName}' n'est pas reconnue pour le paramètre.`
    })
    return
  }

  // Définir une tolérance pour les écarts (par exemple, 1 seconde)
  const toleranceMs = 1000

  // Limiter le nombre d'erreurs pour éviter une surcharge
  const maxErrors = 10
  let errorCount = 0

  // Calculer les différences de temps entre les entrées consécutives

  for (let i = 1; i < dateTimes.length; i++) {
    const currentRow = dataRows[i].rowNum + 1
    const previousRow = dataRows[i - 1].rowNum + 1
    const diffMs = dateTimes[i] - dateTimes[i - 1]

    const paramName = getCellValue(sheet, 1, paramIndex) || `Paramètre ${paramIndex - 1}`
    if (Math.abs(diffMs - expectedDiffMs) > toleranceMs) {
      if (errorCount < maxErrors) {
        const expectedTime = formatTimeDifference(expectedDiffMs)
        const actualTime = formatTimeDifference(diffMs)
        errors.push({
          message: `Dans l'onglet '${sheetName}', pour le paramètre '${paramName}', l'intervalle entre les lignes ${previousRow} et ${currentRow} est de ${actualTime}, attendu : ${expectedTime}.`
        })
        errorCount++
      } else {
        // Ajouter un résumé si trop d'erreurs
        errors.push({
          message: `Dans l'onglet '${sheetName}', pour le paramètre '${paramName}', plus de ${maxErrors} écarts de temps ont été détectés par rapport à la fréquence '${frequence}'. Veuillez vérifier les données.`
        })
        break
      }
    }
  }
}

export function getDataRows(context) {
  const {sheet, sheetName, errorCollector} = context
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

    // Conversion des dates et heures
    const date = readAsDateString(sheet, rowNum, 0)

    if (dateCellValue && !date) {
      const dateCellAddress = XLSX.utils.encode_cell({c: 0, r: rowNum})
      errorCollector.addError('invalidDates', sheetName, dateCellAddress)
    }

    const heure = readAsTimeString(sheet, rowNum, 1)

    if (heureCellValue && !heure) {
      const heureCellAddress = XLSX.utils.encode_cell({c: 1, r: rowNum})
      errorCollector.addError('invalidTimes', sheetName, heureCellAddress)
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
  return frequenciesLessThanOneDay.includes(frequency)
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

// Fonction pour formater la différence de temps en heures, minutes et secondes
function formatTimeDifference(diffMs) {
  const totalSeconds = Math.floor(diffMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  let formatted = ''
  if (hours > 0) {
    formatted += `${hours}h `
  }

  if (minutes > 0 || hours > 0) {
    formatted += `${minutes}m `
  }

  formatted += `${seconds}s`
  return formatted.trim()
}
