import {isEmpty} from 'lodash-es'

import {
  getCellValue,
  readSheet
} from '../xlsx.js'

import {validateAndExtract} from './tabs/metadata.js'
import {
  getDataRows,
  validateMetadataFields,
  validateFrequenceField,
  checkIfSheetHasData,
  validateParameterData,
  validateTimeStepConsistency
} from './tabs/data.js'

import ErrorCollector from './error-collector.js'

export async function validateMultiParamFile(buffer, {startDate, endDate} = {}) {
  let workbook

  try {
    workbook = await readSheet(buffer)
  } catch (error) {
    return [error]
  }

  const data = {}
  const errors = []

  const errorCollector = new ErrorCollector()

  const context = {workbook, startDate, endDate, errors, errorCollector}

  // Test T0003.7: Valider les libellés et la position des onglets et des en-têtes de colonne
  const {dataSheets, isValid: isValidHeadersAndSheets} = validateHeadersAndSheets(workbook, errors)

  if (!isValidHeadersAndSheets) {
    return errors
  }

  /* Handle metadata tab (A LIRE) */

  const metadataSheet = workbook.Sheets['A LIRE']
  const {result: metadataResult, metadata: metadataErrors} = validateAndExtract(metadataSheet)

  data.metadata = metadataResult
  errors.push(...metadataErrors)

  let dataFound = false // Flag pour suivre si des données sont trouvées

  // Traiter chaque onglet de données
  for (const dataSheet of dataSheets) {
    const {sheet, period} = dataSheet
    const sheetContext = {...context, sheet, sheetName: dataSheet.name, period}

    // Vérifier si des données sont présentes dans cet onglet
    const hasData = checkIfSheetHasData(sheet)

    if (!hasData) {
      continue
    }

    dataFound = true // Des données sont présentes dans au moins un onglet

    // Valider les lignes de données et récupérer les colonnes de paramètres utilisées
    const {dataRows, usedParameterColumns} = getDataRows(sheetContext)

    // Valider les champs de métadonnées pour les colonnes de paramètres utilisées
    validateMetadataFields(sheet, sheetContext, usedParameterColumns)

    // Valider que le champ 'frequence' n'a pas été modifié (Test T0003.6)
    validateFrequenceField(sheetContext, usedParameterColumns)

    // Pour chaque paramètre utilisé, valider les entrées de données
    for (const paramIndex of usedParameterColumns) {
      const paramName = getCellValue(sheet, 1, paramIndex) || `Paramètre ${paramIndex - 1}`

      // Valider les entrées de données pour ce paramètre
      validateParameterData(dataRows, paramIndex, paramName, sheetContext)
      // Test T0003.11: Valider la cohérence du pas de temps pour ce paramètre
      validateTimeStepConsistency(dataRows, paramIndex, sheetContext)
    }
  }

  // Après avoir traité tous les dataSheets, vérifier si des données ont été trouvées
  if (!dataFound) {
    errors.push({
      message: 'Aucune donnée n\'a été trouvée dans les onglets \'Data | T=...\'. Veuillez vérifier que vos données sont correctement saisies.'
    })
  }

  // Ajouter les erreurs groupées
  errors.push(...errorCollector.getGroupedErrors())

  return errors
}

// Fonctions utilitaires

function validateHeadersAndSheets(workbook, errors) {
  // Vérification de la présence de l'onglet A LIRE
  if (!workbook.Sheets['A LIRE']) {
    errors.push({
      message: 'L\'onglet \'A LIRE\' est manquant. Veuillez vérifier que votre fichier est correctement formaté.'
    })
  }

  // Extraction de la liste des onglets Data de façon normalisée
  const dataSheets = []

  const NORMALIZED_PERIODS = {
    '15 min': '15 minutes',
    '15mn': '15 minutes',
    '15m': '15 minutes',
    '1jour': '1 jour',
    jour: '1 jour',
    trimestre: '1 trimestre',
    autres: 'autre'
  }

  for (const sheetName of workbook.SheetNames) {
    const match = sheetName.match(/^data\s\|\s*t\s*=([a-z\d\s]+)$/i)

    if (!match) {
      continue
    }

    const period = match[1].trim().toLowerCase()

    if (match) {
      dataSheets.push({
        name: sheetName,
        sheet: workbook.Sheets[sheetName],
        period: NORMALIZED_PERIODS[period] || period
      })
    }
  }

  // Vérification de la présence des onglets Data requis
  const requiredPeriods = ['15 minutes', '1 jour', '1 trimestre', 'autre']

  const missingPeriods = requiredPeriods.filter(period => !dataSheets.some(sheet => sheet.period === period))
  if (!isEmpty(missingPeriods)) {
    errors.push({
      message: `Les onglets Data pour les périodes suivantes sont manquants : ${missingPeriods.join(', ')}. Veuillez vérifier que votre fichier est correctement formaté.`
    })
  }

  // À ce stade, si des erreurs ont été détectées, on arrête la vérification
  if (errors.length > 0) {
    return {isValid: false}
  }

  // Vérifier les en-têtes de colonnes dans les onglets 'Data | T=...'
  for (const dataSheet of dataSheets) {
    const expectedDataHeaders = ['date', 'heure']
    const startingColIndex = 0 // Colonne A

    // Vérifier les en-têtes 'date' et 'heure'
    for (const [offset, expectedHeader] of expectedDataHeaders.entries()) {
      const cellValue = getCellValue(dataSheet.sheet, 11, startingColIndex + offset) // Les en-têtes sont à la ligne 12 (index 11)
      if (!cellValue || cellValue.toString().trim().toLowerCase() !== expectedHeader.toLowerCase()) {
        errors.push({
          message: `L'intitulé de la colonne ${String.fromCodePoint(65 + startingColIndex + offset)}12 dans l'onglet '${dataSheet.name}' a été modifié. Attendu : '${expectedHeader}', trouvé : '${cellValue}'`
        })
        return {isValid: false}
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
      return {isValid: false}
    }
  }

  return {isValid: true, dataSheets}
}
