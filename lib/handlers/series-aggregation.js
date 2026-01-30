import Joi from 'joi'
import createHttpError from 'http-errors'
import {min, max} from 'lodash-es'
import {ObjectId} from 'mongodb'
import {getPointBySeqId, getPointPrelevement} from '../models/point-prelevement.js'
import {getPointsFromPreleveur} from '../services/point-prelevement.js'
import {getPreleveurBySeqId, getPreleveur} from '../models/preleveur.js'
import {listSeries, getSeriesValuesInRange} from '../models/series.js'
import {
  parametersConfig,
  getDefaultOperator,
  validateOperatorForParameter,
  SUB_DAILY_FREQUENCIES,
  DAILY_FREQUENCY,
  ALL_FREQUENCIES
} from '../parameters-config.js'
import * as Sentry from '@sentry/node'

/**
 * Patterns de validation pour les identifiants
 */
const OBJECT_ID_PATTERN = /^[\da-fA-F]{24}$/
const POINT_IDS_PATTERN = /^([\da-fA-F]{24}|\d+)(,([\da-fA-F]{24}|\d+))*$/

/**
 * Schéma de validation Joi pour les paramètres de requête d'agrégation
 * Accepte les IDs numériques (id_point, id_preleveur) ou les ObjectId MongoDB
 */
const aggregatedSeriesQuerySchema = Joi.object({
  pointIds: Joi.string()
    .pattern(POINT_IDS_PATTERN)
    .messages({
      'string.base': 'Le paramètre pointIds doit être une chaîne de caractères',
      'string.empty': 'Le paramètre pointIds ne peut pas être vide',
      'string.pattern.base': 'Le paramètre pointIds doit être une liste d\'identifiants séparés par des virgules'
    }),
  preleveurId: Joi.alternatives()
    .try(
      Joi.number().integer().positive(),
      Joi.string().pattern(OBJECT_ID_PATTERN)
    )
    .messages({
      'alternatives.match': 'Le paramètre preleveurId doit être un nombre entier positif ou un ObjectId valide (24 caractères hexadécimaux)'
    }),
  attachmentId: Joi.string()
    .pattern(OBJECT_ID_PATTERN)
    .messages({
      'string.base': 'Le paramètre attachmentId doit être une chaîne de caractères',
      'string.pattern.base': 'Le paramètre attachmentId doit être un ObjectId valide (24 caractères hexadécimaux)'
    }),
  parameter: Joi.string()
    .required()
    .messages({
      'string.base': 'Le paramètre parameter doit être une chaîne de caractères',
      'string.empty': 'Le paramètre parameter est obligatoire',
      'any.required': 'Le paramètre parameter est obligatoire'
    }),
  spatialOperator: Joi.string()
    .valid('sum', 'mean', 'min', 'max')
    .messages({
      'string.base': 'Le paramètre spatialOperator doit être une chaîne de caractères',
      'any.only': 'Le paramètre spatialOperator doit être l\'un des suivants: sum, mean, min, max'
    }),
  temporalOperator: Joi.string()
    .valid('sum', 'mean', 'min', 'max')
    .messages({
      'string.base': 'Le paramètre temporalOperator doit être une chaîne de caractères',
      'any.only': 'Le paramètre temporalOperator doit être l\'un des suivants: sum, mean, min, max'
    }),
  aggregationFrequency: Joi.string()
    .valid(...ALL_FREQUENCIES)
    .default(DAILY_FREQUENCY)
    .messages({
      'string.base': 'Le paramètre aggregationFrequency doit être une chaîne de caractères',
      'any.only': `Le paramètre aggregationFrequency doit être l'un des suivants: ${ALL_FREQUENCIES.join(', ')}`
    }),
  startDate: Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}$/)
    .messages({
      'string.base': 'Le paramètre startDate doit être une chaîne de caractères',
      'string.pattern.base': 'Le paramètre startDate doit être au format YYYY-MM-DD'
    }),
  endDate: Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}$/)
    .messages({
      'string.base': 'Le paramètre endDate doit être une chaîne de caractères',
      'string.pattern.base': 'Le paramètre endDate doit être au format YYYY-MM-DD'
    })
})
  .or('pointIds', 'preleveurId', 'attachmentId')
  .messages({
    'object.missing': 'Vous devez fournir au moins pointIds, preleveurId ou attachmentId'
  })

/**
 * Valide les paramètres de requête
 */
export function validateQueryParams(query) {
  const {error, value} = aggregatedSeriesQuerySchema.validate(query, {
    abortEarly: false,
    stripUnknown: true
  })

  if (error) {
    const messages = error.details.map(d => d.message)
    throw createHttpError(400, messages.join('. '))
  }

  return value
}

/**
 * Valide et transforme la date
 */
function validateDate(dateString, paramName) {
  if (!dateString) {
    return null
  }

  const date = new Date(dateString)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dateString) {
    throw createHttpError(400, `Le paramètre ${paramName} est une date invalide`)
  }

  return dateString
}

/**
 * Détecte si une chaîne est un ObjectId MongoDB valide
 * @param {string} id - L'identifiant à tester
 * @returns {boolean}
 */
function isObjectId(id) {
  return typeof id === 'string' && OBJECT_ID_PATTERN.test(id)
}

/**
 * Résout un identifiant de point (numérique ou ObjectId) vers un objet point.
 * @param {string|number} pointId - ID numérique (id_point) ou ObjectId
 * @param {string} territoire - Code territoire (utilisé seulement si ID numérique)
 * @returns {Promise<Object|null>} - Le point trouvé ou null
 */
async function resolvePointById(pointId, territoire) {
  if (isObjectId(pointId)) {
    // C'est un ObjectId MongoDB
    return getPointPrelevement(new ObjectId(pointId))
  }

  // C'est un ID numérique séquentiel
  const seqId = Number.parseInt(pointId, 10)
  return getPointBySeqId(territoire, seqId)
}

