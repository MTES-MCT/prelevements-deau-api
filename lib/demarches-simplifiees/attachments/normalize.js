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

    // 3. Conversion d'unités et filtrage des valeurs invalides
    const {parameter, unit, data} = newSeries
    const convertedData = []
    let targetUnit
    let invalidValuesCount = 0

    for (const row of data) {
      const {targetUnit: tUnit, targetValue, isValid} = convertToReferenceValue(parameter, unit, row.value)

      // Si la valeur est invalide, on la filtre mais on continue le traitement
      if (!isValid) {
        invalidValuesCount++
        continue
      }

      // Vérifier la cohérence de l'unité cible
      if (!targetUnit) {
        targetUnit = tUnit
      } else if (targetUnit !== tUnit) {
        // Incohérence d'unité : cela ne devrait pas arriver
        // On rejette la série entière car c'est une erreur de configuration
        invalidValuesCount = data.length
        break
      }

      // Convertir ou conserver la valeur selon l'unité
      if (targetUnit === unit) {
        convertedData.push(row)
      } else {
        convertedData.push({
          ...row,
          value: targetValue,
          originalValue: row.originalValue ?? row.value,
          originalUnit: unit
        })
      }
    }

    // Si toutes les valeurs sont invalides, on rejette la série
    if (invalidValuesCount === data.length) {
      continue
    }

    // Mettre à jour les données avec les valeurs filtrées et converties
    if (targetUnit && targetUnit !== unit) {
      newSeries.unit = targetUnit
      newSeries.data = convertedData
    } else if (convertedData.length < data.length) {
      // Certaines valeurs ont été filtrées mais pas de conversion d'unité
      newSeries.data = convertedData
    }

    // Recalculer minDate/maxDate si des valeurs ont été filtrées
    if (convertedData.length > 0 && convertedData.length < data.length) {
      newSeries.minDate = minBy(convertedData, 'date').date
      newSeries.maxDate = maxBy(convertedData, 'date').date
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
 * Agrège plusieurs séries en sommant les valeurs par date.
 * Important : ne conserve que les points temporels où TOUTES les séries ont une valeur valide.
 * Si une source manque à un instant T, le point est rejeté pour éviter de sous-estimer le débit total.
 *
 * @param {Array} seriesGroup - Groupe de séries à agréger
 * @returns {Object} Série agrégée
 */
function aggregateMultipleSeries(seriesGroup) {
  const baseSerie = seriesGroup[0]
  const expectedSourceCount = seriesGroup.length

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

  // Filtrer pour ne garder que les points avec TOUTES les sources présentes
  const completeDataPoints = [...dataByDate.values()].filter(
    entry => entry.sources.length === expectedSourceCount
  )

  // Trier par date
  const aggregatedData = completeDataPoints.sort((a, b) => {
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
