// Utilities for frequency normalization and classification in multi-params parser
// Centralize logic shared between tab parsing (data.js) and consolidation (index.js)

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

    default: {
      // We ignore for now other frequencies (mois, trimestre, année, autre)
      return undefined
    }
  }
}

export function isSubDailyFrequency(frequency) {
  return ['15 minutes', '1 hour', '1 minute', '1 second'].includes(frequency)
}
