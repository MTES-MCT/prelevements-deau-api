/**
 * Configuration des paramètres de mesure et leurs opérateurs d'agrégation disponibles.
 *
 * Chaque paramètre définit :
 * - valueType : type de valeur ('cumulative' ou 'instantaneous')
 * - aggregationOperators : liste des opérateurs disponibles pour ce paramètre
 * - defaultOperator : opérateur par défaut si non spécifié
 * - unit : unité standard (optionnel, à titre informatif)
 *
 * Note : Les clés doivent correspondre exactement aux valeurs du champ 'parameter'
 * stockées dans la collection 'series'.
 */

export const parametersConfig = {
  'volume prélevé': {
    valueType: 'cumulative',
    aggregationOperators: ['sum', 'mean', 'min', 'max'],
    defaultOperator: 'sum',
    unit: 'm3'
  },
  'volume restitué': {
    valueType: 'cumulative',
    aggregationOperators: ['sum', 'mean', 'min', 'max'],
    defaultOperator: 'sum',
    unit: 'm3'
  },
  'débit prélevé': {
    valueType: 'instantaneous',
    aggregationOperators: ['mean', 'min', 'max'],
    defaultOperator: 'mean',
    unit: 'm³/h'
  },
  'débit réservé': {
    valueType: 'instantaneous',
    aggregationOperators: ['mean', 'min', 'max'],
    defaultOperator: 'mean',
    unit: 'm³/h'
  },
  'débit restitué': {
    valueType: 'instantaneous',
    aggregationOperators: ['mean', 'min', 'max'],
    defaultOperator: 'mean',
    unit: 'm³/h'
  },
  température: {
    valueType: 'instantaneous',
    aggregationOperators: ['mean', 'min', 'max'],
    defaultOperator: 'mean',
    unit: '°C'
  },
  'niveau piézométrique': {
    valueType: 'instantaneous',
    aggregationOperators: ['mean', 'min', 'max'],
    defaultOperator: 'mean',
    unit: 'm NGR'
  },
  chlorures: {
    valueType: 'instantaneous',
    aggregationOperators: ['mean', 'min', 'max'],
    defaultOperator: 'mean',
    unit: 'mg/L'
  },
  nitrates: {
    valueType: 'instantaneous',
    aggregationOperators: ['mean', 'min', 'max'],
    defaultOperator: 'mean',
    unit: 'mg/L'
  },
  sulfates: {
    valueType: 'instantaneous',
    aggregationOperators: ['mean', 'min', 'max'],
    defaultOperator: 'mean',
    unit: 'mg/L'
  },
  turbidité: {
    valueType: 'instantaneous',
    aggregationOperators: ['mean', 'min', 'max'],
    defaultOperator: 'mean',
    unit: 'FTU'
  },
  conductivité: {
    valueType: 'instantaneous',
    aggregationOperators: ['mean', 'min', 'max'],
    defaultOperator: 'mean',
    unit: 'µS/cm'
  },
  pH: {
    valueType: 'instantaneous',
    aggregationOperators: ['mean', 'min', 'max'],
    defaultOperator: 'mean',
    unit: ''
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
 * Retourne les opérateurs disponibles pour un paramètre.
 * @param {string} parameter - Nom du paramètre
 * @returns {string[]|null}
 */
export function getAvailableOperators(parameter) {
  return parametersConfig[parameter]?.aggregationOperators || null
}

/**
 * Retourne l'opérateur par défaut pour un paramètre.
 * @param {string} parameter - Nom du paramètre
 * @returns {string|null}
 */
export function getDefaultOperator(parameter) {
  return parametersConfig[parameter]?.defaultOperator || null
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
 * Vérifie si un opérateur est valide pour un paramètre donné.
 * @param {string} parameter - Nom du paramètre
 * @param {string} operator - Opérateur d'agrégation
 * @returns {boolean}
 */
export function isOperatorValidForParameter(parameter, operator) {
  const operators = getAvailableOperators(parameter)
  return operators ? operators.includes(operator) : false
}
