import {pick, minBy, maxBy, sumBy} from 'lodash-es'
import * as XLSX from 'xlsx'

import {
  getCellValue,
  readSheet,
  readAsDateString
} from '../xlsx.js'

import {validateNumericValue} from '../validate.js'

export async function validateCamionCiterneFile(buffer) {
  const errors = []
  const data = {
    dailyValues: []
  }

  let workbook
  try {
    workbook = await readSheet(buffer)
  } catch (error) {
    return {errors: [error]}
  }

  // VERIFICATIONS
  // Vérifier que le fichier n'est pas vide
  if (!validateFileNotEmpty(workbook, errors)) {
    return {errors}
  }

  // Obtenir la première feuille du classeur
  const sheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]

  // Vérifier que les en-têtes sont corrects
  data.headers = validateHeaders(sheet, errors)

  // Vérifier les lignes de données
  validateDataRows(sheet, errors, data)

  // CONSOLIDATE DATA
  let consolidatedData
  const hasErrors = errors.some(e => e.severity === 'error')
  if (!hasErrors) {
    try {
      consolidatedData = consolidateData(data)
    } catch (error) {
      errors.push({
        message: error.message,
        severity: 'error'
      })
    }
  }

  return {
    rawData: data,
    data: consolidatedData,
    errors: errors.map(e => pick(e, [
      'message',
      'explanation',
      'internalMessage',
      'severity'
    ]))
  }
}

// Sous-fonctions

function validateFileNotEmpty(workbook, errors) {
  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    errors.push({
      message: 'Le fichier est vide ou ne contient pas de feuille.',
      severity: 'error'
    })
    return false
  }

  // Obtenir la première feuille du classeur
  const sheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]

  // Si la feuille est vide, on ne peut pas valider les en-têtes
  if (!sheet['!ref']) {
    errors.push({
      message: 'La feuille de calcul est vide.',
      severity: 'error'
    })

    return false
  }

  return true
}

function validateHeaders(sheet, errors) {
  // Liste des codes et noms attendus
  const expectedHeaders = [
    {code: 412, name: 'Riv. St Denis La Colline'},
    {code: 413, name: 'Rav. à Jacques (La Montagne)'},
    {code: 414, name: 'Rav. Charpentier'},
    {code: 416, name: 'Ruisseau Emmanuel'},
    {code: 417, name: 'Petite riv St Jean'},
    {code: 418, name: 'Riv. Bras Panon'},
    {code: 419, name: 'Riv. des Galets'},
    {code: 420, name: 'Rav. Bernica'},
    {code: 421, name: 'Bras de la Plaine'},
    {code: 422, name: 'Riv. Des Remparts'},
    {code: 423, name: 'Source des Allemands'}
  ]

  const headers = []
  const foundHeaders = new Set()

  // Lecture des en-têtes à partir de la ligne 3 (index 2)
  const headerRowIndex = 2
  const range = XLSX.utils.decode_range(sheet['!ref'])
  const maxCol = range.e.c

  // Vérifier que la première cellule est "Date"
  const firstHeaderCell = getCellValue(sheet, headerRowIndex, 0)
  if (!firstHeaderCell || firstHeaderCell.trim().toLowerCase() !== 'date') {
    errors.push({
      message: `L'intitulé de la première colonne doit être 'Date'. Trouvé : '${firstHeaderCell}'.`,
      severity: 'error'
    })
  }

  // Parcourir les autres en-têtes
  for (let colNum = 1; colNum <= maxCol; colNum++) {
    const cellValue = getCellValue(sheet, headerRowIndex, colNum)

    // Si la cellule est vide, on l'ignore et on passe à la suivante
    if (!cellValue) {
      continue
    }

    // Nettoyer la chaîne : supprimer les retours à la ligne et les espaces supplémentaires
    const cleanedCellValue = cellValue.replaceAll(/\s+/g, ' ').trim()

    // Extraire le code et le nom à partir de la chaîne
    const match = cleanedCellValue.match(/^(\d{3})\s+(.*)$/)
    if (!match) {
      errors.push({
        message: `L'en-tête de la colonne ${colNum + 1} n'est pas au format attendu. Trouvé : '${cellValue}'.`,
        explanation: 'Le format attendu est : "code nom". Le code doit être celui du point de prélèvement, suivi d\'un espace, puis du nom du point de prélèvement.',
        severity: 'error'
      })
      continue
    }

    const code = Number(match[1])
    const name = match[2]

    const isValidHeader = expectedHeaders.some(
      h => h.code === code && h.name.toLowerCase() === name.toLowerCase()
    )

    if (!isValidHeader) {
      errors.push({
        message: `L'en-tête de la colonne ${colNum + 1} ne correspond à aucun point de prélèvement connu. Trouvé : '${cellValue}'.`,
        severity: 'error'
      })
      continue
    }

    const headerIdentifier = `${code}-${name.toLowerCase()}`
    if (foundHeaders.has(headerIdentifier)) {
      errors.push({
        message: `Le point de prélèvement ${code} - ${name} est un doublon.`,
        severity: 'error'
      })
      continue
    }

    headers.push({code, name, colNum})
    foundHeaders.add(headerIdentifier)
  }

  return headers
}

