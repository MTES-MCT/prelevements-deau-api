/**
 * Fréquences d'agrégation disponibles
 *
 * IMPORTANT : Ces valeurs doivent être synchronisées avec :
 * - docs/openapi.yaml (enum du paramètre aggregationFrequency)
 * - docs/aggregation-series.md (section "Fréquences d'agrégation disponibles")
 */
export const SUB_DAILY_FREQUENCIES = ['15 minutes', '1 hour', '6 hours']
export const DAILY_FREQUENCY = '1 day'
export const SUPER_DAILY_FREQUENCIES = ['1 month', '1 quarter', '1 year']
export const ALL_FREQUENCIES = [...SUB_DAILY_FREQUENCIES, DAILY_FREQUENCY, ...SUPER_DAILY_FREQUENCIES]

/**
 * Fréquences disponibles pour les paramètres cumulatifs (expansés à 1 day minimum)
 */
const CUMULATIVE_FREQUENCIES = [DAILY_FREQUENCY, ...SUPER_DAILY_FREQUENCIES]

/**
 * Configuration des paramètres de mesure et leurs opérateurs d'agrégation disponibles.
 *
 * Chaque paramètre définit :
 * - valueType : type de valeur ('cumulative' ou 'instantaneous')
 * - spatialOperators : opérateurs disponibles pour l'agrégation spatiale (multi-points)
 * - temporalOperators : opérateurs disponibles pour l'agrégation temporelle (changement de maille)
 * - defaultSpatialOperator : opérateur par défaut pour agrégation spatiale
 * - defaultTemporalOperator : opérateur par défaut pour agrégation temporelle
 * - availableFrequencies : fréquences d'agrégation disponibles pour ce paramètre
 * - unit : unité standard (optionnel, à titre informatif)
 * - warning : avertissement sur les calculs (optionnel)
 *
 * Note : Les clés doivent correspondre exactement aux valeurs du champ 'parameter'
 * stockées dans la collection 'series'.
 */

export const parametersConfig = {
  'volume prélevé': {
    valueType: 'cumulative',
    spatialOperators: ['sum'],
    temporalOperators: ['sum'],
    defaultSpatialOperator: 'sum',
    defaultTemporalOperator: 'sum',
    availableFrequencies: CUMULATIVE_FREQUENCIES,
    unit: 'm³'
  },
  'volume restitué': {
    valueType: 'cumulative',
    spatialOperators: ['sum'],
    temporalOperators: ['sum'],
    defaultSpatialOperator: 'sum',
    defaultTemporalOperator: 'sum',
    availableFrequencies: CUMULATIVE_FREQUENCIES,
    unit: 'm³'
  },
  'débit prélevé': {
    valueType: 'instantaneous',
    spatialOperators: ['sum'],
    temporalOperators: ['mean', 'min', 'max'],
    defaultSpatialOperator: 'sum',
    defaultTemporalOperator: 'mean',
    availableFrequencies: ALL_FREQUENCIES,
    unit: 'L/s'
  },
  'débit réservé': {
    valueType: 'instantaneous',
    spatialOperators: ['sum'],
    temporalOperators: ['mean', 'min', 'max'],
    defaultSpatialOperator: 'sum',
    defaultTemporalOperator: 'min',
    availableFrequencies: ALL_FREQUENCIES,
    unit: 'L/s'
  },
  'débit restitué': {
    valueType: 'instantaneous',
    spatialOperators: ['sum'],
    temporalOperators: ['mean', 'min', 'max'],
    defaultSpatialOperator: 'sum',
    defaultTemporalOperator: 'mean',
    availableFrequencies: ALL_FREQUENCIES,
    unit: 'L/s'
  },
  température: {
    valueType: 'instantaneous',
    spatialOperators: [],
    temporalOperators: ['mean', 'min', 'max'],
    defaultSpatialOperator: null,
    defaultTemporalOperator: 'mean',
    availableFrequencies: ALL_FREQUENCIES,
    unit: '°C'
  },
  'niveau piézométrique': {
    valueType: 'instantaneous',
    spatialOperators: [],
    temporalOperators: ['mean', 'min', 'max'],
    defaultSpatialOperator: null,
    defaultTemporalOperator: 'mean',
    availableFrequencies: ALL_FREQUENCIES,
    unit: 'm NGR'
  },
  chlorures: {
    valueType: 'instantaneous',
    spatialOperators: [],
    temporalOperators: ['mean', 'min', 'max'],
    defaultSpatialOperator: null,
    defaultTemporalOperator: 'mean',
    availableFrequencies: ALL_FREQUENCIES,
    unit: 'mg/L'
  },
  nitrates: {
    valueType: 'instantaneous',
    spatialOperators: [],
    temporalOperators: ['mean', 'min', 'max'],
    defaultSpatialOperator: null,
    defaultTemporalOperator: 'mean',
    availableFrequencies: ALL_FREQUENCIES,
    unit: 'mg/L'
  },
  sulfates: {
    valueType: 'instantaneous',
    spatialOperators: [],
    temporalOperators: ['mean', 'min', 'max'],
    defaultSpatialOperator: null,
    defaultTemporalOperator: 'mean',
    availableFrequencies: ALL_FREQUENCIES,
    unit: 'mg/L'
  },
  turbidité: {
    valueType: 'instantaneous',
    spatialOperators: [],
    temporalOperators: ['mean', 'min', 'max'],
    defaultSpatialOperator: null,
    defaultTemporalOperator: 'mean',
    availableFrequencies: ALL_FREQUENCIES,
    unit: 'FTU'
  },
  conductivité: {
    valueType: 'instantaneous',
    spatialOperators: [],
    temporalOperators: ['mean', 'min', 'max'],
    defaultSpatialOperator: null,
    defaultTemporalOperator: 'mean',
    availableFrequencies: ALL_FREQUENCIES,
    unit: 'µS/cm'
  },
  pH: {
    valueType: 'instantaneous',
    spatialOperators: [],
    temporalOperators: ['mean', 'min', 'max'],
    defaultSpatialOperator: null,
    defaultTemporalOperator: 'mean',
    availableFrequencies: ALL_FREQUENCIES,
    unit: '',
    warning: 'La moyenne arithmétique du pH (échelle logarithmique) est une approximation'
  }
}

