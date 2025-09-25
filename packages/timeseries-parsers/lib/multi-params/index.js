import {pick, minBy, maxBy} from 'lodash-es'

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
    consolidatedData = consolidateData(data)
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

function consolidateData(rawData) {
  const pointPrelevement = safeParsePointPrelevement(rawData.metadata.pointPrelevement)
  const dailyDataTab = rawData.dataTabs.find(tab => tab.period === '1 jour' && tab.hasData)
  const fifteenMinutesDataTab = rawData.dataTabs.find(tab => tab.period === '15 minutes' && tab.hasData)

  if (!dailyDataTab) {
    throw new Error('Le fichier ne contient pas de données à la maille journalière')
  }

  const series = []

  for (const param of dailyDataTab.parameters) {
    buildSeriesForParam({
      param,
      rowsSource: dailyDataTab.rows,
      pointPrelevement,
      frequency: '1 day',
      series
    })
  }

  if (fifteenMinutesDataTab) {
    for (const param of fifteenMinutesDataTab.parameters) {
      buildSeriesForParam({
        param,
        rowsSource: fifteenMinutesDataTab.rows,
        pointPrelevement,
        frequency: '15 minutes',
        series,
        expectsTime: true
      })
    }
  }

  const hasVolumeDaily = series.some(s => s.parameter === 'volume prélevé' && s.frequency === '1 day')
  if (!hasVolumeDaily) {
    throw new Error('Le fichier ne contient pas de données de volume prélevé')
  }

  return {series}
}

function mapTypeToValueType(type) {
  switch (type) {
    case 'valeur brute': {
      return 'instantaneous'
    }

    case 'moyenne': {
      return 'average'
    }

    case 'minimum': {
      return 'minimum'
    }

    case 'maximum': {
      return 'maximum'
    }

    case 'médiane': {
      return 'median'
    }

    case 'différence d’index': {
      return 'delta-index'
    }

    default: {
      return 'raw'
    }
  }
}

function buildSeriesForParam({param, rowsSource, pointPrelevement, frequency, series, expectsTime = false}) {
  const {paramIndex, nom_parametre, type, unite, detail_point_suivi, profondeur, remarque} = param
  const rows = []
  for (const row of rowsSource) {
    if (!row.date) {
      continue
    }

    if (expectsTime && !row.heure) {
      continue
    }

    const value = row.values[paramIndex]
    if (value === null || value === undefined) {
      continue
    }

    const entry = {date: row.date, value}
    if (expectsTime) {
      const timeStr = row.heure.length === 5 ? row.heure : row.heure.slice(0, 5)
      entry.time = timeStr
    }

    if (row.remarque) {
      entry.remark = row.remarque
    }

    rows.push(entry)
  }

  if (rows.length === 0) {
    return
  }

  const seriesObj = {
    pointPrelevement,
    parameter: nom_parametre,
    unit: unite,
    frequency,
    valueType: nom_parametre === 'volume prélevé' ? 'cumulative' : mapTypeToValueType(type),
    minDate: minBy(rows, 'date').date,
    maxDate: maxBy(rows, 'date').date,
    data: rows
  }

  const extras = {}
  if (detail_point_suivi) {
    extras.detailPointSuivi = detail_point_suivi
  }

  if (typeof profondeur === 'number') {
    extras.profondeur = profondeur
  }

  if (remarque) {
    extras.commentaire = remarque
  }

  if (Object.keys(extras).length > 0) {
    seriesObj.extras = extras
  }

  series.push(seriesObj)
}

function safeParsePointPrelevement(value) {
  try {
    return parsePointPrelevement(value)
  } catch {
    return undefined
  }
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
