import {pick, minBy, maxBy} from 'lodash-es'
import {isSubDailyFrequency, isCumulativeParameter} from './frequency.js'

import {readSheet} from '../xlsx.js'

import {validateAndExtract as validateAndExtractMetadata} from './tabs/metadata.js'
import {validateAndExtract as validateAndExtractData} from './tabs/data.js'
import {dedupe} from '../dedupe.js'

export {convertToReferenceValue} from './parameter.js'

export async function extractMultiParamFile(buffer) {
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

  const result = {
    rawData: data,
    data: consolidatedData,
    errors: errors.map(e => formatError(e))
  }

  return dedupe(result)
}

/* Helpers */

function consolidateData(rawData) {
  const pointPrelevement = safeParsePointPrelevement(rawData.metadata.pointPrelevement)
  const dailyDataTab = rawData.dataTabs.find(tab => tab.period === '1 jour' && tab.hasData)
  const fifteenMinutesDataTab = rawData.dataTabs.find(tab => tab.period === '15 minutes' && tab.hasData)
  const hourlyDataTab = rawData.dataTabs.find(tab => tab.period === '1 heure' && tab.hasData)
  const monthlyDataTab = rawData.dataTabs.find(tab => tab.period === '1 mois' && tab.hasData)
  const quarterlyDataTab = rawData.dataTabs.find(tab => tab.period === '1 trimestre' && tab.hasData)
  const otherDataTabs = rawData.dataTabs.filter(tab => tab.period === 'autre' && tab.hasData)

  const series = []

  if (dailyDataTab) {
    for (const param of dailyDataTab.parameters) {
      buildSeriesForParam({
        param,
        rowsSource: dailyDataTab.rows,
        pointPrelevement,
        frequency: '1 day',
        series
      })
    }
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

  if (hourlyDataTab) {
    for (const param of hourlyDataTab.parameters) {
      buildSeriesForParam({
        param,
        rowsSource: hourlyDataTab.rows,
        pointPrelevement,
        frequency: '1 hour',
        series,
        expectsTime: true
      })
    }
  }

  if (monthlyDataTab) {
    for (const param of monthlyDataTab.parameters) {
      buildSeriesForParam({
        param,
        rowsSource: monthlyDataTab.rows,
        pointPrelevement,
        frequency: '1 month',
        series
      })
    }
  }

  if (quarterlyDataTab) {
    for (const param of quarterlyDataTab.parameters) {
      buildSeriesForParam({
        param,
        rowsSource: quarterlyDataTab.rows,
        pointPrelevement,
        frequency: '1 quarter',
        series
      })
    }
  }

  // Onglets "autre" : la fréquence réelle vient du champ param.frequence
  if (otherDataTabs.length > 0) {
    for (const tab of otherDataTabs) {
      for (const param of tab.parameters) {
        // La fréquence est déjà normalisée par la fonction parse() dans data.js
        const frequency = param.frequence
        if (!frequency || frequency === 'autre') {
          // Fréquence inconnue / non supportée : ignorer silencieusement
          continue
        }

        const expectsTime = isSubDailyFrequency(frequency)
        buildSeriesForParam({
          param,
          rowsSource: tab.rows,
          pointPrelevement,
          frequency,
          series,
          expectsTime
        })
      }
    }
  }

  return {series}
}

// Frequency helpers moved to frequency.js

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

  // Déterminer si le paramètre est cumulatif
  const isCumulative = isCumulativeParameter(nom_parametre)
  const valueType = isCumulative ? 'cumulative' : mapTypeToValueType(type)

  const seriesObj = {
    pointPrelevement,
    parameter: nom_parametre,
    unit: unite,
    frequency,
    valueType,
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