/**
 * Vérifie si un paramètre est supporté pour l'agrégation.
 * @param {string} parameter - Nom du paramètre
 * @returns {boolean}
 */
export function isParameterSupported(parameter) {
  return parameter in parametersConfig
}

/**
 * Retourne les opérateurs disponibles pour un paramètre selon le contexte.
 * @param {string} parameter - Nom du paramètre
 * @param {string} [context='spatial'] - Contexte d'agrégation ('spatial' ou 'temporal')
 * @returns {string[]|null} - Array d'opérateurs (vide si aucun disponible), ou null si paramètre inconnu
 */
export function getAvailableOperators(parameter, context = 'spatial') {
  const config = parametersConfig[parameter]
  if (!config) {
    return null
  }

  return context === 'temporal'
    ? config.temporalOperators
    : config.spatialOperators
}

/**
 * Retourne l'opérateur par défaut pour un paramètre selon le contexte.
 * @param {string} parameter - Nom du paramètre
 * @param {string} [context='spatial'] - Contexte d'agrégation ('spatial' ou 'temporal')
 * @returns {string|null}
 */
export function getDefaultOperator(parameter, context = 'spatial') {
  const config = parametersConfig[parameter]
  if (!config) {
    return null
  }

  return context === 'temporal'
    ? config.defaultTemporalOperator || null
    : config.defaultSpatialOperator || null
}

/**
 * Retourne le valueType d'un paramètre.
 * @param {string} parameter - Nom du paramètre
 * @returns {string|null} - 'cumulative', 'instantaneous' ou null
 */
export function getParameterValueType(parameter) {
  return parametersConfig[parameter]?.valueType || null
}

/**
 * Vérifie si un opérateur est valide pour un paramètre donné selon le contexte.
 * @param {string} parameter - Nom du paramètre
 * @param {string} operator - Opérateur d'agrégation
 * @param {string} [context='spatial'] - Contexte d'agrégation ('spatial' ou 'temporal')
 * @returns {boolean}
 */
export function isOperatorValidForParameter(parameter, operator, context = 'spatial') {
  const operators = getAvailableOperators(parameter, context)
  return operators ? operators.includes(operator) : false
}

/**
 * Valide qu'un opérateur peut être utilisé pour un paramètre donné selon le contexte.
 * Lance une erreur si le paramètre n'est pas supporté ou l'opérateur invalide.
 * @param {string} parameter - Nom du paramètre
 * @param {string} operator - Opérateur d'agrégation
 * @param {string} [context='spatial'] - Contexte d'agrégation ('spatial' ou 'temporal')
 * @throws {Error} Si le paramètre n'est pas supporté ou l'opérateur invalide
 */
export function validateOperatorForParameter(parameter, operator, context = 'spatial') {
  if (!isParameterSupported(parameter)) {
    throw new Error(`Paramètre non supporté pour l'agrégation: ${parameter}`)
  }

  if (!isOperatorValidForParameter(parameter, operator, context)) {
    const available = getAvailableOperators(parameter, context)
    const contextLabel = context === 'temporal' ? 'temporelle' : 'spatiale'

    if (!available || available.length === 0) {
      throw new Error(
        `Le paramètre '${parameter}' ne supporte pas l'agrégation ${contextLabel}.`
      )
    }

    throw new Error(
      `Opérateur '${operator}' non disponible pour le paramètre '${parameter}' en agrégation ${contextLabel}. `
      + `Opérateurs disponibles: ${available.join(', ')}`
    )
  }
}