/**
 * Résout un identifiant de préleveur (numérique ou ObjectId) vers un objet préleveur.
 * @param {string|number} preleveurId - ID numérique (id_preleveur) ou ObjectId
 * @param {string} territoire - Code territoire (utilisé seulement si ID numérique)
 * @returns {Promise<Object|null>} - Le préleveur trouvé ou null
 */
async function resolvePreleveurById(preleveurId, territoire) {
  if (isObjectId(preleveurId)) {
    // C'est un ObjectId MongoDB
    return getPreleveur(new ObjectId(preleveurId))
  }

  // C'est un ID numérique séquentiel
  const seqId = typeof preleveurId === 'string' ? Number.parseInt(preleveurId, 10) : preleveurId
  return getPreleveurBySeqId(territoire, seqId)
}

/**
 * Résout les identifiants (numériques ou ObjectIds) en ObjectIds MongoDB.
 * Recherche chaque point dans le territoire et sépare les points trouvés des non trouvés.
 *
 * @param {Array<string|number>} pointIds - Liste des identifiants (ex: [207, 208] ou ['507f...', '507f...'])
 * @param {string} territoire - Code territoire
 * @returns {Promise<{found: Array, notFound: Array}>}
 *   - found: [{seqId: 207|ObjectId, objectId: ObjectId, point: {...}}, ...]
 *   - notFound: [208, '507f...', ...] (liste des IDs non trouvés)
 */
async function resolvePointIds(pointIds, territoire) {
  const found = []
  const notFound = []

  // Résoudre tous les points en parallèle
  const resolvePromises = pointIds.map(async pointId => {
    const point = await resolvePointById(pointId, territoire)
    return {pointId, point}
  })

  const results = await Promise.all(resolvePromises)

  // Séparer les points trouvés des non trouvés
  for (const {pointId, point} of results) {
    if (point) {
      found.push({
        seqId: point.id_point || pointId, // Utiliser id_point si disponible, sinon l'ID original
        objectId: point._id,
        point
      })
    } else {
      notFound.push(pointId)
    }
  }

  return {found, notFound}
}

/**
 * Résout les points d'un préleveur en ObjectIds MongoDB.
 * Récupère tous les points du préleveur via l'exploitation.
 *
 * @param {number|string} preleveurId - ID numérique (id_preleveur) ou ObjectId du préleveur
 * @param {string} territoire - Code territoire (utilisé seulement si ID numérique)
 * @returns {Promise<{found: Array, notFound: Array}>}
 *   - found: [{seqId: 207, objectId: ObjectId, point: {...}}, ...]
 *   - notFound: [] (toujours vide, car on récupère ce qui existe)
 */
async function resolvePreleveurPoints(preleveurId, territoire) {
  // Résoudre le préleveur (accepte ID numérique ou ObjectId)
  const preleveur = await resolvePreleveurById(preleveurId, territoire)

  if (!preleveur) {
    throw createHttpError(404, `Préleveur non trouvé: ${preleveurId}`)
  }

  const points = await getPointsFromPreleveur(preleveur._id)

  const found = points.map(point => ({
    seqId: point.id_point,
    objectId: point._id,
    point
  }))

  return {found, notFound: []}
}

/**
 * Récupère les valeurs de toutes les séries dans la plage de dates.
 *
 * Logique de sélection des données :
 * - Séries infra-journalières :
 *   • Si aggregationFrequency infra-journalière (15min/1h/6h) → valeurs brutes (pour conserver la granularité)
 *   • Sinon (jour/mois/trimestre/année) → dailyAggregates pré-calculés (optimisation)
 * - Séries journalières : toujours valeurs brutes
 *
 * @param {Array} seriesList - Liste des séries avec leur _id et frequency
 * @param {string} startDate - Date de début (YYYY-MM-DD)
 * @param {string} endDate - Date de fin (YYYY-MM-DD)
 * @param {string} aggregationFrequency - Fréquence d'agrégation demandée
 * @returns {Promise<{valuesBySeriesId: Map, usesDailyAggregates: boolean}>}
 */
async function fetchAllSeriesValues(seriesList, startDate, endDate, aggregationFrequency) {
  const valuesBySeriesId = new Map()

  // Déterminer si on a des séries infra-journalières (exclut les séries super-daily comme mensuelles)
  const hasSubDailySeries = seriesList.some(s => SUB_DAILY_FREQUENCIES.includes(s.frequency))

  // Si aggregationFrequency est infra-journalière, on veut les valeurs brutes
  const needsRawValues = SUB_DAILY_FREQUENCIES.includes(aggregationFrequency)

  await Promise.all(
    seriesList.map(async series => {
      const seriesId = series._id
      const isSubDaily = SUB_DAILY_FREQUENCIES.includes(series.frequency)

      // Pour les séries infra-journalières :
      // - Si on veut une fréquence infra-journalière → valeurs brutes
      // - Sinon → dailyAggregates
      // Pour les séries journalières : toujours valeurs brutes
      const useAggregates = isSubDaily && !needsRawValues

      const values = await getSeriesValuesInRange(seriesId, {
        startDate,
        endDate,
        useAggregates
      })

      valuesBySeriesId.set(seriesId.toString(), {values, isSubDaily, useAggregates})
    })
  )

  return {valuesBySeriesId, usesDailyAggregates: hasSubDailySeries && !needsRawValues}
}

/**
 * Applique l'opérateur d'agrégation sur un tableau de valeurs.
 * Filtre les valeurs non valides (null, undefined, NaN, non-numériques) avant le calcul.
 * Compile les remarques associées (max 10 uniques).
 *
 * @param {Array} items - Tableau de valeurs numériques ou objets {value, remark?, remarks?}
 * @param {string} operator - Opérateur d'agrégation ('sum', 'mean', 'min', 'max')
 * @returns {Object|null} - {value: number, remarks?: Array<string>} ou null si aucune valeur valide
 */
