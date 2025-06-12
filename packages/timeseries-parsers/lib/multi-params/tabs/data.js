import * as XLSX from 'xlsx'

import {
  getCellValue,
  readAsGivenType,
  readAsString,
  readAsNumber,
  readAsDateString,
  readAsTimeString
} from '../../xlsx.js'

import {ErrorCollector} from '../error-collector.js'

export function validateAndExtract(dataSheet) {
  const data = {}
  const errors = []
  const result = {errors, data}

  data.period = extractPeriod(dataSheet.name)

  const {errors: structureErrors} = validateStructure(dataSheet)

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
  const {dataRows} = getDataRows(dataSheet, {errorCollector})

  const parameters = validateAndExtractParameters(dataSheet, dataRows, {errorCollector})

  errors.push(...errorCollector.getErrors())

  data.rows = dataRows
  data.parameters = parameters

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

function validateAndExtractParameters(dataSheet, dataRows, {errorCollector}) {
  const allowedFrequenceValues = getAllowedFrequenceValuesFromSheetName(dataSheet.name)
  const parameters = []

  // Pour chaque paramètre utilisé, valider les entrées de données
  for (const paramIndex of [2, 3, 4, 5, 6, 7, 8]) {
    const fields = validateAndExtractParamFields(dataSheet, paramIndex, {errorCollector})

    if (!fields) {
      continue
    }

    const {frequence} = fields
    const paramName = fields.nom_parametre

    if (!frequence) {
      errorCollector.addSingleError({
        message: `Fréquence non renseignée pour le paramètre ${paramName}`
      })
    }

    if (frequence && allowedFrequenceValues && !allowedFrequenceValues.includes(frequence)) {
      errorCollector.addSingleError({
        message: `Le champ 'frequence' (cellule ${String.fromCodePoint(65 + paramIndex)}4 a été modifié pour le paramètre '${paramName}'. Attendu : '${allowedFrequenceValues.join(',')}', trouvé : '${frequence}'`
      })
    }

    // Valider les entrées de données pour ce paramètre
    const isHeureMandatory = isFrequencyLessThanOneDay(frequence)
    validateParameterData(dataRows, {paramIndex, paramName, isHeureMandatory, errorCollector})
    validateTimeStepConsistency(dataRows, {frequence, paramName, errorCollector})

    // Extraction des données du paramètre
    const paramDefinition = PARAM_TYPE_DEFINITIONS[paramName]
    const validate = paramDefinition?.validate

    const rows = []

    for (const row of dataRows) {
      const valeur = row.values[paramIndex]

      if (valeur === undefined) {
        continue
      }

      if (validate && !validate(valeur)) {
        errorCollector.addSingleError({
          message: `Valeur incorrecte pour le paramètre '${paramName}' à la date ${row.date} et à l'heure ${row.heure} : ${valeur}`
        })
      } else {
        rows.push({
          date: row.date,
          heure: row.heure,
          valeur
        })
      }
    }

    parameters.push({paramIndex, ...fields, rows})
  }

  return parameters
}

const UNITE_ALLOWED_VALUES = [
  'µS/cm',
  'degrés Celsius',
  'L/s',
  'm³/h',
  'm³',
  'm NGR',
  'mg/L',
  'autre'
]

function degradeUniteValue(value) {
  return value
    .toLowerCase()
    .trim()
    .replace('³', '3')
    .replace('µ', 'u')
    .replace('degrés', 'degres')
}

const UNITE_DEGRADED_ALLOWED_VALUES = UNITE_ALLOWED_VALUES
  .map(value => degradeUniteValue(value))

function validateAndExtractParamFields(dataSheet, colIndex, {errorCollector}) {
  const {sheet} = dataSheet

  const fields = {}

  // Positions des champs de métadonnées :
  // Lignes index 1 à 8 (Lignes 2 à 9)
  const definitions = [
    {
      fieldName: 'nom_parametre',
      type: 'string',
      enum: [
        'chlorures',
        'conductivité',
        'débit prélevé',
        'débit réservé',
        'débit restitué',
        'nitrates',
        'niveau d’eau',
        'pH',
        'relevé d’index de compteur',
        'sulfates',
        'température',
        'turbidité',
        'volume prélevé',
        'volume restitué',
        'autre'
      ],
      row: 1,
      required: true
    },
    {
      fieldName: 'type',
      type: 'string',
      enum: [
        'valeur brute',
        'minimum',
        'maximum',
        'moyenne',
        'médiane',
        'différence d’index',
        'autre'
      ],
      row: 2,
      required: true
    },
    {
      fieldName: 'frequence',
      type: 'string',
      parse(value) {
        const allowedValues = new Set([
          'seconde',
          'minute',
          '15 minutes',
          'heure',
          'jour',
          'mois',
          'trimestre',
          'année',
          'autre'
        ])

        value = value.toLowerCase().trim().replaceAll('1 jour', 'jour')

        if (allowedValues.has(value)) {
          return value
        }

        throw new Error(`La fréquence "${value}" n'est pas reconnue`)
      },
      row: 3,
      required: true
    },
    {
      fieldName: 'unite',
      type: 'string',
      parse(value) {
        const degradedValue = degradeUniteValue(value)

        const pos = UNITE_DEGRADED_ALLOWED_VALUES.indexOf(degradedValue)

        if (pos !== -1) {
          return UNITE_ALLOWED_VALUES[pos]
        }

        throw new Error(`L'unité "${value}" n'est pas reconnue`)
      },
      row: 4,
      required: true
    },
    {fieldName: 'detail_point_suivi', type: 'string', row: 5, required: false},
    {fieldName: 'profondeur', type: 'number', row: 6, required: false},
    {fieldName: 'date_debut', type: 'date', row: 7, required: false},
    {fieldName: 'date_fin', type: 'date', row: 8, required: false},
    {fieldName: 'remarque', type: 'string', row: 9, required: false}
  ]

  const paramName = getCellValue(sheet, 1, colIndex)

  if (!paramName) {
    return
  }

  for (const {fieldName, type, enum: enumValues, row, required, parse} of definitions) {
    const value = readAsGivenType(sheet, row, colIndex, type)
    const cellAddress = XLSX.utils.encode_cell({c: colIndex, r: row})

    fields[fieldName] = value

    if (required && value === undefined) {
      errorCollector.addSingleError({
        message: `Le champ '${fieldName}' (cellule ${cellAddress}) est manquant pour le paramètre '${paramName}'`
      })
    }

    if (value && enumValues && !enumValues.includes(value)) {
      errorCollector.addSingleError({
        message: `Le champ '${fieldName}' (cellule ${cellAddress}) doit être l'une des valeurs suivantes : ${enumValues.join(', ')}`
      })
    }

    if (value && parse) {
      try {
        fields[fieldName] = parse(value)
      } catch (error) {
        errorCollector.addSingleError({
          message: `Le champ '${fieldName}' (cellule ${cellAddress}) n'est pas valide pour le paramètre '${paramName}'`,
          explaination: error.message
        })
      }
    }

    if (fieldName === 'date_debut' && value !== undefined) {
      // Valider que 'date_debut' est une date valide
      const date = readAsDateString(sheet, row, colIndex)

      if (!date) {
        errorCollector.addSingleError({
          message: `Le champ 'date_debut' (cellule ${cellAddress}) doit être une date valide pour le paramètre '${paramName}'`
        })
      }
    }

    if (fieldName === 'date_fin' && value) {
      // Valider que 'date_fin' est une date valide
      const date = readAsDateString(sheet, row, colIndex)

      if (!date) {
        errorCollector.addSingleError({
          message: `Le champ 'date_fin' (cellule ${cellAddress}) doit être une date valide pour le paramètre '${paramName}'`
        })
      }
    }
  }

  return fields
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

function validateParameterData(dataRows, {paramIndex, paramName, isHeureMandatory, errorCollector}) {
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

    const remarque = readAsString(sheet, rowNum, remarqueColIndex)

    const values = {}
    let hasValueInRow = false

    for (const param of parameterColumns) {
      const cellValue = getCellValue(sheet, rowNum, param.colIndex)
      const valeur = cellValue !== undefined && cellValue !== null && cellValue !== '' ? cellValue : null
      values[param.colIndex] = readAsNumber(sheet, rowNum, param.colIndex)

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

function getAllowedFrequenceValuesFromSheetName(sheetName) {
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

const PARAM_TYPE_DEFINITIONS = {
  'volume prélevé': {
    validate(value) {
      return value >= 0
    }
  }
}
