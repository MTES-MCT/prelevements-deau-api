import {getDaysInMonth, addDays, parseISO, formatISO, isLeapYear} from 'date-fns'
import {minBy, maxBy, groupBy} from 'lodash-es'
import {convertToReferenceValue} from '@fabnum/prelevements-deau-timeseries-parsers'
import {parametersConfig} from '../../parameters-config.js'

export function normalizeSeries(series) {
  if (!series || series.length === 0) {
    return []
  }

  const normalizedSeries = []

  for (const s of series) {
    // 1. Désagrégation des données cumulatives supra-journalières
    const expandedData = expandSeriesDataIfNeeded(s)

    // 2. Mise à jour de la série avec les données potentiellement expansées
    const newSeries = {
      ...s,
      data: expandedData
    }

    // Si les données ont été expansées, on met à jour la fréquence et on garde l'originale
    if (expandedData !== s.data) {
      newSeries.originalFrequency = s.frequency
      newSeries.frequency = '1 day'
      if (expandedData.length > 0) {
        newSeries.minDate = minBy(expandedData, 'date').date
        newSeries.maxDate = maxBy(expandedData, 'date').date
      }
    }

    // 3. Conversion d'unités
    const {parameter, unit, data} = newSeries
    const convertedData = []
    let conversionFailed = false
    let targetUnit

    for (const row of data) {
      const {targetUnit: tUnit, targetValue, isValid} = convertToReferenceValue(parameter, unit, row.value)

      if (!isValid) {
        conversionFailed = true
        break
      }

      if (!targetUnit) {
        targetUnit = tUnit
      } else if (targetUnit !== tUnit) {
        conversionFailed = true
        break
      }

      if (targetUnit !== unit) {
        convertedData.push({
          ...row,
          value: targetValue,
          originalValue: row.originalValue ?? row.value,
          originalUnit: unit
        })
      }
    }

    // Ne mettre à jour l'unité et les données que si une conversion a eu lieu
    // (targetUnit !== unit signifie qu'une conversion était nécessaire)
    if (!conversionFailed && targetUnit && targetUnit !== unit) {
      newSeries.unit = targetUnit
      newSeries.data = convertedData
    } else if (conversionFailed) {
      // Si la conversion a échoué, on ne conserve pas la série
      continue
    }

    normalizedSeries.push(newSeries)
  }

  // 4. Agrégation des débits pour un même point de prélèvement
  return aggregateFlowSeries(normalizedSeries)
}

export function expandSeriesDataIfNeeded(series) {
  const {parameter, frequency, data} = series

  if (!isCumulativeParameter(parameter) || !isSuperDailyFrequency(frequency)) {
    return data
  }

  const expandedRows = []
  for (const row of data) {
    const dailyRows = expandToDaily(row, frequency)
    expandedRows.push(...dailyRows)
  }

  return expandedRows
}

/**
 * Helpers pour la gestion des fréquences
 * Note: Copiés depuis timeseries-parsers/lib/multi-params/frequency.js
 * Duplication intentionnelle pour éviter un couplage fort entre le parser et le consommateur.
 * Ces fonctions sont simples et stables, la duplication est acceptable.
 */

function isSuperDailyFrequency(frequency) {
  return ['1 month', '1 quarter', '1 year'].includes(frequency)
}

function isCumulativeParameter(parameterName) {
  const config = parametersConfig[parameterName]
  return config?.valueType === 'cumulative'
}

function getDaysInPeriod(startDate, frequency) {
  const date = parseISO(startDate)

  if (frequency === '1 month') {
    return getDaysInMonth(date)
  }

  if (frequency === '1 quarter') {
    // Un trimestre = 3 mois consécutifs
    const month = date.getMonth()
    const quarterStartMonth = Math.floor(month / 3) * 3

    let totalDays = 0
    for (let i = 0; i < 3; i++) {
      const monthDate = new Date(date.getFullYear(), quarterStartMonth + i, 1)
      totalDays += getDaysInMonth(monthDate)
    }

    return totalDays
  }

  if (frequency === '1 year') {
    return isLeapYear(date) ? 366 : 365
  }

  throw new Error(`Fréquence non supportée pour getDaysInPeriod: ${frequency}`)
}

