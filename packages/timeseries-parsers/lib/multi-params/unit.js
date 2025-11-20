import {deburr} from 'lodash-es'

const AVAILABLE_UNITS = {
  'µS/cm': ['µs/cm', 'us/cm', 'μs/cm', 'microsiemens/cm'],
  'degrés Celsius': ['degres celsius', '°c', 'degre celsius', 'celsius', 'c'],
  'L/s': ['l/s', 'litres/s', 'litre/s', 'litres par seconde', 'litre par seconde'],
  'm³/h': ['m3/h', 'metres cubes par heure', 'metre cube par heure', 'm3/heure', 'm³/heure'],
  'm³': ['m3', 'metres cubes', 'metre cube'],
  'm NGR': ['m ngr', 'metres ngr', 'metre ngr', 'mngr'],
  'mg/L': ['mg/l', 'milligrammes par litre', 'milligramme par litre'],
  autre: ['autres']
}

/**
 * Normalise une chaîne d'unité pour comparaison.
 *
 * @param {string} str Chaîne à normaliser
 * @returns {string} Chaîne normalisée
 */
function normalizeString(str) {
  if (!str) {
    return ''
  }

  return deburr(str)
    .toLowerCase()
    .trim()
    // Remplacer les caractères spéciaux
    .replaceAll('³', '3')
    .replaceAll('µ', 'u')
    .replaceAll('μ', 'u') // Micro grec
    .replaceAll('°', '')
    // Supprimer les espaces superflus
    .replaceAll(/\s+/g, ' ')
    .trim()
}

/**
 * Construit un Map de formes normalisées vers le libellé canonique.
 * Inclut l'unité elle-même et tous ses alias.
 */
const NORMALIZED_UNITS_MAP = new Map()

for (const [canonical, aliases] of Object.entries(AVAILABLE_UNITS)) {
  NORMALIZED_UNITS_MAP.set(normalizeString(canonical), canonical)

  for (const alias of aliases) {
    NORMALIZED_UNITS_MAP.set(normalizeString(alias), canonical)
  }
}

/**
 * Trouve le libellé canonique d'une unité depuis son nom ou un alias.
 *
 * @param {string} unitName Nom de l'unité ou alias depuis les métadonnées
 * @returns {string|undefined} Nom canonique de l'unité, ou undefined si non reconnue
 */
export function normalizeUnit(unitName) {
  if (!unitName) {
    return
  }

  const normalized = normalizeString(unitName)

  if (!normalized) {
    return
  }

  return NORMALIZED_UNITS_MAP.get(normalized)
}