export function applyAggregationOperator(items, operator) {
  if (!Array.isArray(items) || items.length === 0) {
    return null
  }

  // Extraire valeurs numériques et remarques
  const {values, remarks: allRemarks} = extractValuesAndRemarks(items)

  if (values.length === 0) {
    return null
  }

  let aggregatedValue
  switch (operator) {
    case 'sum': {
      aggregatedValue = values.reduce((acc, v) => acc + v, 0)
      break
    }

    case 'mean': {
      const sum = values.reduce((acc, v) => acc + v, 0)
      aggregatedValue = sum / values.length
      break
    }

    case 'min': {
      aggregatedValue = min(values)
      break
    }

    case 'max': {
      aggregatedValue = max(values)
      break
    }

    default: {
      throw new Error(`Opérateur inconnu: ${operator}`)
    }
  }

  const result = {value: aggregatedValue}

  // Ajouter les remarques si présentes (limitées à 10 uniques)
  if (allRemarks.length > 0) {
    const uniqueRemarks = deduplicateAndLimitRemarks(allRemarks, 10)
    if (uniqueRemarks.length > 0) {
      result.remarks = uniqueRemarks
    }
  }

  return result
}

/**
 * Vérifie si une valeur est valide pour l'agrégation.
 * @param {*} value - Valeur à vérifier
 * @returns {boolean}
 */
function isValidValue(value) {
  return value !== null && value !== undefined && !Number.isNaN(value) && Number.isFinite(value)
}

/**
 * Déduplique et limite le nombre de remarques.
 * Fonction pure testable indépendamment.
 *
 * @param {Array<string>} remarks - Tableau de remarques (peut contenir des doublons)
 * @param {number} limit - Nombre maximum de remarques uniques à conserver
 * @returns {Array<string>} - Tableau de remarques uniques, limité
 */
export function deduplicateAndLimitRemarks(remarks, limit = 10) {
  if (!Array.isArray(remarks) || remarks.length === 0) {
    return []
  }

  // Dédupliquer avec Set, puis limiter
  return [...new Set(remarks)].slice(0, limit)
}

/**
 * Extrait les valeurs numériques et les remarques depuis un tableau d'items.
 * Supporte les valeurs numériques simples et les objets {value, remark?, remarks?}.
 * Fonction pure testable indépendamment.
 *
 * @param {Array} items - Tableau de valeurs numériques ou objets
 * @returns {{values: Array<number>, remarks: Array<string>}}
 */
export function extractValuesAndRemarks(items) {
  const values = []
  const remarks = []

  if (!Array.isArray(items)) {
    return {values, remarks}
  }

  for (const item of items) {
    // Support des valeurs numériques directes (rétrocompatibilité)
    if (typeof item === 'number') {
      if (!Number.isNaN(item) && Number.isFinite(item)) {
        values.push(item)
      }
    } else if (item && typeof item === 'object') {
      // Support des objets {value, remark?, remarks?}
      const {value, remark, remarks: itemRemarks} = item

      // Extraire la valeur numérique
      if (typeof value === 'number' && !Number.isNaN(value) && Number.isFinite(value)) {
        values.push(value)
      }

      // Collecter les remarques
      if (remark) {
        remarks.push(remark)
      }

      if (Array.isArray(itemRemarks)) {
        remarks.push(...itemRemarks)
      }
    }
  }

  return {values, remarks}
}

/**
 * Extrait les valeurs brutes d'une série infra-journalière.
 * @param {Array} rawValues - Valeurs brutes [{time, value, remark?}, ...]
 * @param {string} date - Date de base (YYYY-MM-DD)
 * @param {string} aggregationFrequency - Fréquence d'agrégation
 * @returns {Array<{period: string, value: number, remark?: string}>}
 */
function extractSubDailyRawValues(rawValues, date, aggregationFrequency) {
  const results = []
  const isSubDailyAggregation = SUB_DAILY_FREQUENCIES.includes(aggregationFrequency)

  for (const {time, value, remark} of rawValues) {
    if (!isValidValue(value)) {
      continue
    }

    const period = isSubDailyAggregation
      ? extractSubDailyPeriod(date, time, aggregationFrequency)
      : date

    const result = {period, value}
    if (remark) {
      result.remark = remark
    }

    results.push(result)
  }

  return results
}

/**
 * Extrait la valeur agrégée quotidienne depuis dailyAggregates.
 * @param {Object} dailyAggregates - Agrégats pré-calculés
 * @param {string} temporalOperator - Opérateur à utiliser
 * @param {string} date - Date de la valeur
 * @returns {Array<{period: string, value: number, remarks?: Array<string>}>}
 */
function extractDailyAggregateValue(dailyAggregates, temporalOperator, date) {
  let value = null

  // Mapper l'opérateur temporel vers le champ dailyAggregates correspondant
  switch (temporalOperator) {
    case 'sum': {
      value = dailyAggregates.sum
      break
    }

    case 'mean': {
      value = dailyAggregates.mean
      break
    }

    case 'min': {
      value = dailyAggregates.min
      break
    }

    case 'max': {
      value = dailyAggregates.max
      break
    }

    default: {
      throw new Error(`Opérateur temporel inconnu: ${temporalOperator}`)
    }
  }

  if (!isValidValue(value)) {
    return []
  }

  const result = {period: date, value}
  // Ajouter les remarques si présentes dans les agrégats
  if (dailyAggregates.hasRemark && dailyAggregates.uniqueRemarks) {
    result.remarks = dailyAggregates.uniqueRemarks
  }

  return [result]
}

