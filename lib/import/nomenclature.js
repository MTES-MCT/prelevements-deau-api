// Mappings ID → libellé pour l'import de fichiers CSV territoriaux
// Ces mappings sont spécifiques au format d'import et ne doivent pas être utilisés pour la validation API

export const usages = {
  1: 'Eau potable',
  2: 'Agriculture',
  3: 'Autre',
  4: 'Camion citerne',
  5: 'Eau embouteillée',
  6: 'Hydroélectricité',
  7: 'Industrie',
  8: 'Non renseigné',
  9: 'Thermalisme'
}

export const typesMilieu = {
  1: 'Eau de surface',
  2: 'Eau souterraine',
  3: 'Eau de transition'
}

export const statutsExploitation = {
  1: 'En activité',
  2: 'Terminée',
  3: 'Abandonnée',
  4: 'Non renseigné'
}

export const unites = {
  1: 'm³',
  2: 'L/s',
  3: 'm³/h',
  4: 'mg/L',
  5: 'degrés Celsius',
  6: 'm NGR',
  7: 'µS/cm'
}

// Contraintes : opérateurs de comparaison pour les règles
// 1 = min : valeur minimale à respecter (seuil plancher)
// 2 = max : valeur maximale à ne pas dépasser (seuil plafond)
export const contraintes = {
  1: 'min',
  2: 'max'
}

export const parametres = {
  1: 'volume prélevé',
  2: 'volume prélevé',
  3: 'volume prélevé',
  4: 'relevé d\'index',
  5: 'débit prélevé',
  6: 'débit réservé',
  7: 'chlorures',
  8: 'nitrates',
  9: 'sulfates',
  10: 'température',
  11: 'niveau piézométrique',
  12: 'conductivité',
  13: 'pH'
}

export const natures = {
  1: 'Autorisation AOT',
  2: 'Autorisation CSP',
  3: 'Autorisation CSP - IOTA',
  4: 'Autorisation hydroélectricité',
  5: 'Autorisation ICPE',
  6: 'Autorisation IOTA',
  7: 'Délibération abandon',
  8: 'Rapport hydrogéologue agréé'
}

export const frequences = {
  1: '1 day',
  2: '1 month',
  3: '1 year',
  4: '1 hour',
  5: '1 day',
  6: '1 week',
  7: '1 month',
  8: '1 quarter',
  9: '1 year',
  10: 'autre'
}

// Mapping paramètre → fréquence pour les anciens IDs volume journalier/mensuel/annuel
export const parametreFrequences = {
  1: '1 day',
  2: '1 month',
  3: '1 year'
}

export const precisionsGeom = {
  1: 'Repérage carte',
  2: 'Coordonnées précises',
  3: 'Coordonnées précises (ARS)',
  4: 'Coordonnées du centroïde de la commune',
  5: 'Coordonnées précises (rapport HGA)',
  6: 'Coordonnées précises (ARS 2013)',
  7: 'Coordonnées précises (AP)',
  8: 'Coordonnées précises (BSS)',
  9: 'Coordonnées précises (BNPE – accès restreint)',
  10: 'Précision inconnue',
  11: 'Coordonnées estimées (précision du kilomètre)',
  12: 'Coordonnées précises (BNPE)',
  13: 'Coordonnées précises (DEAL)',
  14: 'Coordonnées précises (DLE)'
}
