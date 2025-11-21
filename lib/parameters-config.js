/**
 * Configuration des paramètres de mesure et leurs opérateurs d'agrégation disponibles.
 *
 * Chaque paramètre définit :
 * - valueType : type de valeur ('cumulative' ou 'instantaneous')
 * - spatialOperators : opérateurs disponibles pour l'agrégation spatiale (multi-points)
 * - temporalOperators : opérateurs disponibles pour l'agrégation temporelle (changement de maille)
 * - defaultSpatialOperator : opérateur par défaut pour agrégation spatiale
 * - defaultTemporalOperator : opérateur par défaut pour agrégation temporelle
 * - unit : unité standard (optionnel, à titre informatif)
 * - warning : avertissement sur les limites d'interprétation (optionnel)
 *
 * Note : Les clés doivent correspondre exactement aux valeurs du champ 'parameter'
 * stockées dans la collection 'series'.
 */

export const parametersConfig = {
  'volume prélevé': {
    valueType: 'cumulative',
    spatialOperators: ['sum', 'mean', 'min', 'max'],
    temporalOperators: ['sum'],
    defaultSpatialOperator: 'sum',
    defaultTemporalOperator: 'sum',
    unit: 'm³'
  },
  'volume restitué': {
    valueType: 'cumulative',
    spatialOperators: ['sum', 'mean', 'min', 'max'],
    temporalOperators: ['sum'],
    defaultSpatialOperator: 'sum',
    defaultTemporalOperator: 'sum',
    unit: 'm³'
  },
  'débit prélevé': {
    valueType: 'instantaneous',
    spatialOperators: ['sum'],
    temporalOperators: ['mean', 'min', 'max'],
    defaultSpatialOperator: 'sum',
    defaultTemporalOperator: 'mean',
    unit: 'L/s'
  },
  'débit réservé': {
    valueType: 'instantaneous',
    spatialOperators: ['sum', 'min'],
    temporalOperators: ['mean', 'min', 'max'],
    defaultSpatialOperator: 'sum',
    defaultTemporalOperator: 'min',
    unit: 'L/s'
  },
  'débit restitué': {
    valueType: 'instantaneous',
    spatialOperators: ['sum'],
    temporalOperators: ['mean', 'min', 'max'],
    defaultSpatialOperator: 'sum',
    defaultTemporalOperator: 'mean',
    unit: 'L/s'
  },
  température: {
    valueType: 'instantaneous',
    spatialOperators: ['mean', 'min', 'max'],
    temporalOperators: ['mean', 'min', 'max'],
    defaultSpatialOperator: 'mean',
    defaultTemporalOperator: 'mean',
    unit: '°C'
  },
  'niveau piézométrique': {
    valueType: 'instantaneous',
    spatialOperators: ['mean', 'min', 'max'],
    temporalOperators: ['mean', 'min', 'max'],
    defaultSpatialOperator: 'mean',
    defaultTemporalOperator: 'mean',
    unit: 'm NGR'
  },
  chlorures: {
    valueType: 'instantaneous',
    spatialOperators: ['mean', 'min', 'max'],
    temporalOperators: ['mean', 'min', 'max'],
    defaultSpatialOperator: 'mean',
    defaultTemporalOperator: 'mean',
    unit: 'mg/L'
  },
  nitrates: {
    valueType: 'instantaneous',
    spatialOperators: ['mean', 'min', 'max'],
    temporalOperators: ['mean', 'min', 'max'],
    defaultSpatialOperator: 'mean',
    defaultTemporalOperator: 'mean',
    unit: 'mg/L'
  },
  sulfates: {
    valueType: 'instantaneous',
    spatialOperators: ['mean', 'min', 'max'],
    temporalOperators: ['mean', 'min', 'max'],
    defaultSpatialOperator: 'mean',
    defaultTemporalOperator: 'mean',
    unit: 'mg/L'
  },
  turbidité: {
    valueType: 'instantaneous',
    spatialOperators: ['mean', 'min', 'max'],
    temporalOperators: ['mean', 'min', 'max'],
    defaultSpatialOperator: 'mean',
    defaultTemporalOperator: 'mean',
    unit: 'FTU'
  },
  conductivité: {
    valueType: 'instantaneous',
    spatialOperators: ['mean', 'min', 'max'],
    temporalOperators: ['mean', 'min', 'max'],
    defaultSpatialOperator: 'mean',
    defaultTemporalOperator: 'mean',
    unit: 'µS/cm'
  },
  pH: {
    valueType: 'instantaneous',
    spatialOperators: ['mean', 'min', 'max'],
    temporalOperators: ['mean', 'min', 'max'],
    defaultSpatialOperator: 'mean',
    defaultTemporalOperator: 'mean',
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
 * @returns {string[]|null}
 */
export function getAvailableOperators(parameter, context = 'spatial') {
  const config = parametersConfig[parameter]
  if (!config) {
    return null
  }

  return context === 'temporal'
    ? config.temporalOperators || null
    : config.spatialOperators || null
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
    throw new Error(
      `Opérateur '${operator}' non disponible pour le paramètre '${parameter}' en agrégation ${contextLabel}. `
      + `Opérateurs disponibles: ${available.join(', ')}`
    )
  }
}
