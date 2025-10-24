// Utilities for frequency normalization and classification in multi-params parser
// Centralize logic shared between tab parsing (data.js) and consolidation (index.js)

import {getDaysInMonth, addDays, parseISO, formatISO, isLeapYear} from 'date-fns'

// Map raw metadata frequency (French labels already normalized by data.js parse) to output frequency tokens
export function normalizeOutputFrequency(freq) {
  if (!freq) {
    return undefined
  }

  switch (freq) {
    case '15 minutes': {
      return '15 minutes'
    }

    case 'heure': {
      return '1 hour'
    }

    case 'minute': {
      return '1 minute'
    }

    case 'seconde': {
      return '1 second'
    }

    case 'jour':
    case '1 jour': {
      return '1 day'
    }

    case 'mois': {
      return '1 month'
    }

    case 'trimestre': {
      return '1 quarter'
    }

    case 'année': {
      return '1 year'
    }

    default: {
      // 'autre' is not supported
      return undefined
    }
  }
}

export function isSubDailyFrequency(frequency) {
  return ['15 minutes', '1 hour', '1 minute', '1 second'].includes(frequency)
}

export function isSuperDailyFrequency(frequency) {
  return ['1 month', '1 quarter', '1 year'].includes(frequency)
}

export function isCumulativeParameter(parameterName) {
  return parameterName === 'volume prélevé' || parameterName === 'volume restitué'
}

/**
 * Calcule le nombre de jours dans une période donnée.
 *
 * @param {string} startDate Date de début au format YYYY-MM-DD
 * @param {string} frequency Fréquence ('1 month', '1 quarter', '1 year')
 * @returns {number} Nombre de jours dans la période
 */
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

/**
 * Génère toutes les dates d'une période.
 *
 * @param {string} startDate Date de début au format YYYY-MM-DD
 * @param {number} dayCount Nombre de jours
 * @returns {Array<string>} Tableau de dates au format YYYY-MM-DD
 */
function generateDatesInPeriod(startDate, dayCount) {
  const dates = []
  const baseDate = parseISO(startDate)

  for (let i = 0; i < dayCount; i++) {
    const currentDate = addDays(baseDate, i)
    dates.push(formatISO(currentDate, {representation: 'date'}))
  }

  return dates
}

/**
 * Expanse une valeur mensuelle/trimestrielle/annuelle en valeurs journalières.
 *
 * @param {object} row Ligne de données {date, value, remark?}
 * @param {string} frequency Fréquence ('1 month', '1 quarter', '1 year')
 * @returns {Array<object>} Tableau de lignes journalières avec métadonnées
 */
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
