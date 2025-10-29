import Joi from 'joi'
import createHttpError from 'http-errors'
import {ObjectId} from '../util/mongo.js'
import {getPointBySeqId, getPointsFromPreleveur, getPointPrelevement} from '../models/point-prelevement.js'
import {getPreleveurBySeqId, getPreleveur} from '../models/preleveur.js'
import {listSeries, getSeriesValuesInRange} from '../models/series.js'
import {
  isParameterSupported,
  getDefaultOperator,
  isOperatorValidForParameter,
  getAvailableOperators,
  getParameterValueType
} from '../parameters-config.js'

/**
 * Schéma de validation Joi pour les paramètres de requête d'agrégation
 * Accepte les IDs numériques (id_point, id_preleveur) ou les ObjectId MongoDB
 */
const aggregatedSeriesQuerySchema = Joi.object({
  pointIds: Joi.string()
    .pattern(/^([\da-fA-F]{24}|\d+)(,([\da-fA-F]{24}|\d+))*$/)
    .messages({
      'string.base': 'Le paramètre pointIds doit être une chaîne de caractères',
      'string.empty': 'Le paramètre pointIds ne peut pas être vide',
      'string.pattern.base': 'Le paramètre pointIds doit être une liste d\'identifiants (numériques ou ObjectId) séparés par des virgules (ex: 207,208,209 ou 507f1f77bcf86cd799439011,507f191e810c19729de860ea)'
    }),
  preleveurId: Joi.alternatives()
    .try(
      Joi.number().integer().positive(),
      Joi.string().pattern(/^[\da-fA-F]{24}$/)
    )
    .messages({
      'alternatives.match': 'Le paramètre preleveurId doit être un nombre entier positif ou un ObjectId valide (24 caractères hexadécimaux)'
    }),
  parameter: Joi.string()
    .required()
    .messages({
      'string.base': 'Le paramètre parameter doit être une chaîne de caractères',
      'string.empty': 'Le paramètre parameter est obligatoire',
      'any.required': 'Le paramètre parameter est obligatoire'
    }),
  operator: Joi.string()
    .valid('sum', 'mean', 'min', 'max')
    .messages({
      'string.base': 'Le paramètre operator doit être une chaîne de caractères',
      'any.only': 'Le paramètre operator doit être l\'un des suivants: sum, mean, min, max'
    }),
  aggregationFrequency: Joi.string()
    .valid('15 minutes', '1 hour', '6 hours', '1 day', '1 month', '1 year')
    .default('1 day')
    .messages({
      'string.base': 'Le paramètre aggregationFrequency doit être une chaîne de caractères',
      'any.only': 'Le paramètre aggregationFrequency doit être l\'un des suivants: 15 minutes, 1 hour, 6 hours, 1 day, 1 month, 1 year'
    }),
  from: Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}$/)
    .messages({
      'string.base': 'Le paramètre from doit être une chaîne de caractères',
      'string.pattern.base': 'Le paramètre from doit être au format YYYY-MM-DD'
    }),
  to: Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}$/)
    .messages({
      'string.base': 'Le paramètre to doit être une chaîne de caractères',
      'string.pattern.base': 'Le paramètre to doit être au format YYYY-MM-DD'
    })
})
  .or('pointIds', 'preleveurId')
  .messages({
    'object.missing': 'Vous devez fournir au moins pointIds ou preleveurId'
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
  return typeof id === 'string' && /^[\da-fA-F]{24}$/.test(id)
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
 * Récupère toutes les séries journalières pour les points donnés.
 * Utilise listSeries avec filtrage direct sur parameter et frequency.
 *
 * @param {Object} params - Paramètres de recherche
 * @param {string} params.territoire - Code territoire
 * @param {ObjectId[]} params.pointObjectIds - Liste des ObjectIds des points
 * @param {string} params.parameter - Nom du paramètre à récupérer
 * @param {string} params.from - Date de début (YYYY-MM-DD)
 * @param {string} params.to - Date de fin (YYYY-MM-DD)
 * @returns {Promise<Array>} - Liste de toutes les séries trouvées
 */
async function fetchSeriesForAggregation({territoire, pointObjectIds, parameter, from, to}) {
  // Récupérer les séries pour chaque point en parallèle, avec filtrage sur parameter et frequency
  const seriesPromises = pointObjectIds.map(pointOid =>
    listSeries({
      territoire,
      pointId: pointOid,
      parameter,
      from,
      to,
      onlyIntegratedDays: true
    })
  )

  const seriesResults = await Promise.all(seriesPromises)

  // Aplatir les résultats
  return seriesResults.flat()
}

/**
 * Récupère les valeurs de toutes les séries dans la plage de dates.
 * Pour les séries infra-journalières, récupère les dailyAggregates pré-calculés
 * SAUF si aggregationFrequency est infra-journalière (dans ce cas, on veut les valeurs brutes).
 * Pour les séries journalières, récupère les valeurs brutes.
 *
 * @param {Array} seriesList - Liste des séries avec leur _id et frequency
 * @param {string} from - Date de début (YYYY-MM-DD)
 * @param {string} to - Date de fin (YYYY-MM-DD)
 * @param {string} aggregationFrequency - Fréquence d'agrégation demandée
 * @returns {Promise<{valuesBySeriesId: Map, usesDailyAggregates: boolean}>}
 */
async function fetchAllSeriesValues(seriesList, from, to, aggregationFrequency) {
  const valuesBySeriesId = new Map()

  // Déterminer si on a des séries infra-journalières
  const hasSubDailySeries = seriesList.some(s => s.frequency !== '1 day')

  // Si aggregationFrequency est infra-journalière, on veut les valeurs brutes
  const needsRawValues = ['15 minutes', '1 hour', '6 hours'].includes(aggregationFrequency)

  await Promise.all(
    seriesList.map(async series => {
      const seriesId = series._id
      const isSubDaily = series.frequency !== '1 day'

      // Pour les séries infra-journalières :
      // - Si on veut une fréquence infra-journalière → valeurs brutes
      // - Sinon → dailyAggregates
      // Pour les séries journalières : toujours valeurs brutes
      const useAggregates = isSubDaily && !needsRawValues

      const values = await getSeriesValuesInRange(seriesId, {
        start: from,
        end: to,
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
 *
 * @param {Array} values - Tableau de valeurs (peut contenir des valeurs invalides)
 * @param {string} operator - Opérateur d'agrégation ('sum', 'mean', 'min', 'max')
 * @returns {number|null} - Résultat de l'agrégation, ou null si aucune valeur valide
 */
export function applyAggregationOperator(values, operator) {
  if (!Array.isArray(values) || values.length === 0) {
    return null
  }

  // Filtrer les valeurs valides (numériques et finies)
  const validValues = values.filter(v =>
    typeof v === 'number'
    && !Number.isNaN(v)
    && Number.isFinite(v)
  )

  if (validValues.length === 0) {
    return null
  }

  switch (operator) {
    case 'sum': {
      return validValues.reduce((acc, v) => acc + v, 0)
    }

    case 'mean': {
      const sum = validValues.reduce((acc, v) => acc + v, 0)
      return sum / validValues.length
    }

    case 'min': {
      return Math.min(...validValues)
    }

    case 'max': {
      return Math.max(...validValues)
    }

    default: {
      throw new Error(`Opérateur inconnu: ${operator}`)
    }
  }
}

/**
 * Vérifie si une valeur est valide pour l'agrégation.
 * @param {*} value - Valeur à vérifier
 * @returns {boolean}
 */
function isValidValue(value) {
  return value !== null && value !== undefined && !Number.isNaN(value)
}

/**
 * Extrait les valeurs d'un document selon le type de série et l'agrégation demandée.
 * @param {Object} valueDoc - Document de valeur
 * @param {Object} context - Contexte d'agrégation
 * @param {boolean} context.isSubDaily - Si la série est infra-journalière
 * @param {boolean} context.useAggregates - Si on utilise les dailyAggregates
 * @param {string} context.operator - Opérateur d'agrégation
 * @param {string} context.valueType - Type de valeur du paramètre
 * @param {string} context.aggregationFrequency - Fréquence d'agrégation demandée
 * @returns {Array<{period: string, value: number}>} - Liste des valeurs avec leur période
 */
export function extractValuesFromDocument(valueDoc, context) {
  const {isSubDaily, useAggregates, operator, valueType, aggregationFrequency} = context
  const {date} = valueDoc
  const results = []
  const isSubDailyAggregation = ['15 minutes', '1 hour', '6 hours'].includes(aggregationFrequency)

  if (isSubDaily && !useAggregates) {
    // Cas 1 : Séries infra-journalières avec valeurs brutes
    const rawValues = Array.isArray(valueDoc.values) ? valueDoc.values : []

    for (const {time, value} of rawValues) {
      if (!isValidValue(value)) {
        continue
      }

      const period = isSubDailyAggregation
        ? extractSubDailyPeriod(date, time, aggregationFrequency)
        : date

      results.push({period, value})
    }
  } else if (isSubDaily && valueDoc.dailyAggregates) {
    // Cas 2 : Séries infra-journalières avec dailyAggregates
    const {dailyAggregates} = valueDoc
    let value = null

    switch (operator) {
      case 'sum': {
        value = valueType === 'cumulative' ? dailyAggregates.sum : null
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
        throw new Error(`Opérateur inconnu: ${operator}`)
      }
    }

    if (isValidValue(value)) {
      results.push({period: date, value})
    }
  } else {
    // Cas 3 : Séries journalières
    const value = valueDoc.values?.value

    if (isValidValue(value)) {
      results.push({period: date, value})
    }
  }

  return results
}

/**
 * Agrège les valeurs par date ou par période infra-journalière.
 * Gère trois cas :
 * - Séries journalières : agrège les values.value
 * - Séries infra-journalières avec dailyAggregates : agrège les dailyAggregates
 * - Séries infra-journalières avec valeurs brutes : agrège par période (15min/1h/6h)
 *
 * @param {Map} valuesBySeriesId - Map<seriesId, {values, isSubDaily, useAggregates}>
 * @param {Array} seriesList - Liste des séries
 * @param {Object} aggregationContext - Contexte d'agrégation
 * @returns {Array} - [{date, value}, ...]
 */
function aggregateValuesByDate(valuesBySeriesId, seriesList, aggregationContext) {
  const {operator, parameter, aggregationFrequency} = aggregationContext
  const valuesByPeriod = new Map()
  const valueType = getParameterValueType(parameter)

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
        operator,
        valueType,
        aggregationFrequency
      })

      for (const {period, value} of extractedValues) {
        if (!valuesByPeriod.has(period)) {
          valuesByPeriod.set(period, [])
        }

        valuesByPeriod.get(period).push(value)
      }
    }
  }

  // Appliquer l'opérateur d'agrégation pour chaque période
  const aggregatedValues = []
  for (const [period, values] of valuesByPeriod.entries()) {
    const aggregatedValue = applyAggregationOperator(values, operator)
    if (aggregatedValue !== null) {
      aggregatedValues.push({date: period, value: aggregatedValue})
    }
  }

  // Trier par période
  aggregatedValues.sort((a, b) => a.date.localeCompare(b.date))

  return aggregatedValues
}

/**
 * Extrait la période (mois ou année) d'une date au format YYYY-MM-DD.
 * @param {string} date - Date au format YYYY-MM-DD
 * @param {string} frequency - '1 month' ou '1 year'
 * @returns {string} - Période au format YYYY-MM (mois) ou YYYY (année)
 */
export function extractPeriod(date, frequency) {
  if (frequency === '1 month') {
    return date.slice(0, 7) // YYYY-MM
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
 * Agrège des valeurs journalières par période (mois ou année).
 * Regroupe les valeurs par période puis applique l'opérateur d'agrégation.
 *
 * @param {Array} dailyValues - [{date: 'YYYY-MM-DD', value: number}, ...]
 * @param {string} frequency - '1 month' ou '1 year'
 * @param {string} operator - Opérateur d'agrégation ('sum', 'mean', 'min', 'max')
 * @returns {Array} - [{date: 'YYYY-MM' ou 'YYYY', value: number}, ...]
 */
export function aggregateValuesByPeriod(dailyValues, frequency, operator) {
  if (frequency === '1 day') {
    return dailyValues // Pas d'agrégation temporelle nécessaire
  }

  const valuesByPeriod = new Map()

  // Regrouper les valeurs par période
  for (const {date, value} of dailyValues) {
    const period = extractPeriod(date, frequency)

    if (!valuesByPeriod.has(period)) {
      valuesByPeriod.set(period, [])
    }

    valuesByPeriod.get(period).push(value)
  }

  // Appliquer l'opérateur d'agrégation pour chaque période
  const aggregatedValues = []
  for (const [period, values] of valuesByPeriod.entries()) {
    const aggregatedValue = applyAggregationOperator(values, operator)
    if (aggregatedValue !== null) {
      aggregatedValues.push({date: period, value: aggregatedValue})
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
  operator,
  aggregationFrequency,
  pointIdsStr,
  preleveurId,
  resolvedPoints,
  notFound,
  from,
  to
}) {
  const metadata = {
    parameter,
    unit,
    operator,
    frequency: aggregationFrequency,
    from: from || null,
    to: to || null
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
    seqId: rp.seqId,
    code: rp.point.code,
    name: rp.point.nom
  }))

  return metadata
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
async function resolvePointsForAggregation({pointIdsStr, preleveurId, territoire}) {
  if (preleveurId && pointIdsStr) {
    // Mode 3 : preleveurId + pointIds → filtrer les points du préleveur
    const pointIds = pointIdsStr.split(',')
    const {found: preleveurPoints} = await resolvePreleveurPoints(preleveurId, territoire)

    // Créer un Map pour lookup rapide par seqId ET par ObjectId
    const pointsBySeqId = new Map(preleveurPoints.map(p => [p.seqId, p]))
    const pointsByOid = new Map(preleveurPoints.map(p => [p.objectId.toString(), p]))

    // Filtrer : garder seulement les points qui appartiennent au préleveur
    const found = []
    const notFound = []

    for (const pointId of pointIds) {
      const isOid = isObjectId(pointId)
      const point = isOid ? pointsByOid.get(pointId) : pointsBySeqId.get(Number.parseInt(pointId, 10))

      if (point) {
        found.push(point)
      } else {
        notFound.push(pointId)
      }
    }

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
 * Handler Express pour l'agrégation de séries
 */
export async function getAggregatedSeriesHandler(req, res) {
  // 1. Validation des paramètres
  const validated = validateQueryParams(req.query)
  const {pointIds: pointIdsStr, preleveurId, parameter, from: fromStr, to: toStr, aggregationFrequency} = validated

  // Validation des dates
  const from = validateDate(fromStr, 'from')
  const to = validateDate(toStr, 'to')

  if (from && to && from > to) {
    throw createHttpError(400, 'Le paramètre from doit être antérieur ou égal à to')
  }

  // 2. Vérifier que le paramètre est supporté
  if (!isParameterSupported(parameter)) {
    throw createHttpError(400, `Le paramètre "${parameter}" n'est pas supporté pour l'agrégation`)
  }

  // 3. Déterminer l'opérateur
  const operator = validated.operator || getDefaultOperator(parameter)

  if (!isOperatorValidForParameter(parameter, operator)) {
    const availableOps = getAvailableOperators(parameter)
    throw createHttpError(
      400,
      `L'opérateur "${operator}" n'est pas valide pour le paramètre "${parameter}". Opérateurs disponibles: ${availableOps.join(', ')}`
    )
  }

  // 4. Résoudre les points (seqId → ObjectId ou préleveur → points)
  const {resolvedPoints, notFound} = await resolvePointsForAggregation({
    pointIdsStr,
    preleveurId,
    territoire: req.territoire.code
  })

  // Si mode préleveur et aucun point, retourner réponse vide
  if (preleveurId && resolvedPoints.length === 0) {
    return res.send({
      metadata: {
        parameter,
        unit: null,
        operator,
        frequency: aggregationFrequency,
        preleveurId,
        points: [],
        from: from || null,
        to: to || null
      },
      values: []
    })
  }

  const pointObjectIds = resolvedPoints.map(rp => rp.objectId)

  // 5. Récupérer les séries
  const seriesList = await fetchSeriesForAggregation({
    territoire: req.territoire.code,
    pointObjectIds,
    parameter,
    from,
    to
  })

  if (seriesList.length === 0) {
    // Pas de séries trouvées, retourner une réponse vide avec métadonnées
    return res.send({
      metadata: {
        parameter,
        unit: null,
        operator,
        frequency: aggregationFrequency,
        ...(preleveurId ? {preleveurId} : {}),
        points: resolvedPoints.map(rp => ({
          id_point: rp.seqId,
          _id: rp.objectId,
          nom: rp.point.nom
        })),
        pointsNotFound: notFound,
        from: from || null,
        to: to || null
      },
      values: []
    })
  }

  // 6. Récupérer toutes les valeurs (ou dailyAggregates pour infra-journalier)
  const {valuesBySeriesId, usesDailyAggregates} = await fetchAllSeriesValues(seriesList, from, to, aggregationFrequency)

  // 7. Agréger les valeurs par date ou période (agrégation spatiale multi-points)
  const aggregatedByPeriod = aggregateValuesByDate(valuesBySeriesId, seriesList, {
    operator,
    parameter,
    aggregationFrequency
  })

  // 8. Agréger temporellement si nécessaire (jour → mois → année)
  // Note : pour les fréquences infra-journalières, on ne fait pas d'agrégation temporelle supplémentaire
  const isSubDailyFrequency = ['15 minutes', '1 hour', '6 hours'].includes(aggregationFrequency)
  const aggregatedValues = isSubDailyFrequency
    ? aggregatedByPeriod
    : aggregateValuesByPeriod(aggregatedByPeriod, aggregationFrequency, operator)

  // 9. Construire la réponse
  const minDate = aggregatedValues.length > 0 ? aggregatedValues[0].date : null
  const maxDate = aggregatedValues.length > 0 ? aggregatedValues.at(-1).date : null

  const metadata = buildAggregationMetadata({
    parameter,
    unit: seriesList[0]?.unit || null,
    operator,
    aggregationFrequency,
    pointIdsStr,
    preleveurId,
    resolvedPoints,
    notFound,
    from,
    to
  })

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
