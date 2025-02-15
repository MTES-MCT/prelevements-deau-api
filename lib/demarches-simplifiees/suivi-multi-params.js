import * as XLSX from 'xlsx'
import {isEmpty} from 'lodash-es'

import {
  getCellValue,
  validateDateInPeriod,
  validateNumericValue,
  parseExcelDate,
  readSheet
} from './xlsx.js'

// Tests à effectuer :
// 1. T0001 : Le fichier doit être au format tableur (xls, xlsx, ods).
// 2. T0003.1 : Le nom du point de prélèvement doit être renseigné (cellule B3 de l’onglet “A LIRE”).
// 3. T0003.2 : Les champs obligatoires pour chaque paramètre doivent être renseignés si des valeurs sont indiquées.
// 4. T0003.3 : Le champ “profondeur” est un nombre réel positif.
// 5. T0003.4 : Les champs “date_debut” et “date_fin” sont des dates valides.
// 6. T0003.5 : Les champs “nom_parametre”, “type”, “unite” doivent respecter les valeurs des menus déroulants.
// 7. T0003.6 : Le champ “frequence” ne doit pas être modifié.
// 8. T0003.7 : Les libellés et positions des onglets et des en-têtes de colonne ne doivent pas être modifiés.
// 9. T0003.8 : Si une valeur est indiquée pour un paramètre, les champs “date” et “heure” doivent être non nuls.
// 10. T0003.9 : Les valeurs renseignées pour les paramètres doivent être des nombres réels positifs.
// 11. T0003.10 : Si une valeur est manquante pour un paramètre, le champ “remarque” doit être rempli.
// 12. T0003.11 : Cohérence entre le pas de temps affiché pour le paramètre et la série de dates/heures.
// 13. Les dates doivent être comprises dans la période indiquée dans le formulaire.

// Classe pour collecter et regrouper les erreurs similaires
class ErrorCollector {
  constructor() {
    this.errors = {}
  }

  addError(type, sheet, cell, data = {}) {
    this.errors[type] ||= {}
    this.errors[type][sheet] ||= []

    this.errors[type][sheet].push({cell, ...data})
  }

  getGroupedErrors() {
    const groupedErrors = []
    // Pour chaque type d'erreur
    for (const [type, sheets] of Object.entries(this.errors)) {
      for (const [sheet, errors] of Object.entries(sheets)) {
        const cells = errors.map(e => e.cell)
        let message
        const cellRanges = []
        for (const cell of cells) {
          const lastRange = cellRanges.at(-1)
          const cellNumber = Number.parseInt(cell.match(/\d+/)[0], 10)

          if (lastRange && cellNumber === lastRange.end + 1) {
            lastRange.end = cellNumber
          } else {
            cellRanges.push({start: cellNumber, end: cellNumber})
          }
        }

        const cellIntervals = cellRanges.map(range => range.start === range.end ? `cellule ${range.start}` : `cellules ${range.start}-${range.end}`).join(', ')

        switch (type) {
          case 'invalidDates': {
            message = `Les dates dans l'onglet '${sheet}' ne sont pas valides pour les ${cellIntervals}.`
            break
          }

          case 'invalidTimes': {
            message = `Les heures dans l'onglet '${sheet}' ne sont pas valides pour les ${cellIntervals}.`
            break
          }

          case 'missingDate': {
            message = `Le champ 'date' est obligatoire dans l'onglet '${sheet}' pour les ${cellIntervals}.`
            break
          }

          case 'missingHeure': {
            const {frequence} = errors[0]
            message = `Le champ 'heure' est obligatoire dans l'onglet '${sheet}' à la fréquence '${frequence}' pour les ${cellIntervals}.`
            break
          }

          case 'invalidDateTime': {
            message = `Les dates et heures dans l'onglet '${sheet}' ne sont pas valides pour les ${cellIntervals}.`
            break
          }

          case 'missingRemarque': {
            const {paramName} = errors[0]
            message = `Le champ 'Remarque' doit être renseigné si la valeur est manquante pour le paramètre '${paramName}' dans l'onglet '${sheet}', ${cellIntervals}.`
            break
          }

          default: {
            message = `Erreur inconnue de type '${type}' dans l'onglet '${sheet}' pour les ${cellIntervals}.`
            break
          }
        }

        groupedErrors.push({
          message,
          destinataire: 'déclarant'
        })
      }
    }

    return groupedErrors
  }
}

