import {getDaysInMonth, addDays, parseISO, formatISO, isLeapYear} from 'date-fns'
import {minBy, maxBy} from 'lodash-es'
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
      newSeries.minDate = minBy(expandedData, 'date').date
      newSeries.maxDate = maxBy(expandedData, 'date').date
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

    if (!conversionFailed && targetUnit && targetUnit !== unit) {
      newSeries.unit = targetUnit
      newSeries.data = convertedData
    }

    normalizedSeries.push(newSeries)
  }

  return normalizedSeries
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

/* Helpers copiés de timeseries-parsers/lib/multi-params/frequency.js */

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
