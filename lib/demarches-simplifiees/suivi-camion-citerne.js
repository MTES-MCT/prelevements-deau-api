import * as XLSX from 'xlsx'

import {
  getCellValue,
  validateDateInPeriod,
  validateNumericValue,
  parseExcelDate,
  readSheet
} from './xlsx.js'

export default async function validateCamionCiterneFile(buffer, {startDate, endDate} = {}) {
  const result = await readSheet(buffer)

  if (!result.workbook) {
    return [result]
  }

  const {workbook} = result

  const errors = []

  // Vérifier que le fichier n'est pas vide
  if (!validateFileNotEmpty(workbook, errors)) {
    return errors
  }

  // Obtenir la première feuille du classeur
  const sheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]

  // Vérifier que les en-têtes sont corrects
  validateHeaders(sheet, errors)

  // Vérifier les lignes de données
  validateDataRows(sheet, {startDate, endDate}, errors)

  return errors
}

// Sous-fonctions

function validateFileNotEmpty(workbook, errors) {
  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    errors.push({
      message: 'Le fichier est vide ou ne contient pas de feuille.'
    })
    return false
  }

  return true
}

function validateHeaders(sheet, errors) {
  // Liste des codes et noms attendus
  const expectedHeaders = [
    {code: '412', name: 'Riv. St Denis La Colline'},
    {code: '413', name: 'Rav. à Jacques (La Montagne)'},
    {code: '414', name: 'Rav. Charpentier'},
    {code: '416', name: 'Ruisseau Emmanuel'},
    {code: '417', name: 'Petite riv St Jean'},
    {code: '418', name: 'Riv. Bras Panon'},
    {code: '419', name: 'Riv. des Galets'},
    {code: '420', name: 'Rav. Bernica'},
    {code: '421', name: 'Bras de la Plaine'},
    {code: '422', name: 'Riv. Des Remparts'}
  ]

  // Lecture des en-têtes à partir de la ligne 3 (index 2)
  const headerRowIndex = 2

  // Vérifier que la première cellule est "Date"
  const firstHeaderCell = getCellValue(sheet, headerRowIndex, 0)
  if (!firstHeaderCell || firstHeaderCell.trim().toLowerCase() !== 'date') {
    errors.push({
      message: `L'intitulé de la première colonne doit être 'Date'. Trouvé : '${firstHeaderCell}'.`
    })
  }

  // Parcourir les autres en-têtes
  for (let colNum = 1; colNum <= expectedHeaders.length; colNum++) {
    const cellValue = getCellValue(sheet, headerRowIndex, colNum)
    if (!cellValue) {
      errors.push({
        message: `L'en-tête de la colonne ${colNum + 1} est manquant.`
      })
      continue
    }

    // Nettoyer la chaîne : supprimer les retours à la ligne et les espaces supplémentaires
    const cleanedCellValue = cellValue.replaceAll(/\s+/g, ' ').trim()

    // Extraire le code et le nom à partir de la chaîne
    const match = cleanedCellValue.match(/^(\d{3})\s+(.*)$/)
    if (!match) {
      errors.push({
        message: `L'en-tête de la colonne ${colNum + 1} n'est pas au format attendu. Trouvé : '${cellValue}'.`
      })
      continue
    }

    const code = match[1]
    const name = match[2]

    const expectedHeader = expectedHeaders[colNum - 1]
    if (
      code !== expectedHeader.code
      || name.toLowerCase() !== expectedHeader.name.toLowerCase()
    ) {
      errors.push({
        message: `L'en-tête de la colonne ${colNum + 1} ne correspond pas. Attendu : '${expectedHeader.code} ${expectedHeader.name}', trouvé : '${cellValue}'.`
      })
    }
  }
}