export default async function runMultiParamTests(buffer, formData) {
  const result = await readSheet(buffer)

  if (!result.workbook) {
    return [result]
  }

  const {workbook} = result

  const errors = []
  const errorCollector = new ErrorCollector()
  const context = {workbook, formData, errors, errorCollector}

  try {
    // Test T0003.7: Valider les libellés et la position des onglets et des en-têtes de colonne
    if (!validateHeadersAndSheets(context)) {
      return errors
    }

    // Test T0003.1: Valider le nom du point de prélèvement
    validatePointDePrelevement(context)

    // Parcourir les onglets de données
    const dataSheets = workbook.SheetNames.filter(sheetName => sheetName.startsWith('Data | '))

    if (dataSheets.length === 0) {
      errors.push({
        message: 'Aucun onglet de données trouvé. Veuillez utiliser l\'un des onglets \'Data | T=...\' pour saisir vos données.',
        destinataire: 'déclarant'
      })
      return errors
    }

    let dataFound = false // Flag pour suivre si des données sont trouvées

    // Traiter chaque onglet de données
    for (const sheetName of dataSheets) {
      const dataSheet = workbook.Sheets[sheetName]
      context.currentSheet = sheetName

      // Vérifier si des données sont présentes dans cet onglet
      const hasData = checkIfSheetHasData(dataSheet)

      if (!hasData) {
        continue
      }

      dataFound = true // Des données sont présentes dans au moins un onglet

      // Valider les lignes de données et récupérer les colonnes de paramètres utilisées
      const {dataRows, usedParameterColumns} = getDataRows(dataSheet, context)

      // Valider les champs de métadonnées pour les colonnes de paramètres utilisées
      validateMetadataFields(dataSheet, context, usedParameterColumns)

      // Valider que le champ 'frequence' n'a pas été modifié (Test T0003.6)
      validateFrequenceField(dataSheet, sheetName, context, usedParameterColumns)

      // Pour chaque paramètre utilisé, valider les entrées de données
      for (const paramIndex of usedParameterColumns) {
        const paramName = getCellValue(dataSheet, 1, paramIndex) || `Paramètre ${paramIndex - 1}`

        // Valider les entrées de données pour ce paramètre
        validateParameterData(dataRows, paramIndex, paramName, context, sheetName)
        // Test T0003.11: Valider la cohérence du pas de temps pour ce paramètre
        validateTimeStepConsistency(context, dataRows, paramIndex, sheetName)
      }
    }

    // Après avoir traité tous les dataSheets, vérifier si des données ont été trouvées
    if (!dataFound) {
      errors.push({
        message: 'Aucune donnée n\'a été trouvée dans les onglets \'Data | T=...\'. Veuillez vérifier que vos données sont correctement saisies.',
        destinataire: 'déclarant'
      })
    }
  } catch (error) {
    // Erreur inattendue
    errors.push({
      message: `Erreur inattendue lors des tests sur le fichier: ${error.message}`,
      destinataire: 'administrateur'
    })
  }

  // Ajouter les erreurs groupées
  errors.push(...errorCollector.getGroupedErrors())

  return errors
}

// Fonctions utilitaires