function validateDataRows(sheet, errors, data) {
  const range = XLSX.utils.decode_range(sheet['!ref'])
  const firstDataRowIndex = 3 // Index de la première ligne de données (ligne 4)

  if (range.e.r < firstDataRowIndex) {
    errors.push({
      message: 'Le fichier ne contient pas de données à partir de la ligne 4.',
      severity: 'error'
    })
    return
  }

  let hasDataLines = false // Indique si au moins une ligne de données a été trouvée
  const dateSet = new Set()

  for (let rowNum = firstDataRowIndex; rowNum <= range.e.r; rowNum++) {
    const rowIndex = rowNum + 1 // Pour affichage (1-based)

    // Vérifier si la ligne est entièrement vide
    if (isRowEmpty(sheet, rowNum, data.headers)) {
      // Ignorer les lignes entièrement vides
      continue
    }

    // Obtenir la cellule de date
    let dateValue
    try {
      dateValue = readAsDateString(sheet, rowNum, 0)
    } catch (error) {
      errors.push({
        message: `Ligne ${rowIndex}: ${error.message}`,
        severity: 'error'
      })
      continue
    }

    // Construire le contexte de la ligne
    const rowContext = {
      sheet,
      rowNum,
      rowIndex,
      headers: data.headers
    }

    if (!dateValue) {
      continue
    }

    hasDataLines = true // Une ligne de données valide a été trouvée

    // Vérifier si la date est déjà présente
    if (dateSet.has(dateValue)) {
      errors.push({
        message: `Ligne ${rowIndex}: La date ${dateValue} est déjà présente dans le fichier.`,
        explanation: 'Si deux prélevements ont lieu le même jour, additionnez les valeurs et indiquez-les sur une seule ligne.',
        severity: 'error'
      })
    } else {
      dateSet.add(dateValue)
    }

    // Valider les valeurs numériques
    const {values, errors: numericErrors} = validateNumericValues(rowContext)
    errors.push(...numericErrors)

    if (values) {
      data.dailyValues.push({date: dateValue, values})
    } else {
      errors.push({
        message: `Ligne ${rowIndex}: La date est renseignée, mais aucune valeur n'est indiquée dans les colonnes des points de prélèvement.`,
        explanation: 'Si vous aucun prélèvement n\'a été effectué, renseignez la valeur 0.',
        severity: 'error'
      })
    }

    // Si la date est absente et qu'il n'y a pas de données dans les autres colonnes, ne rien faire
  }

  // Après avoir parcouru toutes les lignes, vérifier si au moins une ligne de données a été trouvée
  if (!hasDataLines) {
    errors.push({
      message: 'Le fichier ne contient pas de données.',
      severity: 'error'
    })
  }
}

// Fonction pour vérifier si une ligne est entièrement vide
function isRowEmpty(sheet, rowNum, headers) {
  // Check date column
  if (getCellValue(sheet, rowNum, 0) !== null && getCellValue(sheet, rowNum, 0) !== '') {
    return false
  }

  // Check data columns defined in headers
  for (const header of headers) {
    const cellValue = getCellValue(sheet, rowNum, header.colNum)
    if (cellValue !== null && cellValue !== '') {
      return false
    }
  }

  return true
}

function validateNumericValues(rowContext) {
  const {sheet, rowNum, rowIndex, headers} = rowContext
  const values = []
  const errors = []
  let hasValues = false

  for (const header of headers) {
    const {colNum} = header
    const cellValue = getCellValue(sheet, rowNum, colNum)
    try {
      validateNumericValue(cellValue)
      values.push(cellValue)
      if (cellValue !== null && cellValue !== '') {
        hasValues = true
      }
    } catch (error) {
      errors.push({
        message: `Ligne ${rowIndex} - colonne ${colNum + 1}: ${error.message}`,
        severity: 'error'
      })
      values.push(null) // Push null to keep array length consistent
    }
  }

  if (!hasValues) {
    return {values: null, errors}
  }

  return {values, errors}
}

function consolidateData(rawData) {
  if (rawData.dailyValues.length === 0) {
    throw new Error('Le fichier ne contient pas de données journalières')
  }

  const data = rawData.headers.map((header, i) => {
    const dailyValues = rawData.dailyValues.map(row => ({
      date: row.date,
      values: row.values[i] ? [row.values[i]] : null
    })).filter(v => v.values)

    if (dailyValues.length === 0) {
      return
    }

    return {
      pointPrelevement: header.code,
      pointPrelevementNom: header.name,
      minDate: minBy(dailyValues, 'date').date,
      maxDate: maxBy(dailyValues, 'date').date,
      dailyParameters: [{
        paramIndex: 0,
        nom_parametre: 'volume prélevé',
        type: 'valeur brute',
        unite: 'm3'
      }],
      dailyValues,
      volumePreleveTotal: sumBy(dailyValues, row => row.values[0])
    }
  })

  return data.filter(Boolean)
}
