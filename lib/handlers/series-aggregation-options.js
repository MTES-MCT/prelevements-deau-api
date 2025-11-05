import Joi from 'joi'
import createHttpError from 'http-errors'
import {listSeries} from '../models/series.js'
import {parametersConfig} from '../parameters-config.js'

/**
 * Import de la fonction resolvePointsForAggregation depuis series-aggregation.js
 * Cette fonction est réutilisée pour résoudre les points selon le même mécanisme
 */
import {resolvePointsForAggregation} from './series-aggregation.js'

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
      'string.pattern.base': 'Le paramètre pointIds doit être une liste d\'identifiants (numériques ou ObjectId) séparés par des virgules (ex: 207,208,209 ou 507f1f77bcf86cd799439011,507f191e810c19729de860ea)'
    }),
  preleveurId: Joi.alternatives()
    .try(
      Joi.number().integer().positive(),
      Joi.string().pattern(OBJECT_ID_PATTERN)
    )
    .messages({
      'alternatives.match': 'Le paramètre preleveurId doit être un nombre entier positif ou un ObjectId valide (24 caractères hexadécimaux)'
    })
})
  .or('pointIds', 'preleveurId')
  .messages({
    'object.missing': 'Vous devez fournir au moins pointIds ou preleveurId'
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

  if (allDates.length === 0) {
    return {minDate: null, maxDate: null}
  }

  // Tri des dates (format YYYY-MM-DD)
  allDates.sort()

  return {
    minDate: allDates[0],
    maxDate: allDates.at(-1)
  }
}

/**
 * Groupe les séries par paramètre et calcule les métadonnées
 * @param {Array} series - Liste des séries
 * @returns {Array} - Liste des paramètres avec leurs métadonnées
 */
function groupSeriesByParameter(series) {
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

    // Calculer les dates min/max depuis les integratedDays
    const {minDate, maxDate} = calculateDateRangeFromIntegratedDays(parameterSeries)

    parameters.push({
      name: parameterName,
      unit: config.unit,
      valueType: config.valueType,
      minDate,
      maxDate,
      seriesCount: parameterSeries.length
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
  const {pointIds: pointIdsStr, preleveurId} = validated
  const territoire = req.territoire.code

  // 2. Résoudre les points selon le mode de sélection
  const {resolvedPoints} = await resolvePointsForAggregation({
    pointIdsStr,
    preleveurId,
    territoire
  })

  // 3. Extraire les ObjectIds des points
  const pointObjectIds = resolvedPoints.map(rp => rp.objectId)

  // 4. Récupérer toutes les séries pour ces points (avec onlyIntegratedDays=true)
  // Note : listSeries accepte un seul pointId, donc on doit appeler pour chaque point
  const seriesPromises = pointObjectIds.map(pointId =>
    listSeries({
      territoire,
      pointId,
      onlyIntegratedDays: true
    })
  )

  const seriesResults = await Promise.all(seriesPromises)

  // Aplatir les résultats
  const allSeries = seriesResults.flat()

  // 5. Grouper par paramètre et calculer les métadonnées
  const parameters = groupSeriesByParameter(allSeries)

  // 6. Préparer la liste des points résolus
  const points = resolvedPoints.map(rp => ({
    _id: rp.objectId,
    id_point: rp.seqId,
    nom: rp.point.nom
  }))

  // 7. Construire la réponse
  res.json({
    parameters,
    points
  })
}
