import Joi from 'joi'
import createHttpError from 'http-errors'
import {listSeries} from '../models/series.js'
import {parametersConfig} from '../parameters-config.js'

/**
 * Import des fonctions depuis series-aggregation.js
 */
import {
  resolvePointsForAggregation,
  resolveSeriesForAttachment,
  detectTemporalOverlapInSeries,
  resolvePreleveurObjectId
} from './series-aggregation.js'

/**
 * Patterns de validation pour les identifiants
 */
const OBJECT_ID_PATTERN = /^[\da-fA-F]{24}$/
const POINT_IDS_PATTERN = /^([\da-fA-F]{24}|\d+)(,([\da-fA-F]{24}|\d+))*$/

/**
 * Schéma de validation Joi pour les paramètres de requête
 * Accepte les IDs numériques (id_point, id_preleveur) ou les ObjectId MongoDB
 */
const optionsQuerySchema = Joi.object({
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
      'alternatives.match': 'Le paramètre preleveurId doit être un entier positif ou un ObjectId valide'
    }),
  attachmentId: Joi.string()
    .pattern(OBJECT_ID_PATTERN)
    .messages({
      'string.base': 'Le paramètre attachmentId doit être une chaîne de caractères',
      'string.pattern.base': 'Le paramètre attachmentId doit être un ObjectId valide (24 caractères hexadécimaux)'
    })
})
  .or('pointIds', 'preleveurId', 'attachmentId')
  .messages({
    'object.missing': 'Vous devez fournir au moins pointIds, preleveurId ou attachmentId'
  })

/**
 * Valide les paramètres de requête
 */
