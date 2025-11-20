// Utilities for frequency normalization and classification in multi-params parser
// Centralize logic shared between tab parsing (data.js) and consolidation (index.js)

/**
 * Normalise les fréquences d'entrée (labels français) vers des tokens de fréquence standardisés.
 * Gère toutes les variantes possibles ('1 heure', 'heure', '1heure', etc.)
 *
 * @param {string} freq Fréquence brute depuis les métadonnées
 * @returns {string|undefined} Token de fréquence normalisé ou undefined si non supporté
 */
export function normalizeOutputFrequency(freq) {
  if (!freq) {
    return undefined
  }

  // Normaliser les espaces pour gérer '1heure', '1 heure', etc.
  const normalized = freq.toLowerCase().trim()
    .replace(/1\s*heure/, 'heure')
    .replace(/1\s*minute/, 'minute')
    .replace(/1\s*seconde/, 'seconde')
    .replace(/1\s*jour/, 'jour')
    .replace(/1\s*mois/, 'mois')
    .replace(/1\s*trimestre/, 'trimestre')
    .replace(/1\s*année/, 'année')
    .replace(/15\s*m(in|n)?$/, '15 minutes')

  switch (normalized) {
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

    case 'jour': {
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

