import {deburr} from 'lodash-es'
import {normalizeUnit} from './unit.js'

const DEBIT_UNITS = [
  {
    unit: 'L/s',
    isReference: true,
    min: 0,
    max: 15_000
  },
  {
    unit: 'm³/h',
    isReference: false,
    convertToReference(value) {
      return value / 3.6
    },
    min: 0,
    max: 60_000
  }
]

const VOLUME_UNITS = [
  {
    unit: 'm³',
    isReference: true,
    min: 0,
    max: 30_000_000
  }
]

const AVAILABLE_PARAMETERS = {
  chlorures: {
    units: [
      {
        unit: 'mg/L',
        isReference: true,
        min: 0.01,
        max: 1000
      }
    ]
  },
  conductivité: {
    aliases: ['conductivité électrique'],
    units: [
      {
        unit: 'µS/cm',
        isReference: true,
        min: 0.01,
        max: 2000
      }
    ]
  },
  'débit prélevé': {
    units: DEBIT_UNITS
  },
  'débit réservé': {
    units: DEBIT_UNITS
  },
  'débit restitué': {
    units: DEBIT_UNITS
  },
  nitrates: {
    units: [
      {
        unit: 'mg/L',
        isReference: true,
        min: 0,
        max: 500
      }
    ]
  },
  'niveau piézométrique': {
    aliases: ['niveau d’eau'],
    units: [
      {
        unit: 'm NGR',
        isReference: true,
        min: -200,
        max: 3000
      }
    ]
  },
  pH: {
    units: [
      {
        unit: 'autre',
        isReference: true,
        min: 4,
        max: 11
      }
    ]
  },
  'relevé d’index de compteur': {
    units: [
      {
        unit: 'm³',
        isReference: true,
        min: 0,
        max: 1_000_000_000
      }
    ]
  },
  sulfates: {
    units: [
      {
        unit: 'mg/L',
        isReference: true,
        min: 0.01,
        max: 5000
      }
    ]
  },
  température: {
    units: [
      {
        unit: 'degrés Celsius',
        isReference: true,
        min: 0.01,
        max: 40
      }
    ]
  },
  turbidité: {
    units: [
      {
        unit: 'autre',
        isReference: true,
        min: 0,
        max: 5000
      }
    ]
  },
  'volume prélevé': {
    units: VOLUME_UNITS
  },
  'volume restitué': {
    units: VOLUME_UNITS
  },
  autre: {
    units: [
      {
        unit: 'autre',
        isReference: true,
        min: undefined,
        max: undefined
      }
    ]
  }
}

/**
 * Normalise une chaîne de caractères pour comparaison insensible à la casse,
 * aux accents et aux variations typographiques.
 *
 * @param {string} str Chaîne à normaliser
 * @returns {string} Chaîne normalisée
 */
export function normalizeString(str) {
  if (!str) {
    return
  }

  return deburr(str) // Supprimer les accents
    // Supprimer les espaces superflus
    .trim()
    // Mettre en minuscules pour comparaison insensible à la casse
    .toLowerCase()
    // Remplacer les apostrophes typographiques par des apostrophes simples
    .replaceAll('’', '\'')
    // Supprimer les espaces consécutifs
    .replaceAll(/\s+/g, ' ')
}

/**
 * Construit un Map de formes normalisées vers le libellé canonique.
 * Inclut le paramètre lui-même et tous ses alias.
 */
const NORMALIZED_PARAMETERS_MAP = new Map()

for (const [canonical, config] of Object.entries(AVAILABLE_PARAMETERS)) {
  NORMALIZED_PARAMETERS_MAP.set(normalizeString(canonical), canonical)

  const aliases = config?.aliases ?? []
  for (const alias of aliases) {
    const normalizedAlias = normalizeString(alias)
    if (normalizedAlias) {
      NORMALIZED_PARAMETERS_MAP.set(normalizedAlias, canonical)
    }
  }
}

/**
 * Trouve le libellé canonique d'un paramètre depuis son nom ou un alias.
 *
 * @param {string} paramName Nom du paramètre ou alias depuis les métadonnées
 * @returns {string|undefined} Nom canonique du paramètre, ou undefined si non reconnu
 */
export function normalizeParameterName(paramName) {
  if (!paramName) {
    return
  }

  const normalized = normalizeString(paramName)

  if (!normalized) {
    return
  }

  return NORMALIZED_PARAMETERS_MAP.get(normalized)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isWithinBounds(value, {min, max}) {
  if (!isFiniteNumber(value)) {
    return false
  }

  if (min !== undefined && value < min) {
    return false
  }

  if (max !== undefined && value > max) {
    return false
  }

  return true
}

function getReferenceUnit(units) {
  return units.find(unit => unit.isReference)
}

export function getCanonicalParameterConfig(paramName) {
  const canonicalName = normalizeParameterName(paramName)
  if (!canonicalName) {
    return
  }

  return {
    canonicalName,
    config: AVAILABLE_PARAMETERS[canonicalName]
  }
}

export function convertToReferenceValue(paramName, sourceUnit, sourceValue) {
  const canonicalUnit = normalizeUnit(sourceUnit)
  const {canonicalName, config} = getCanonicalParameterConfig(paramName) ?? {}

  if (!canonicalName || !canonicalUnit || !config) {
    return {
      targetUnit: undefined,
      targetValue: undefined,
      isValid: false
    }
  }

  const unitConfig = config.units.find(unit => unit.unit === canonicalUnit)

  if (!unitConfig) {
    return {
      targetUnit: undefined,
      targetValue: undefined,
      isValid: false
    }
  }

  const referenceUnitConfig = getReferenceUnit(config.units)

  if (!referenceUnitConfig) {
    return {
      targetUnit: undefined,
      targetValue: undefined,
      isValid: false
    }
  }

  const isValueValidInSourceUnit = isWithinBounds(sourceValue, unitConfig)

  if (unitConfig.isReference) {
    const isValueValid = isValueValidInSourceUnit
    return {
      targetUnit: unitConfig.unit,
      targetValue: isFiniteNumber(sourceValue) ? sourceValue : undefined,
      isValid: isValueValid
    }
  }

  if (typeof unitConfig.convertToReference !== 'function') {
    return {
      targetUnit: undefined,
      targetValue: undefined,
      isValid: false
    }
  }

  const convertedValue = isFiniteNumber(sourceValue) ? unitConfig.convertToReference(sourceValue) : undefined
  const isValueValid = isValueValidInSourceUnit && isWithinBounds(convertedValue, referenceUnitConfig)

  return {
    targetUnit: referenceUnitConfig.unit,
    targetValue: convertedValue,
    isValid: isValueValid
  }
}
