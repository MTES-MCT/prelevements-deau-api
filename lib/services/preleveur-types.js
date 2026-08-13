import {legacyUsageToRootUsageCode} from '../constants/sandre-water-uses.js'

export const PRELEVEUR_TYPES = Object.freeze([
  'ICPE',
  'IRRIGANT',
  'GESTIONNAIRE_AEP',
  'AUTRE'
])

const PRELEVEUR_TYPE_BY_ROOT_USAGE_CODE = new Map([
  ['4', 'ICPE'],
  ['2', 'IRRIGANT'],
  ['5', 'GESTIONNAIRE_AEP']
])

export function getPreleveurTypeFromUsages(usages = []) {
  const inferredTypes = new Set(
    usages
      .map(usage => legacyUsageToRootUsageCode(usage))
      .map(rootUsageCode => PRELEVEUR_TYPE_BY_ROOT_USAGE_CODE.get(rootUsageCode))
      .filter(Boolean)
  )

  if (inferredTypes.size > 1) {
    throw new Error('Impossible de déduire un type de préleveur unique à partir de plusieurs catégories d’usage.')
  }

  return inferredTypes.values().next().value ?? 'AUTRE'
}

export function normalizePreleveurType({declarantRole = 'PRELEVEUR', preleveurType}) {
  return declarantRole === 'COLLECTEUR'
    ? null
    : preleveurType ?? 'AUTRE'
}