/**
 * Extrait les valeurs d'un document selon le type de série et l'agrégation demandée.
 *
 * Trois cas possibles :
 * 1. Série infra-journalière + valeurs brutes (useAggregates=false)
 *    → Extraire chaque valeur horodatée, regrouper par période si nécessaire
 * 2. Série infra-journalière + dailyAggregates (useAggregates=true)
 *    → Utiliser les agrégats quotidiens pré-calculés selon l'opérateur
 * 3. Série journalière
 *    → Extraire la valeur unique du jour (values.value)
 *
 * @param {Object} valueDoc - Document de valeur
 * @param {Object} context - Contexte d'agrégation
 * @param {boolean} context.isSubDaily - Si la série est infra-journalière
 * @param {boolean} context.useAggregates - Si on utilise les dailyAggregates
 * @param {string} context.operator - Opérateur d'agrégation
 * @param {string} context.aggregationFrequency - Fréquence d'agrégation demandée
 * @returns {Array<{period: string, value: number, remark?: string, remarks?: Array<string>}>} - Liste des valeurs avec leur période et remarque(s) optionnelle(s)
 */
export function extractValuesFromDocument(valueDoc, context) {
  const {isSubDaily, useAggregates, aggregationFrequency, temporalOperator} = context
  const {date} = valueDoc

  if (isSubDaily && !useAggregates) {
    // Cas 1 : Séries infra-journalières avec valeurs brutes
    const rawValues = Array.isArray(valueDoc.values) ? valueDoc.values : []
    return extractSubDailyRawValues(rawValues, date, aggregationFrequency)
  }

  if (isSubDaily && valueDoc.dailyAggregates) {
    // Cas 2 : Séries infra-journalières avec dailyAggregates
    return extractDailyAggregateValue(valueDoc.dailyAggregates, temporalOperator, date)
  }

  // Cas 3 : Séries journalières ou super-daily (mensuelles, annuelles, etc.)
  const value = valueDoc.values?.value
  const remark = valueDoc.values?.remark

  if (!isValidValue(value)) {
    return []
  }

  const result = {period: date, value}
  if (remark) {
    result.remark = remark
  }

  return [result]
}

/**
 * Agrège temporellement des valeurs infra-journalières qui ont la même période.
 * Utilisé pour regrouper des valeurs infra-journalières qui tombent dans la même tranche horaire.
 *
 * @param {Array} values - Valeurs avec {period, value, remark?}
 * @param {string} operator - Opérateur d'agrégation temporelle
 * @returns {Array} - Valeurs agrégées par période
 */
export function aggregateSubDailyValuesByPeriod(values, operator) {
  if (!values || values.length === 0) {
    return []
  }

  const valuesByPeriod = new Map()

  // Regrouper par période
  for (const item of values) {
    const {period} = item
    if (!valuesByPeriod.has(period)) {
      valuesByPeriod.set(period, [])
    }

    valuesByPeriod.get(period).push(item)
  }

  // Agréger chaque groupe
  const aggregated = []
  for (const [period, items] of valuesByPeriod.entries()) {
    const result = applyAggregationOperator(items, operator)
    if (result !== null) {
      aggregated.push({
        period,
        value: result.value,
        ...(result.remarks && {remarks: result.remarks})
      })
    }
  }

  return aggregated
}

/**
 * Agrège spatialement les valeurs d'une période.
 * @param {Array} items - Valeurs pour une période donnée
 * @param {string|null} spatialOperator - Opérateur spatial ou null si non supporté
 * @param {string} temporalOperator - Opérateur temporel (fallback si pas d'opérateur spatial)
 * @returns {Object|null} - {date, value, remarks?} ou null
 */
export function aggregateSpatialValues(items, period, spatialOperator, temporalOperator) {
  // Si pas d'opérateur spatial (paramètre ne supporte pas l'agrégation spatiale)
  if (spatialOperator === null) {
    // Une seule valeur : la retourner directement
    if (items.length === 1) {
      const item = items[0]
      const result = {date: period, value: item.value}
      if (item.remarks) {
        result.remarks = item.remarks
      }

      return result
    }

    // Plusieurs valeurs sans agrégation spatiale possible
    // Utiliser temporalOperator pour consolider (même point, données dupliquées)
    const aggregated = applyAggregationOperator(items, temporalOperator)
    if (aggregated !== null) {
      const result = {date: period, value: aggregated.value}
      if (aggregated.remarks) {
        result.remarks = aggregated.remarks
      }

      return result
    }

    return null
  }

  // Agrégation spatiale normale
  const aggregated = applyAggregationOperator(items, spatialOperator)
  if (aggregated !== null) {
    const result = {date: period, value: aggregated.value}
    if (aggregated.remarks) {
      result.remarks = aggregated.remarks
    }

    return result
  }

  return null
}

/**
 * Agrège spatialement les valeurs de plusieurs séries (multi-points) par date ou période.
 *
 * Processus en 2 phases :
 * 1. Regroupement : Extraire toutes les valeurs de toutes les séries et les regrouper par période
 *    - Pour séries journalières : regroupe par date (YYYY-MM-DD)
 *    - Pour séries infra-journalières : regroupe par période selon aggregationFrequency
 * 2. Agrégation : Appliquer l'opérateur (sum/mean/min/max) sur les valeurs de chaque période
 *
 * Note : Cette fonction fait l'agrégation SPATIALE (multi-points).
 * L'agrégation TEMPORELLE (jour→mois→année) est faite ensuite par aggregateValuesByPeriod.
 *
 * @param {Map} valuesBySeriesId - Map<seriesId, {values, isSubDaily, useAggregates}>
 * @param {Array} seriesList - Liste des séries
 * @param {Object} aggregationContext - Contexte d'agrégation
 * @param {string} aggregationContext.operator - Opérateur ('sum', 'mean', 'min', 'max')
 * @param {string} aggregationContext.aggregationFrequency - Fréquence demandée
 * @returns {Array} - [{date, value}, ...] triés par date
 */