function validateDataRows(sheet, {startDate, endDate}, errors) {
  const range = XLSX.utils.decode_range(sheet['!ref'])
  const firstDataRowIndex = 3 // Index de la première ligne de données (ligne 4)

  if (range.e.r < firstDataRowIndex) {
    errors.push({
      message: 'Le fichier ne contient pas de données à partir de la ligne 4.'
    })
    return
  }

  let hasDataLines = false // Indique si au moins une ligne de données a été trouvée
  const dateSet = new Set()

  for (let rowNum = firstDataRowIndex; rowNum <= range.e.r; rowNum++) {
    const rowIndex = rowNum + 1 // Pour affichage (1-based)

    // Vérifier si la ligne est entièrement vide
    if (isRowEmpty(sheet, rowNum)) {
      // Ignorer les lignes entièrement vides
      continue
    }

    // Obtenir la cellule de date
    const dateCell = getCellValue(sheet, rowNum, 0)
    const dateValue = parseExcelDate(dateCell)

    // Construire le contexte de la ligne
    const rowContext = {
      sheet,
      rowNum,
      rowIndex
    }

    if (dateCell) {
      hasDataLines = true // Une ligne de données valide a été trouvée

      // La date est présente, vérifier si elle est valide
      if (dateValue) {
        // Valider que la date est dans la période du formulaire
        validateDateInPeriod(dateValue, rowIndex, {startDate, endDate, errors})

        // Vérifier si la date est déjà présente
        // const dateString = dateCell.toISOString().split('T')[0] // Format 'YYYY-MM-DD'
        if (dateSet.has(dateValue)) {
          errors.push({
            message: `Ligne ${rowIndex}: La date ${dateCell.toLocaleDateString()} est déjà présente dans le fichier.`
          })
        } else {
          dateSet.add(dateValue)
        }
      } else {
        errors.push({
          message: `Ligne ${rowIndex}: La date dans la colonne A n'est pas au format date valide.`
        })
      }

      // Valider les valeurs numériques
      validateNumericValues(rowContext, errors)

      // Valider la présence de valeurs non nulles si la date est renseignée
      validateNonNullValues(rowContext, errors)
    } else if (hasDataInOtherColumns(sheet, rowNum)) {
      // La date est absente mais des données sont présentes dans les autres colonnes
      // Valider que la date est présente si des valeurs sont renseignées
      validateDatePresence(rowContext, errors)
    }
    // Si la date est absente et qu'il n'y a pas de données dans les autres colonnes, ne rien faire
  }

  // Après avoir parcouru toutes les lignes, vérifier si au moins une ligne de données a été trouvée
  if (!hasDataLines) {
    errors.push({
      message: 'Le fichier ne contient pas de données.'
    })
  }
}

// Fonction pour vérifier si une ligne est entièrement vide
function isRowEmpty(sheet, rowNum) {
  for (let colNum = 0; colNum <= 10; colNum++) {
    const cellValue = getCellValue(sheet, rowNum, colNum)
    if (cellValue !== null && cellValue !== '') {
      return false
    }
  }

  return true
}

// Fonction pour vérifier s'il y a des données dans les autres colonnes
function hasDataInOtherColumns(sheet, rowNum) {
  for (let colNum = 1; colNum <= 10; colNum++) {
    const cellValue = getCellValue(sheet, rowNum, colNum)
    if (cellValue !== null && cellValue !== '') {
      return true
    }
  }

  return false
}

function validateNumericValues(rowContext, errors) {
  const {sheet, rowNum, rowIndex, fileName} = rowContext
  for (let colNum = 1; colNum <= 10; colNum++) {
    const cellValue = getCellValue(sheet, rowNum, colNum)
    validateNumericValue(cellValue, rowIndex, colNum, {fileName, errors})
  }
}

function validateNonNullValues(rowContext, errors) {
  const {sheet, rowNum, rowIndex} = rowContext
  let hasNonNullValue = false
  for (let colNum = 1; colNum <= 10; colNum++) {
    const cellValue = getCellValue(sheet, rowNum, colNum)
    if (cellValue !== null && cellValue !== '') {
      hasNonNullValue = true
      break
    }
  }

  if (!hasNonNullValue) {
    errors.push({
      message: `Ligne ${rowIndex}: La date est renseignée, mais aucune valeur n'est indiquée dans les colonnes B à K.`
    })
  }
}

function validateDatePresence(rowContext, errors) {
  const {sheet, rowNum, rowIndex} = rowContext
  let hasValueInOtherColumns = false
  for (let colNum = 1; colNum <= 10; colNum++) {
    const cellValue = getCellValue(sheet, rowNum, colNum)
    if (cellValue !== null && cellValue !== '') {
      hasValueInOtherColumns = true
      break
    }
  }

  if (hasValueInOtherColumns) {
    errors.push({
      message: `Ligne ${rowIndex}: Une valeur est renseignée dans les colonnes B à K sans date associée dans la colonne A.`
    })
  }
}
