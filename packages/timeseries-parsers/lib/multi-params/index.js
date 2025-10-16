import {pick, minBy, maxBy, sumBy, groupBy, mapValues, filter, sortBy} from 'lodash-es'

import {readSheet} from '../xlsx.js'

import {validateAndExtract as validateAndExtractMetadata} from './tabs/metadata.js'
import {validateAndExtract as validateAndExtractData} from './tabs/data.js'

export async function validateMultiParamFile(buffer) {
  let workbook

  try {
    workbook = await readSheet(buffer)

    // On valide la structure du tableur
    validateStructure(workbook)
  } catch (error) {
    return {errors: [formatError(error)]}
  }

  const data = {dataTabs: []}
  const errors = []

  /* On traite l'onglet A LIRE */

  const metadataSheet = workbook.Sheets['A LIRE']
  const metadataResult = validateAndExtractMetadata(metadataSheet)

  errors.push(...metadataResult.errors)
  data.metadata = metadataResult.data

  /* On traite les onglets de données */

  const dataSheetNames = extractDataSheetNames(workbook)
  const dataSheets = dataSheetNames.map(name => ({name, sheet: workbook.Sheets[name]}))

  for (const dataSheet of dataSheets) {
    const dataSheetResult = validateAndExtractData(dataSheet)

    errors.push(...dataSheetResult.errors)
    data.dataTabs.push({...dataSheetResult.data, originalSheetName: dataSheet.name})
  }

  let consolidatedData

  try {
    consolidatedData = consolidateData(data, errors)
  } catch (error) {
    errors.push({message: error.message, severity: 'error'})
  }

  return {
    rawData: data,
    data: consolidatedData,
    errors: errors.map(e => formatError(e))
  }
}

/* Helpers */

function consolidateData(rawData, errors) {
  const data = {}

  try {
    data.pointPrelevement = parsePointPrelevement(rawData.metadata.pointPrelevement)
  } catch {}

  const dailyDataTab = rawData.dataTabs.find(tab => tab.period === '1 jour' && tab.hasData)
  const fifteenMinutesDataTab = rawData.dataTabs.find(tab => tab.period === '15 minutes' && tab.hasData)

  // Paramètres et valeurs journalières si présents, sinon listes vides
  if (dailyDataTab) {
    data.dailyParameters = dailyDataTab.parameters.map(p => pick(p, [
      'paramIndex',
      'nom_parametre',
      'type',
      'unite'
    ]))

    const dailyRowsWithDates = filter(dailyDataTab.rows, row => row.date)
    if (dailyRowsWithDates.length > 0) {
      data.minDate = minBy(dailyRowsWithDates, 'date').date
      data.maxDate = maxBy(dailyRowsWithDates, 'date').date
    }

    const volumePreleveParam = dailyDataTab.parameters.find(p => p.nom_parametre === 'volume prélevé')
    let sortedDailyRows = []
    if (volumePreleveParam) {
      sortedDailyRows = sortBy(
        filter(dailyRowsWithDates, row => typeof row.values[volumePreleveParam.paramIndex] === 'number'),
        'date'
      )
      data.volumePreleveTotal = sumBy(sortedDailyRows, row => row.values[volumePreleveParam.paramIndex])
    } else {
      sortedDailyRows = sortBy(dailyRowsWithDates, 'date')
      // Erreur non bloquante : volume manquant alors que des données journalières existent
      errors.push({message: 'Le fichier ne contient pas de données de volume prélevé', severity: 'error'})
    }

    data.dailyValues = sortedDailyRows.map(row => ({
      date: row.date,
      values: Object.values(pick(row.values, dailyDataTab.parameters.map(p => p.paramIndex)))
    }))
  } else {
    errors.push({message: 'Le fichier ne contient pas de données à la maille journalière', severity: 'error'})
    data.dailyParameters = []
    data.dailyValues = []
  }

  // Paramètres et valeurs 15 minutes indépendamment de la présence journalière
  if (fifteenMinutesDataTab) {
    data.fifteenMinutesParameters = fifteenMinutesDataTab.parameters.map(p => pick(p, [
      'paramIndex',
      'nom_parametre',
      'type',
      'unite'
    ]))

    const groupedByDate = groupBy(fifteenMinutesDataTab.rows, 'date')
    const fifteenMinutesDataByDate = mapValues(groupedByDate, rows =>
      rows.map(({heure, values}) => ({
        heure,
        values: Object.values(
          pick(values, fifteenMinutesDataTab.parameters.map(p => p.paramIndex))
        )
      }))
    )

    // Définir min/max si absent et données 15m présentes
    if (!data.minDate || !data.maxDate) {
      const rowsWithDates = filter(fifteenMinutesDataTab.rows, r => r.date)
      if (rowsWithDates.length > 0) {
        data.minDate ||= minBy(rowsWithDates, 'date').date
        data.maxDate ||= maxBy(rowsWithDates, 'date').date
      }
    }

    data.fifteenMinutesValues = Object.entries(fifteenMinutesDataByDate).map(([date, rows]) => ({date, rows}))
  } else {
    data.fifteenMinutesParameters = []
    data.fifteenMinutesValues = []
  }

  return data
}

function parsePointPrelevement(value) {
  if (/^\d+\s\|\s(.+)$/.test(value)) {
    return Number(value.split(' | ')[0].trim())
  }

  if (/^\d+\s-\s(.+)$/.test(value)) {
    return Number(value.split(' - ')[0].trim())
  }

  if (/^\d+\s(.+)$/.test(value)) {
    return Number(value.split(' ')[0].trim())
  }

  throw new Error(`Point de prélèvement invalide : ${value}`)
}

function extractDataSheetNames(workbook) {
  return workbook.SheetNames
    .filter(name => name
      .trim()
      .replaceAll(/\s+/g, ' ')
      .toLowerCase()
      .startsWith('data | t='))
}

function validateStructure(workbook) {
  if (!workbook.Sheets['A LIRE']) {
    throw new Error('L\'onglet \'A LIRE\' est manquant')
  }

  if (extractDataSheetNames(workbook).length === 0) {
    throw new Error('Aucun onglet \'Data | T=...\' n\'a été trouvé')
  }
}

function formatError(error) {
  return pick(error, [
    'message',
    'explanation',
    'internalMessage',
    'severity'
  ])
}