function aggregateValuesByDate(valuesBySeriesId, seriesList, aggregationContext) {
  const {spatialOperator, temporalOperator, aggregationFrequency} = aggregationContext
  const valuesByPeriod = new Map()

  // Regrouper toutes les valeurs par date ou période
  for (const series of seriesList) {
    const seriesId = series._id.toString()
    const seriesData = valuesBySeriesId.get(seriesId)

    if (!seriesData) {
      continue
    }

    const {values: valueDocs, isSubDaily, useAggregates} = seriesData

    for (const valueDoc of valueDocs) {
      const extractedValues = extractValuesFromDocument(valueDoc, {
        isSubDaily,
        useAggregates,
        aggregationFrequency,
        temporalOperator
      })

      // Agréger temporellement les valeurs qui ont la même période
      // (ex: plusieurs timestamps infra-journaliers → une seule valeur par tranche horaire)
      // Note : uniquement nécessaire pour les séries infra-journalières
      const temporallyAggregated = isSubDaily
        ? aggregateSubDailyValuesByPeriod(extractedValues, temporalOperator)
        : extractedValues

      for (const item of temporallyAggregated) {
        const {period} = item
        if (!valuesByPeriod.has(period)) {
          valuesByPeriod.set(period, [])
        }

        valuesByPeriod.get(period).push(item)
      }
    }
  }

  // Appliquer l'agrégation spatiale pour chaque période
  const aggregatedValues = []
  for (const [period, items] of valuesByPeriod.entries()) {
    const result = aggregateSpatialValues(items, period, spatialOperator, temporalOperator)
    if (result !== null) {
      aggregatedValues.push(result)
    }
  }

  // Trier par période
  aggregatedValues.sort((a, b) => a.date.localeCompare(b.date))

  return aggregatedValues
}

/**
 * Extrait la période (mois, trimestre ou année) d'une date au format YYYY-MM-DD.
 * @param {string} date - Date au format YYYY-MM-DD
 * @param {string} frequency - '1 month', '1 quarter' ou '1 year'
 * @returns {string} - Période au format YYYY-MM (mois), YYYY-QN (trimestre) ou YYYY (année)
 */
export function extractPeriod(date, frequency) {
  if (frequency === '1 month') {
    return date.slice(0, 7) // YYYY-MM
  }

  if (frequency === '1 quarter') {
    const year = date.slice(0, 4)
    const month = Number.parseInt(date.slice(5, 7), 10)
    if (month < 1 || month > 12) {
      throw new Error(`Invalid month value: ${month} in date: ${date}`)
    }

    const quarter = Math.ceil(month / 3)
    return `${year}-Q${quarter}` // YYYY-Q1, YYYY-Q2, YYYY-Q3, YYYY-Q4
  }

  if (frequency === '1 year') {
    return date.slice(0, 4) // YYYY
  }

  return date // '1 day' retourne la date complète
}

/**
 * Extrait la période infra-journalière d'un timestamp date+time.
 * @param {string} date - Date au format YYYY-MM-DD
 * @param {string} time - Heure au format HH:MM ou HH:MM:SS
 * @param {string} frequency - '15 minutes', '1 hour', ou '6 hours'
 * @returns {string} - Période au format YYYY-MM-DD HH:MM
 */
export function extractSubDailyPeriod(date, time, frequency) {
  const [hours, minutes = '00'] = time.split(':').map(Number)

  if (frequency === '15 minutes') {
    // Arrondir à la tranche de 15 minutes inférieure
    const roundedMinutes = Math.floor(minutes / 15) * 15
    return `${date} ${String(hours).padStart(2, '0')}:${String(roundedMinutes).padStart(2, '0')}`
  }

  if (frequency === '1 hour') {
    // Arrondir à l'heure
    return `${date} ${String(hours).padStart(2, '0')}:00`
  }

  if (frequency === '6 hours') {
    // Arrondir à la tranche de 6 heures (0, 6, 12, 18)
    const roundedHours = Math.floor(hours / 6) * 6
    return `${date} ${String(roundedHours).padStart(2, '0')}:00`
  }

  return `${date} ${time}` // Fallback
}

/**
 * Détecte si plusieurs séries ont des périodes qui se chevauchent.
 *
 * Cette fonction ne tient compte QUE des dates intégrées (computed.integratedDays),
 * car seules ces dates représentent des données réellement consolidées et utilisables
 * pour l'agrégation. Les séries brutes non intégrées ne sont pas considérées car elles
 * n'ont pas encore été validées et ne peuvent pas être agrégées de manière fiable.
 *
 * Use case : Si un point a des données de plusieurs préleveurs sur les mêmes dates
 * consolidées, l'agrégation spatiale avec mean/min/max n'a pas de sens métier
 * (on mélangerait des contextes différents). Seule la somme reste cohérente.
 *
 * @param {Array} series - Liste des séries
 * @returns {boolean} - true si overlap détecté (plusieurs séries sur une même date intégrée)
 */
export function detectTemporalOverlapInSeries(series) {
  if (series.length <= 1) {
    return false
  }

  const dateToSeriesMap = new Map()

  for (const s of series) {
    if (s.computed?.integratedDays && Array.isArray(s.computed.integratedDays)) {
      for (const date of s.computed.integratedDays) {
        if (!dateToSeriesMap.has(date)) {
          dateToSeriesMap.set(date, new Set())
        }

        dateToSeriesMap.get(date).add(s._id.toString())
      }
    }
  }

  for (const seriesIds of dateToSeriesMap.values()) {
    if (seriesIds.size > 1) {
      return true
    }
  }

  return false
}

/**
 * Agrège des valeurs journalières en périodes (mois, trimestre, année).
 * Chaque valeur d'entrée représente un jour (date YYYY-MM-DD).
 * Les valeurs sont regroupées par période puis agrégées avec l'opérateur spécifié.
 *
 * @param {Array} dailyValues - [{date: 'YYYY-MM-DD', value: number, remarks?: Array<string>}, ...]
 * @param {string} frequency - '1 day', '1 month', '1 quarter' ou '1 year'
 * @param {string} operator - Opérateur d'agrégation ('sum', 'mean', 'min', 'max')
 * @returns {Array} - [{date: 'YYYY-MM', 'YYYY-QN' ou 'YYYY', value: number, remarks?: Array<string>}, ...]
 */