function validateHeadersAndSheets({workbook, errors}) {
  const expectedSheets = [
    'A LIRE',
    'Data | T= 15 minutes',
    'Data | T=1 jour',
    'Data | T= 1 trimestre',
    'Data | T= autre'
  ]
  const actualSheets = workbook.SheetNames

  // Vérifier les onglets
  const missingSheets = expectedSheets.filter(sheet => !actualSheets.includes(sheet))
  if (!isEmpty(missingSheets)) {
    for (const sheetName of missingSheets) {
      errors.push({
        message: `L'onglet '${sheetName}' est manquant ou a été modifié`,
        destinataire: 'déclarant'
      })
    }

    return false
  }

  // Vérifier les en-têtes de colonnes dans l'onglet 'A LIRE'
  const aLireSheet = workbook.Sheets['A LIRE']
  if (!aLireSheet) {
    errors.push({
      message: 'L\'onglet \'A LIRE\' est manquant ou a été modifié',
      destinataire: 'déclarant'
    })
    return false
  }

  // Vérifier les en-têtes de colonnes dans les onglets 'Data | T=...'
  for (const sheetName of expectedSheets.filter(sheet => sheet.startsWith('Data | '))) {
    const dataSheet = workbook.Sheets[sheetName]
    if (!dataSheet) {
      continue
    }

    const expectedDataHeaders = ['date', 'heure']
    const startingColIndex = 0 // Colonne A

    // Vérifier les en-têtes 'date' et 'heure'
    for (const [offset, expectedHeader] of expectedDataHeaders.entries()) {
      const cellValue = getCellValue(dataSheet, 11, startingColIndex + offset) // Les en-têtes sont à la ligne 12 (index 11)
      if (!cellValue || cellValue.toString().trim().toLowerCase() !== expectedHeader.toLowerCase()) {
        errors.push({
          message: `L'intitulé de la colonne ${String.fromCodePoint(65 + startingColIndex + offset)}12 dans l'onglet '${sheetName}' a été modifié. Attendu : '${expectedHeader}', trouvé : '${cellValue}'`,
          destinataire: 'déclarant'
        })
        return false
      }
    }

    // Vérifier que les colonnes de valeurs des paramètres ont les en-têtes corrects
    // À partir de la colonne C (index 2) jusqu'à la dernière colonne de paramètre
    let colIndex = 2 // Commence à la colonne C
    let cellValue = getCellValue(dataSheet, 11, colIndex)
    while (cellValue && cellValue.toString().trim().toLowerCase().startsWith('valeur_parametre')) {
      // Passer à la colonne suivante
      colIndex++
      cellValue = getCellValue(dataSheet, 11, colIndex)
    }

    // Après les colonnes de paramètres, on s'attend à l'en-tête 'Remarque'
    const remarqueCellValue = getCellValue(dataSheet, 11, colIndex)
    if (!remarqueCellValue || remarqueCellValue.toString().trim().toLowerCase() !== 'remarque') {
      errors.push({
        message: `L'intitulé de la colonne ${String.fromCodePoint(65 + colIndex)}12 dans l'onglet '${sheetName}' a été modifié. Attendu : 'Remarque', trouvé : '${remarqueCellValue}'`,
        destinataire: 'déclarant'
      })
      return false
    }
  }

  return true
}

function validatePointDePrelevement({workbook, errors}) {
  const aLireSheet = workbook.Sheets['A LIRE']
  const pointPrelevement = getCellValue(aLireSheet, 2, 1) // Cellule B3

  if (!pointPrelevement) {
    errors.push({
      message: 'Le nom du point de prélèvement (cellule B3 de l\'onglet \'A LIRE\') est manquant',
      destinataire: 'déclarant'
    })
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

function validateMetadataFields(sheet, context, usedParameterColumns) {
  const {errors, currentSheet} = context

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
          message: `Le champ '${fieldName}' (cellule ${cellAddress} de l'onglet '${currentSheet}') est manquant pour le paramètre '${paramName}'`,
          destinataire: 'déclarant'
        })
      } else if (fieldName === 'profondeur' && value) {
        // Valider que 'profondeur' est un nombre réel positif
        validateNumericValue(value, row + 1, colIndex, context)
      } else if (fieldName === 'date_debut' && value) {
        // Valider que 'date_debut' est une date valide
        const date = parseExcelDate(value)
        if (!date) {
          errors.push({
            message: `Le champ 'date_debut' (cellule ${cellAddress} de l'onglet '${currentSheet}') doit être une date valide pour le paramètre '${paramName}'`,
            destinataire: 'déclarant'
          })
        }
      } else if (fieldName === 'date_fin' && value) {
        // Valider que 'date_fin' est une date valide
        const date = parseExcelDate(value)
        if (!date) {
          errors.push({
            message: `Le champ 'date_fin' (cellule ${cellAddress} de l'onglet '${currentSheet}') doit être une date valide pour le paramètre '${paramName}'`,
            destinataire: 'déclarant'
          })
        }
      }
      // Ne pas appeler validateNumericValue sur les autres champs comme 'detail_point_suivi'
    }
  }
}