function generateDatesInPeriod(startDate, dayCount) {
  const dates = []
  const baseDate = parseISO(startDate)

  for (let i = 0; i < dayCount; i++) {
    const currentDate = addDays(baseDate, i)
    dates.push(formatISO(currentDate, {representation: 'date'}))
  }

  return dates
}

export function expandToDaily(row, frequency) {
  if (!isSuperDailyFrequency(frequency)) {
    throw new Error(`expandToDaily ne peut être utilisé qu'avec des fréquences > 1 jour, reçu: ${frequency}`)
  }

  const dayCount = getDaysInPeriod(row.date, frequency)
  const dailyValue = row.value / dayCount
  const dates = generateDatesInPeriod(row.date, dayCount)

  return dates.map(date => ({
    date,
    value: dailyValue,
    originalValue: row.value,
    originalDate: row.date,
    originalFrequency: frequency,
    daysCovered: dayCount,
    ...(row.remark ? {remark: row.remark} : {})
  }))
}

/**
 * Agrège les séries de débits pour un même point de prélèvement
 * @param {Array} series - Liste des séries normalisées
 * @returns {Array} Séries avec débits agrégés par point
 */
export function aggregateFlowSeries(series) {
  const flowParameters = new Set(['débit prélevé', 'débit restitué', 'débit réservé'])

  // Séparer les séries de débit des autres
  const flowSeries = series.filter(s => flowParameters.has(s.parameter))
  const otherSeries = series.filter(s => !flowParameters.has(s.parameter))

  // Grouper par point de prélèvement, paramètre, fréquence et unité
  const groupedByPointAndParam = groupBy(flowSeries, s =>
    `${s.pointPrelevement}|${s.parameter}|${s.frequency}|${s.unit}`
  )

  // Agréger les séries de chaque groupe
  const aggregatedFlowSeries = []

  for (const seriesGroup of Object.values(groupedByPointAndParam)) {
    if (seriesGroup.length === 1) {
      // Pas d'agrégation nécessaire
      aggregatedFlowSeries.push(seriesGroup[0])
    } else {
      // Agréger les séries
      const aggregated = aggregateMultipleSeries(seriesGroup)
      aggregatedFlowSeries.push(aggregated)
    }
  }

  return [...otherSeries, ...aggregatedFlowSeries]
}

/**
 * Agrège plusieurs séries en sommant les valeurs par date
 * @param {Array} seriesGroup - Groupe de séries à agréger
 * @returns {Object} Série agrégée
 */
function aggregateMultipleSeries(seriesGroup) {
  const baseSerie = seriesGroup[0]

  // Collecter toutes les données par date
  const dataByDate = new Map()

  for (const serie of seriesGroup) {
    for (const dataPoint of serie.data) {
      const dateKey = dataPoint.time ? `${dataPoint.date}|${dataPoint.time}` : dataPoint.date

      if (!dataByDate.has(dateKey)) {
        dataByDate.set(dateKey, {
          date: dataPoint.date,
          ...(dataPoint.time ? {time: dataPoint.time} : {}),
          value: 0,
          sources: []
        })
      }

      const entry = dataByDate.get(dateKey)
      entry.value += dataPoint.value
      entry.sources.push({
        originalValue: dataPoint.originalValue ?? dataPoint.value,
        ...(dataPoint.originalUnit ? {originalUnit: dataPoint.originalUnit} : {})
      })
    }
  }

  // Convertir en tableau et trier par date
  const aggregatedData = [...dataByDate.values()].sort((a, b) => {
    const dateCompare = a.date.localeCompare(b.date)
    if (dateCompare !== 0) {
      return dateCompare
    }

    if (a.time && b.time) {
      return a.time.localeCompare(b.time)
    }

    return 0
  })

  // Créer la série agrégée
  // Note: on conserve les métadonnées d'identification communes (pointPrelevement, parameter, unit, frequency)
  // depuis baseSerie. Les champs extras sont omis car ils sont spécifiques à chaque série individuelle.
  // minDate/maxDate sont recalculés depuis aggregatedData.
  const {extras, minDate, maxDate, ...baseFields} = baseSerie

  return {
    ...baseFields,
    data: aggregatedData,
    minDate: aggregatedData.length > 0 ? minBy(aggregatedData, 'date').date : undefined,
    maxDate: aggregatedData.length > 0 ? maxBy(aggregatedData, 'date').date : undefined,
    aggregated: true,
    sourceCount: seriesGroup.length
  }
}
