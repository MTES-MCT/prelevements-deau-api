
import {
  extractCamionCiterne,
  extractMultiParamFile,
  extractTemplateFile,
  extractAquasys,
  extractGidaf
} from '@fabnum/prelevements-deau-timeseries-parsers'

import hashObject from 'hash-object'

/**
 * Parse un buffer selon le type de prélèvement
 * @param {string} type - Type de prélèvement ('camion-citerne', 'aep-zre', 'icpe-hors-zre', 'template-file', 'extract-aquasys', 'gidaf')
 * @param {Buffer|Object} bufferOrOptions - Buffer contenant les données du fichier, ou objet avec {cadresBuffer, prelevementsBuffer} pour GIDAF
 * @returns {Promise<{errors: Array, series: Array}>} Erreurs et séries parsées
 */
export async function parseBuffer(type, bufferOrOptions) {
  // Pour les autres types, bufferOrOptions est un buffer simple
  const buffer = bufferOrOptions

  if (type === 'camion-citerne') {
    const {errors, data} = await extractCamionCiterne(buffer)
    return {
      errors: errors || [],
      series: data?.series || []
    }
  }

  if (type === 'aep-zre' || type === 'icpe-hors-zre') {
    const {errors, data} = await extractMultiParamFile(buffer)
    return {
      errors: errors || [],
      series: data?.series || []
    }
  }

  if (type === 'template-file') {
    const {errors, data} = await extractTemplateFile(buffer)
    return {
      errors: errors || [],
      series: data?.series || [],
      pointPrelevement: data?.metadata?.pointsPrelevement || [],
      preleveurs: data?.metadata?.preleveurs || []
    }
  }

  if (type === 'extract-aquasys') {
    const {errors, data} = await extractAquasys(buffer)
    return {
      errors: errors || [],
      series: data?.series || [],
      pointPrelevement: data?.metadata?.pointsPrelevement || [],
      preleveurs: data?.metadata?.preleveurs || []
    }
  }

  if (type === 'gidaf') {
    // Pour GIDAF, on accepte soit un objet avec 2 buffers, soit 2 buffers séparés
    const {errors, data} = await extractGidaf(bufferOrOptions)
    return {
      errors: errors || [],
      series: data?.series || [],
      pointPrelevement: data?.metadata?.pointsPrelevement || [],
      preleveurs: data?.metadata?.preleveurs || []
    }
  }

  return {
    errors: [],
    series: []
  }
}

/**
 * Normalise les erreurs en ajoutant une severity par défaut
 * @param {Array} errors - Liste des erreurs brutes
 * @returns {Array} Liste des erreurs normalisées
 */
export function normalizeErrors(errors) {
  if (!errors || errors.length === 0) {
    return []
  }

  return errors.map(error => ({
    ...error,
    severity: error.severity || 'error'
  }))
}

/**
 * Crée un résumé des erreurs et limite à 50 erreurs max
 * @param {Array} errors - Liste des erreurs normalisées
 * @returns {{errors: Array, errorSummary: Object}} Erreurs limitées et résumé
 */
export function summarizeErrors(errors) {
  const errorSummary = errors.length > 0
    ? {
      total: errors.length,
      error: errors.filter(e => e.severity === 'error').length,
      warning: errors.filter(e => e.severity === 'warning').length
    }
    : {total: 0}

  let limitedErrors = [...errors]

  if (errors.length > 50) {
    limitedErrors = errors.slice(0, 50)
    limitedErrors.push({
      message: 'Le fichier contient plus de 50 erreurs. Les erreurs suivantes n\'ont pas été affichées.'
    })
  }

  return {
    errors: limitedErrors,
    errorSummary
  }
}

/**
 * Ajoute un hash à chaque série pour détecter les modifications
 * @param {Array} series - Liste des séries
 * @returns {Array} Liste des séries avec hash ajouté
 */
export function addHashToSeries(series) {
  if (!series || series.length === 0) {
    return []
  }

  return series.map(serie => ({
    ...serie,
    hash: hashObject(serie, {algorithm: 'sha256'}).slice(0, 12)
  }))
}

/* Helpers */

export function calculateTotalVolumePreleve(series) {
  if (!series) {
    return 0
  }

  let total = 0
  for (const s of series) {
    if (s.parameter !== 'volume prélevé' || !s.data) {
      continue
    }

    for (const dataPoint of s.data) {
      if (typeof dataPoint.value === 'number') {
        total += dataPoint.value
      }
    }
  }

  return total
}