function validateFrequenceField(sheet, sheetName, context, usedParameterColumns) {
  const {errors, currentSheet} = context
  const expectedFrequence = getFrequenceFromSheetName(sheetName)

  for (const colIndex of usedParameterColumns) {
    const paramName = getCellValue(sheet, 1, colIndex) || `Paramètre ${colIndex - 1}`
    const frequenceCell = getCellValue(sheet, 3, colIndex) // Ligne 4 (index 3)

    if (frequenceCell !== expectedFrequence) {
      errors.push({
        message: `Le champ 'frequence' (cellule ${String.fromCodePoint(65 + colIndex)}4 de l'onglet '${currentSheet}') a été modifié pour le paramètre '${paramName}'. Attendu : '${expectedFrequence}', trouvé : '${frequenceCell}'`,
        destinataire: 'déclarant'
      })
    }
  }
}

// Fonction pour déterminer si la fréquence est inférieure à un jour
function isFrequencyLessThanOneDay(frequency) {
  const frequenciesLessThanOneDay = ['15 minutes', 'heure', 'minute', 'seconde']
  return frequenciesLessThanOneDay.includes(frequency)
}

function getDataRows(sheet, context) {
  const {currentSheet, errorCollector} = context
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
    const date = parseExcelDate(dateCellValue)
    if (!date && dateCellValue) {
      const dateCellAddress = XLSX.utils.encode_cell({c: 0, r: rowNum})
      errorCollector.addError('invalidDates', currentSheet, dateCellAddress)
    }

    const heure = parseExcelDate(heureCellValue)
    if (!heure && heureCellValue) {
      const heureCellAddress = XLSX.utils.encode_cell({c: 1, r: rowNum})
      errorCollector.addError('invalidTimes', currentSheet, heureCellAddress)
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

function combineDateAndTime(date, time) {
  if (date instanceof Date && time instanceof Date) {
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      time.getHours(),
      time.getMinutes(),
      time.getSeconds()
    )
  }

  return null
}

function validateParameterData(dataRows, paramIndex, paramName, context, sheetName) {
  const {errors, errorCollector} = context
  const sheet = context.workbook.Sheets[sheetName]

  // Obtenir la fréquence depuis le nom de l'onglet
  const frequenceFromSheetName = getFrequenceFromSheetName(sheetName)

  // Obtenir la fréquence depuis la cellule du paramètre
  const frequency = getCellValue(sheet, 3, paramIndex) // Ligne index 3 (ligne 4)

  // Déterminer la fréquence à utiliser
  let frequence
  if (frequenceFromSheetName) {
    frequence = frequenceFromSheetName
    // Vérifier si la fréquence du paramètre est différente
    if (frequency !== frequenceFromSheetName) {
      const cellAddress = XLSX.utils.encode_cell({c: paramIndex, r: 3})
      errors.push({
        message: `Le champ 'frequence' (cellule ${cellAddress} de l'onglet '${sheetName}') ne correspond pas à la fréquence de l'onglet. Attendu : '${frequenceFromSheetName}', trouvé : '${frequency}' pour le paramètre '${paramName}'`,
        destinataire: 'déclarant'
      })
    }
  } else {
    frequence = frequency
  }

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

function validateTimeStepConsistency(context, dataRows, paramIndex, sheetName) {
  const {errors} = context
  const sheet = context.workbook.Sheets[sheetName]

  // Obtenir la fréquence depuis le nom de l'onglet
  const frequenceFromSheetName = getFrequenceFromSheetName(sheetName)

  // Obtenir la fréquence depuis la cellule du paramètre
  const frequenceFromParameter = getCellValue(sheet, 3, paramIndex) // Ligne 4 (index 3)

  let frequence
  if (frequenceFromSheetName) {
    frequence = frequenceFromSheetName
    // Vérifier si la fréquence du paramètre est différente
    if (frequenceFromParameter && frequenceFromParameter !== frequenceFromSheetName) {
      const paramName = getCellValue(sheet, 1, paramIndex) || `Paramètre ${paramIndex - 1}`
      const cellAddress = XLSX.utils.encode_cell({c: paramIndex, r: 3})
      errors.push({
        message: `Le champ 'frequence' (cellule ${cellAddress} de l'onglet '${sheetName}') ne correspond pas à la fréquence de l'onglet. Attendu : '${frequenceFromSheetName}', trouvé : '${frequenceFromParameter}' pour le paramètre '${paramName}'.`,
        destinataire: 'déclarant'
      })
    }
  } else {
    frequence = frequenceFromParameter
  }

  if (!frequence) {
    // Impossible de déterminer la fréquence
    errors.push({
      message: `La fréquence pour le paramètre dans l'onglet '${sheetName}' ne peut pas être déterminée.`,
      destinataire: 'déclarant'
    })
    return
  }

  const dateTimes = dataRows.map(row => {
    const {date} = row
    const {heure} = row
    const valeur = row.values[paramIndex]
    if (valeur !== null && valeur !== '' && date) {
      let dateTime
      if (isFrequencyLessThanOneDay(frequence)) {
        if (heure) {
          dateTime = combineDateAndTime(date, heure)
        } else {
          // 'heure' manquante mais requise pour cette fréquence
          return null
        }
      } else {
        dateTime = date
      }

      // Vérifier si dateTime est valide
      if (dateTime instanceof Date && !Number.isNaN(dateTime)) {
        return dateTime
      }
    }

    return null
  }).filter(dateTime => dateTime !== null)

  if (dateTimes.length < 2) {
    // Pas assez de données pour vérifier la cohérence
    return
  }

  // Calculer les différences de temps entre les entrées consécutives
  const timeDiffs = []
  for (let i = 1; i < dateTimes.length; i++) {
    const diffMs = dateTimes[i] - dateTimes[i - 1]
    timeDiffs.push({
      previousRow: dataRows[i - 1].rowNum + 1, // Ligne précédente
      currentRow: dataRows[i].rowNum + 1, // Ligne actuelle
      diffMs
    })
  }

  const expectedDiffMs = getExpectedTimeDifference(frequence)

  if (!expectedDiffMs) {
    // Impossible de déterminer la différence de temps attendue
    errors.push({
      message: `La fréquence '${frequence}' dans l'onglet '${sheetName}' n'est pas reconnue pour le paramètre.`,
      destinataire: 'déclarant'
    })
    return
  }

  // Définir une tolérance pour les écarts (par exemple, 1 seconde)
  const toleranceMs = 1000

  // Limiter le nombre d'erreurs pour éviter une surcharge
  const maxErrors = 10
  let errorCount = 0

  for (const {previousRow, currentRow, diffMs} of timeDiffs) {
    const paramName = getCellValue(sheet, 1, paramIndex) || `Paramètre ${paramIndex - 1}`
    if (Math.abs(diffMs - expectedDiffMs) > toleranceMs) {
      if (errorCount < maxErrors) {
        const expectedTime = formatTimeDifference(expectedDiffMs)
        const actualTime = formatTimeDifference(diffMs)
        errors.push({
          message: `Dans l'onglet '${sheetName}', pour le paramètre '${paramName}', l'intervalle entre les lignes ${previousRow} et ${currentRow} est de ${actualTime}, attendu : ${expectedTime}.`,
          destinataire: 'déclarant'
        })
        errorCount++
      } else {
        // Ajouter un résumé si trop d'erreurs
        errors.push({
          message: `Dans l'onglet '${sheetName}', pour le paramètre '${paramName}', plus de ${maxErrors} écarts de temps ont été détectés par rapport à la fréquence '${frequence}'. Veuillez vérifier les données.`,
          destinataire: 'déclarant'
        })
        break
      }
    }
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

function getFrequenceFromSheetName(sheetName) {
  if (sheetName.includes('15 minutes')) {
    return '15 minutes'
  }

  if (sheetName.includes('1 jour')) {
    return 'jour'
  }

  if (sheetName.includes('1 trimestre')) {
    return 'trimestre'
  }

  if (sheetName.includes('autre')) {
    return null // La fréquence devra être récupérée au niveau du paramètre
  }

  return null
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