export function aggregateDailyValuesToPeriod(dailyValues, frequency, operator) {
  if (frequency === '1 day') {
    return dailyValues // Pas d'agrégation temporelle nécessaire
  }

  const valuesByPeriod = new Map()

  // Regrouper les valeurs par période
  for (const item of dailyValues) {
    const {date} = item
    const period = extractPeriod(date, frequency)

    if (!valuesByPeriod.has(period)) {
      valuesByPeriod.set(period, [])
    }

    valuesByPeriod.get(period).push(item)
  }

  // Appliquer l'opérateur d'agrégation pour chaque période
  const aggregatedValues = []
  for (const [period, items] of valuesByPeriod.entries()) {
    const aggregated = applyAggregationOperator(items, operator)
    if (aggregated !== null) {
      const result = {date: period, value: aggregated.value}
      if (aggregated.remarks) {
        result.remarks = aggregated.remarks
      }

      aggregatedValues.push(result)
    }
  }

  // Trier par période
  aggregatedValues.sort((a, b) => a.date.localeCompare(b.date))

  return aggregatedValues
}

/**
 * Prépare les métadonnées pour la réponse d'agrégation
 */
function buildAggregationMetadata({
  parameter,
  unit,
  spatialOperator,
  temporalOperator,
  aggregationFrequency,
  pointIdsStr,
  preleveurId,
  resolvedPoints,
  notFound,
  startDate,
  endDate
}) {
  const metadata = {
    parameter,
    unit,
    spatialOperator,
    temporalOperator,
    frequency: aggregationFrequency,
    startDate: startDate || null,
    endDate: endDate || null
  }

  // Mode préleveur : inclure preleveurId
  if (preleveurId) {
    metadata.preleveurId = preleveurId
  }

  // Mode pointIds : inclure points non trouvés si applicable
  if (pointIdsStr && notFound.length > 0) {
    metadata.pointsNotFound = notFound
  }

  // Toujours inclure les points résolus
  metadata.points = resolvedPoints.map(rp => ({
    _id: rp.objectId,
    id_point: rp.seqId,
    nom: rp.point.nom
  }))

  return metadata
}

/**
 * Filtre une liste de points par des IDs fournis (numériques ou ObjectIds).
 * Fonction synchrone testable.
 *
 * @param {Array} availablePoints - Points disponibles [{seqId, objectId, point}]
 * @param {Array<string>} requestedIds - IDs demandés (numériques ou ObjectIds)
 * @returns {{found: Array, notFound: Array}}
 */
export function filterPointsByIds(availablePoints, requestedIds) {
  // Créer des Maps pour lookup rapide par seqId ET par ObjectId
  const pointsBySeqId = new Map(availablePoints.map(p => [p.seqId, p]))
  const pointsByOid = new Map(availablePoints.map(p => [p.objectId.toString(), p]))

  const found = []
  const notFound = []

  for (const pointId of requestedIds) {
    const isOid = isObjectId(pointId)
    const point = isOid ? pointsByOid.get(pointId) : pointsBySeqId.get(Number.parseInt(pointId, 10))

    if (point) {
      found.push(point)
    } else {
      notFound.push(pointId)
    }
  }

  return {found, notFound}
}

/**
 * Résout les points selon le mode de sélection.
 * Trois modes possibles :
 * 1. pointIds seul : liste explicite de points
 * 2. preleveurId seul : tous les points du préleveur
 * 3. preleveurId + pointIds : filtre les points du préleveur par les IDs fournis
 *
 * @param {Object} params - Paramètres
 * @param {string} params.pointIdsStr - Liste d'IDs de points (optionnel) - numériques ou ObjectIds
 * @param {number|string} params.preleveurId - ID du préleveur (optionnel) - numérique ou ObjectId
 * @param {string} params.territoire - Code territoire
 * @returns {Promise<{resolvedPoints: Array, notFound: Array}>}
 */
export async function resolvePointsForAggregation({pointIdsStr, preleveurId, territoire}) {
  if (preleveurId && pointIdsStr) {
    // Mode 3 : preleveurId + pointIds → filtrer les points du préleveur
    const pointIds = pointIdsStr.split(',')
    const {found: preleveurPoints} = await resolvePreleveurPoints(preleveurId, territoire)

    // Filtrer les points avec la fonction testable
    const {found, notFound} = filterPointsByIds(preleveurPoints, pointIds)

    if (found.length === 0) {
      throw createHttpError(404, `Aucun point trouvé pour le préleveur ${preleveurId} avec les identifiants: ${pointIds.join(', ')}`)
    }

    return {resolvedPoints: found, notFound}
  }

  if (pointIdsStr) {
    // Mode 1 : pointIds seul → liste explicite de points (numériques ou ObjectIds)
    const pointIds = pointIdsStr.split(',')
    const {found, notFound} = await resolvePointIds(pointIds, territoire)

    if (found.length === 0) {
      throw createHttpError(404, `Aucun point de prélèvement trouvé pour les identifiants: ${pointIds.join(', ')}`)
    }

    return {resolvedPoints: found, notFound}
  }

  // Mode 2 : preleveurId seul → tous les points du préleveur
  const {found, notFound} = await resolvePreleveurPoints(preleveurId, territoire)
  return {resolvedPoints: found, notFound}
}

/**
 * Extrait les IDs de points uniques depuis une liste de séries.
 * Fonction synchrone testable.
 *
 * @param {Array} seriesList - Liste des séries
 * @returns {Array<string>} - Liste des IDs de points uniques
 */