function validateQueryParams(query) {
  const {error, value} = optionsQuerySchema.validate(query, {
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
 * Calcule les dates min/max depuis les integratedDays d'une liste de séries
 * @param {Array} series - Liste des séries contenant computed.integratedDays
 * @returns {{minDate: string|null, maxDate: string|null}}
 */
export function calculateDateRangeFromIntegratedDays(series) {
  const allDates = []

  for (const s of series) {
    if (s.computed?.integratedDays && Array.isArray(s.computed.integratedDays)) {
      allDates.push(...s.computed.integratedDays)
    }
  }

  return calculateMinMaxFromDates(allDates)
}

/**
 * Calcule les dates min/max depuis les minDate/maxDate des séries.
 * Version pour le mode attachment (sans integratedDays).
 * @param {Array} series - Liste des séries contenant minDate et maxDate
 * @returns {{minDate: string|null, maxDate: string|null}}
 */
export function calculateDateRangeFromMinMax(series) {
  const allDates = []

  for (const s of series) {
    if (s.minDate) {
      allDates.push(s.minDate)
    }

    if (s.maxDate) {
      allDates.push(s.maxDate)
    }
  }

  return calculateMinMaxFromDates(allDates)
}

/**
 * Calcule les dates min/max depuis un tableau de dates
 * @param {Array<string>} dates - Tableau de dates au format YYYY-MM-DD
 * @returns {{minDate: string|null, maxDate: string|null}}
 */
export function calculateMinMaxFromDates(dates) {
  // Filtrer les valeurs null/undefined
  const validDates = dates.filter(d => d !== null && d !== undefined)

  if (validDates.length === 0) {
    return {minDate: null, maxDate: null}
  }

  // Tri des dates (format YYYY-MM-DD)
  validDates.sort()

  return {
    minDate: validDates[0],
    maxDate: validDates.at(-1)
  }
}

/**
 * Groupe les séries par paramètre et calcule les métadonnées
 * @param {Array} series - Liste des séries
 * @param {boolean} useIntegratedDays - Si true, utilise integratedDays, sinon minDate/maxDate
 * @returns {Array} - Liste des paramètres avec leurs métadonnées
 */
export function groupSeriesByParameter(series, useIntegratedDays = true) {
  // Grouper par paramètre
  const parameterMap = new Map()

  for (const s of series) {
    if (!parameterMap.has(s.parameter)) {
      parameterMap.set(s.parameter, [])
    }

    parameterMap.get(s.parameter).push(s)
  }

  // Construire la réponse pour chaque paramètre
  const parameters = []

  for (const [parameterName, parameterSeries] of parameterMap.entries()) {
    // Vérifier si le paramètre est supporté dans la config
    const config = parametersConfig[parameterName]

    if (!config) {
      // Paramètre non supporté, on l'ignore
      continue
    }

    // Calculer les dates min/max selon le mode
    const {minDate, maxDate} = useIntegratedDays
      ? calculateDateRangeFromIntegratedDays(parameterSeries)
      : calculateDateRangeFromMinMax(parameterSeries)

    // Détecter overlap temporel POUR CE PARAMÈTRE uniquement
    const hasOverlap = useIntegratedDays
      ? detectTemporalOverlapInSeries(parameterSeries)
      : false

    // Filtrage : si overlap détecté et paramètre incompatible → ne pas l'inclure dans les options
    if (hasOverlap && config.spatialOperators.length === 0) {
      // Ce paramètre n'est pas agrégable spatialement avec overlap → on le saute
      continue
    }

    parameters.push({
      name: parameterName,
      unit: config.unit,
      valueType: config.valueType,
      spatialOperators: config.spatialOperators,
      temporalOperators: config.temporalOperators,
      defaultSpatialOperator: config.defaultSpatialOperator,
      defaultTemporalOperator: config.defaultTemporalOperator,
      warning: config.warning,
      hasTemporalOverlap: hasOverlap,
      minDate,
      maxDate,
      seriesCount: parameterSeries.length,
      availableFrequencies: config.availableFrequencies
    })
  }

  // Trier par nom de paramètre
  parameters.sort((a, b) => a.name.localeCompare(b.name))

  return parameters
}

/**
 * Handler Express pour récupérer les options disponibles pour l'agrégation de séries
 * Retourne les paramètres disponibles avec leurs plages de dates, conditionnés par le ciblage
 */
export async function getAggregatedSeriesOptionsHandler(req, res) {
  // 1. Validation des paramètres
  const validated = validateQueryParams(req.query)
  const {pointIds: pointIdsStr, preleveurId, attachmentId} = validated
  const territoire = req.territoire.code

  let allSeries = []
  let points = []

  if (attachmentId) {
    // Mode attachment : récupérer séries sans filtrage par integratedDays
    const {seriesList, resolvedPoints} = await resolveSeriesForAttachment({
      attachmentId,
      pointIdsStr,
      territoire
    })

    allSeries = seriesList
    points = resolvedPoints.map(rp => ({
      _id: rp.objectId,
      id_point: rp.seqId,
      nom: rp.point.nom
    }))

    // Grouper par paramètre (sans integratedDays)
    const parameters = groupSeriesByParameter(allSeries, false)

    return res.json({parameters, points})
  }

  // Mode classique : utiliser resolvePointsForAggregation
  const {resolvedPoints} = await resolvePointsForAggregation({
    pointIdsStr,
    preleveurId,
    territoire
  })

  // Extraire les ObjectIds des points
  const pointObjectIds = resolvedPoints.map(rp => rp.objectId)

  // Résoudre le preleveurId en ObjectId si fourni
  const preleveurObjectId = await resolvePreleveurObjectId(preleveurId, territoire)

  // Récupérer toutes les séries pour ces points (avec onlyIntegratedDays=true)
  allSeries = await listSeries({
    territoire,
    pointIds: pointObjectIds,
    preleveurId: preleveurObjectId,
    onlyIntegratedDays: true
  })

  // Grouper par paramètre et calculer les métadonnées (avec integratedDays)
  const parameters = groupSeriesByParameter(allSeries, true)

  // Préparer la liste des points résolus
  points = resolvedPoints.map(rp => ({
    _id: rp.objectId,
    id_point: rp.seqId,
    nom: rp.point.nom
  }))

  // Construire la réponse
  res.json({
    parameters,
    points
  })
}
