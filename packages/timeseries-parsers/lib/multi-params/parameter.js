import {deburr} from 'lodash-es'

const AVAILABLE_PARAMETERS = {
  chlorures: [],
  conductivité: ['conductivité électrique'],
  'débit prélevé': [],
  'débit réservé': [],
  'débit restitué': [],
  nitrates: [],
  'niveau piézométrique': ['niveau d’eau'],
  pH: [],
  'relevé d’index de compteur': [],
  sulfates: [],
  température: [],
  turbidité: [],
  'volume prélevé': [],
  'volume restitué': [],
  autre: []
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

for (const [canonical, aliases] of Object.entries(AVAILABLE_PARAMETERS)) {
  NORMALIZED_PARAMETERS_MAP.set(normalizeString(canonical), canonical)

  for (const alias of aliases) {
    NORMALIZED_PARAMETERS_MAP.set(normalizeString(alias), canonical)
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