export function extractPointIdsFromSeries(seriesList) {
  const uniquePointIds = new Set()

  for (const series of seriesList) {
    const pointId = series.computed?.point
    if (pointId) {
      uniquePointIds.add(pointId.toString())
    }
  }

  return [...uniquePointIds]
}

/**
 * Résout les séries pour un attachment donné, avec optionnellement un filtrage par pointIds.
 * Mode "attachment" : on ne tient pas compte des valeurs intégrées (onlyIntegratedDays=false),
 * on s'intéresse uniquement aux bornes classiques des séries (minDate/maxDate).
 *
 * Workflow :
 * 1. Si pointIds fournis : résoudre les points → filtrer les séries par ces points
 * 2. Sinon : récupérer toutes les séries → extraire et résoudre les points
 *
 * @param {Object} params - Paramètres
 * @param {string} params.attachmentId - ID de l'attachment (ObjectId)
 * @param {string} params.pointIdsStr - Liste d'IDs de points (optionnel) - numériques ou ObjectIds
 * @param {string} params.parameter - Paramètre à filtrer
 * @param {string} params.startDate - Date de début (optionnel)
 * @param {string} params.endDate - Date de fin (optionnel)
 * @param {string} params.territoire - Code territoire
 * @returns {Promise<{seriesList: Array, resolvedPoints: Array, notFound: Array}>}
 */
export async function resolveSeriesForAttachment({attachmentId, pointIdsStr, parameter, startDate, endDate, territoire}) {
  const attachmentObjectId = new ObjectId(attachmentId)

  // Si pointIds fourni, résoudre d'abord les points puis filtrer au niveau MongoDB
  if (pointIdsStr) {
    const pointIds = pointIdsStr.split(',')
    const {found, notFound} = await resolvePointIds(pointIds, territoire)

    if (found.length === 0) {
      // Aucun point trouvé, retourner résultat vide
      return {seriesList: [], resolvedPoints: [], notFound}
    }

    const pointObjectIds = found.map(rp => rp.objectId)

    // Récupérer les séries de l'attachment pour ces points spécifiques
    const seriesList = await listSeries({
      territoire,
      attachmentId: attachmentObjectId,
      pointIds: pointObjectIds,
      parameter,
      startDate,
      endDate,
      onlyIntegratedDays: false
    })

    // Filtrer resolvedPoints pour ne garder que ceux qui ont des séries
    const seriesPointIds = new Set(
      seriesList.map(s => s.computed?.point?.toString()).filter(Boolean)
    )

    const resolvedPoints = found.filter(rp => seriesPointIds.has(rp.objectId.toString()))

    return {seriesList, resolvedPoints, notFound}
  }

  // Pas de filtrage par pointIds : récupérer toutes les séries de l'attachment
  const seriesList = await listSeries({
    territoire,
    attachmentId: attachmentObjectId,
    parameter,
    startDate,
    endDate,
    onlyIntegratedDays: false
  })

  // Extraire les IDs de points uniques des séries
  const uniquePointIds = extractPointIdsFromSeries(seriesList)

  // Résoudre tous les points en une seule fois
  const {found: resolvedPoints} = await resolvePointIds(uniquePointIds, territoire)

  return {seriesList, resolvedPoints, notFound: []}
}

/**
 * Résout le preleveurId en ObjectId MongoDB si fourni.
 * @param {number|string} preleveurId - ID numérique ou ObjectId du préleveur
 * @param {string} territoire - Code territoire
 * @returns {Promise<ObjectId|null>} - ObjectId du préleveur ou null
 */
export async function resolvePreleveurObjectId(preleveurId, territoire) {
  if (!preleveurId) {
    return null
  }

  const preleveur = await resolvePreleveurById(preleveurId, territoire)
  return preleveur ? preleveur._id : null
}

/**
 * Résout les points et les séries selon le mode (attachment, préleveur, ou points directs)
 * @returns {Promise<{resolvedPoints: Array, notFound: Array, seriesList: Array}>}
 */
async function resolvePointsAndSeries({attachmentId, pointIdsStr, preleveurId, parameter, startDate, endDate, territoire}) {
  if (attachmentId) {
    // Mode attachment : utiliser resolveSeriesForAttachment
    return resolveSeriesForAttachment({
      attachmentId,
      pointIdsStr,
      parameter,
      startDate,
      endDate,
      territoire
    })
  }

  // Mode classique (préleveur ou points)
  const {resolvedPoints, notFound} = await resolvePointsForAggregation({
    pointIdsStr,
    preleveurId,
    territoire
  })

  const pointObjectIds = resolvedPoints.map(rp => rp.objectId)
  const preleveurObjectId = await resolvePreleveurObjectId(preleveurId, territoire)

  // Récupérer les séries (avec onlyIntegratedDays=true pour le mode classique)
  const seriesList = await listSeries({
    territoire,
    pointIds: pointObjectIds,
    preleveurId: preleveurObjectId,
    parameter,
    startDate,
    endDate,
    onlyIntegratedDays: true
  })

  return {resolvedPoints, notFound, seriesList}
}

/**
 * Handler Express pour l'agrégation de séries.
 * Point d'entrée principal de l'API d'agrégation spatiale et temporelle.
 *
 * Workflow complet en 9 étapes :
 * 1. Validation des paramètres de requête (pointIds/preleveurId/attachmentId, dates, fréquence)
 * 2. Détermination des opérateurs (défaut si non spécifiés)
 * 3. Validation de l'opérateur temporel
 * 4. Résolution des points et séries selon le mode (attachment, préleveur, ou points directs)
 * 5. Détection de l'overlap temporel et validation fail-fast
 * 6. Validation de l'opérateur spatial (si applicable)
 * 7. Récupération des valeurs (brutes ou dailyAggregates selon le cas)
 * 8. Agrégation SPATIALE : combine les valeurs de plusieurs points par période
 * 9. Agrégation TEMPORELLE : regroupe les valeurs journalières en périodes (mois/trimestre/année)
 *
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
// eslint-disable-next-line complexity
export async function getAggregatedSeriesHandler(req, res) {
  // 1. Validation des paramètres
  const validated = validateQueryParams(req.query)
  const {pointIds: pointIdsStr, preleveurId, attachmentId, parameter, startDate: startDateStr, endDate: endDateStr, aggregationFrequency} = validated

  // Validation des dates
  const startDate = validateDate(startDateStr, 'startDate')
  const endDate = validateDate(endDateStr, 'endDate')

  if (startDate && endDate && startDate > endDate) {
    throw createHttpError(400, 'Le paramètre startDate doit être antérieur ou égal à endDate')
  }

  // 2. Déterminer les opérateurs (défaut si non spécifiés)
  const spatialOperator = validated.spatialOperator
    || getDefaultOperator(parameter, 'spatial')

  const temporalOperator = validated.temporalOperator
    || getDefaultOperator(parameter, 'temporal')

  // 3. Valider que les opérateurs sont autorisés dans leur contexte respectif
  // Note : La validation spatiale n'est nécessaire que si agrégation spatiale réelle (plusieurs séries)
  // Validation temporelle toujours nécessaire
  try {
    validateOperatorForParameter(parameter, temporalOperator, 'temporal')
  } catch (error) {
    Sentry.captureException(error)
    throw createHttpError(400, error.message)
  }

  const parameterConfig = parametersConfig[parameter]

  // 4. Résoudre les points et séries selon le mode
  const {resolvedPoints, notFound, seriesList} = await resolvePointsAndSeries({
    attachmentId,
    pointIdsStr,
    preleveurId,
    parameter,
    startDate,
    endDate,
    territoire: req.territoire.code
  })

  // 5. Détecter l'overlap temporel et valider l'opérateur spatial
  const hasOverlap = detectTemporalOverlapInSeries(seriesList)

  // Si overlap détecté et paramètre sans sum spatial → erreur
  if (hasOverlap && parameterConfig.spatialOperators.length === 0) {
    const allowedOps = parameterConfig.temporalOperators.join(', ')
    throw createHttpError(
      400,
      `Le paramètre "${parameter}" ne peut pas être agrégé spatialement car plusieurs séries `
      + 'ont des données simultanées sur les points sélectionnés. '
      + `Ce paramètre ne supporte que les opérateurs temporels : ${allowedOps}.`
    )
  }

  // 6. Valider l'opérateur spatial si fourni ou si paramètre supporte l'agrégation spatiale
  if (validated.spatialOperator && parameterConfig.spatialOperators.length === 0) {
    throw createHttpError(
      400,
      `Le paramètre "${parameter}" ne supporte pas l'agrégation spatiale. `
      + 'Seule l\'agrégation temporelle est possible pour ce paramètre.'
    )
  }

  if (parameterConfig.spatialOperators.length > 0) {
    try {
      validateOperatorForParameter(parameter, spatialOperator, 'spatial')
    } catch (error) {
      Sentry.captureException(error)
      throw createHttpError(400, error.message)
    }
  }

  // Si aucune série trouvée, retourner réponse vide avec métadonnées
  if (seriesList.length === 0) {
    return res.send({
      metadata: {
        parameter,
        unit: parameterConfig.unit,
        spatialOperator,
        temporalOperator,
        frequency: aggregationFrequency,
        ...(attachmentId ? {attachmentId} : {}),
        ...(preleveurId ? {preleveurId} : {}),
        points: resolvedPoints.map(rp => ({
          _id: rp.objectId,
          id_point: rp.seqId,
          nom: rp.point.nom
        })),
        ...(notFound.length > 0 ? {pointsNotFound: notFound} : {}),
        startDate: startDate || null,
        endDate: endDate || null
      },
      values: []
    })
  }

  // 7. Récupérer toutes les valeurs (ou dailyAggregates pour infra-journalier)
  const {valuesBySeriesId, usesDailyAggregates} = await fetchAllSeriesValues(seriesList, startDate, endDate, aggregationFrequency)

  // 8. Agréger les valeurs par date ou période (agrégation spatiale si nécessaire)
  // Note : Si séries consécutives (pas d'overlap), il n'y aura qu'une valeur par période,
  // donc l'opérateur d'agrégation retournera juste cette valeur unique (quelle que soit l'opération)
  const aggregatedByPeriod = aggregateValuesByDate(valuesBySeriesId, seriesList, {
    spatialOperator,
    aggregationFrequency,
    temporalOperator
  })

  // 9. Agréger temporellement si nécessaire (jour → mois → année)
  // Note : pour les fréquences infra-journalières, on ne fait pas d'agrégation temporelle supplémentaire
  const isSubDailyFrequency = SUB_DAILY_FREQUENCIES.includes(aggregationFrequency)
  const aggregatedValues = isSubDailyFrequency
    ? aggregatedByPeriod
    : aggregateDailyValuesToPeriod(aggregatedByPeriod, aggregationFrequency, temporalOperator)

  const minDate = aggregatedValues.length > 0 ? aggregatedValues[0].date : null
  const maxDate = aggregatedValues.length > 0 ? aggregatedValues.at(-1).date : null

  const metadata = buildAggregationMetadata({
    parameter,
    unit: parameterConfig.unit,
    spatialOperator,
    temporalOperator,
    aggregationFrequency,
    pointIdsStr,
    preleveurId,
    resolvedPoints,
    notFound,
    startDate,
    endDate
  })

  // Ajouter attachmentId si présent
  if (attachmentId) {
    metadata.attachmentId = attachmentId
  }

  res.send({
    metadata: {
      ...metadata,
      usesDailyAggregates,
      minDate,
      maxDate,
      seriesCount: seriesList.length,
      valuesCount: aggregatedValues.length
    },
    values: aggregatedValues
  })
}
