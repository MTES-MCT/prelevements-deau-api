import mongo from '../util/mongo.js'
// ObjectId import not needed explicitly; using insertedIds mapping from insertMany

/**
 * Mapping des fréquences vers leur durée en heures
 */
const FREQUENCY_TO_HOURS = {
  '1 second': 1 / 3600,
  '1 minute': 1 / 60,
  '15 minutes': 0.25,
  '1 hour': 1
}

/*
Series document shape:
{
  _id,
  attachmentId, dossierId,
  territoire,
  pointPrelevement, parameter, unit, frequency, valueType,
  originalFrequency?, // Fréquence d'origine avant expansion (pour volumes mensuels/trimestriels/annuels)
  minDate, maxDate, extras, hasSubDaily,
  hash,
  createdAt, updatedAt,
  computed? { preleveur?, point?, dossierStatus?, integratedDays?, updatedAt? }
}

Series values (daily): { _id, seriesId, date, values: { value, remark?, originalValue?, originalDate?, originalFrequency?, daysCovered? } }
Series values (sub-daily): {
  _id, seriesId, date,
  values: [ {time, value, remark?} ],
  dailyAggregates: {
    min, max, mean,
    sum?,              // seulement pour valueType: 'cumulative'
    count,             // nombre de valeurs
    coverageHours,     // couverture temporelle en heures
    hasRemark?,        // true si au moins une valeur a un remark
    uniqueRemarks?     // max 10 remarques uniques
  }
}
Series values (super-daily): { _id, seriesId, date, values: { value, remark? } }
*/

export function buildValueObject(row) {
  const valueObj = {value: row.value}
  if (row.remark) {
    valueObj.remark = row.remark
  }

  // Métadonnées d'expansion pour volumes mensuels/trimestriels/annuels expansés en journalier
  if (row.originalValue !== undefined) {
    valueObj.originalValue = row.originalValue
  }

  if (row.originalDate) {
    valueObj.originalDate = row.originalDate
  }

  if (row.originalFrequency) {
    valueObj.originalFrequency = row.originalFrequency
  }

  if (row.daysCovered !== undefined) {
    valueObj.daysCovered = row.daysCovered
  }

  return valueObj
}

/**
 * Calcule les agrégats journaliers pour une série de valeurs infra-journalières.
 * @param {Array} values - [{time, value, remark?}, ...]
 * @param {string} valueType - 'instantaneous' ou 'cumulative'
 * @param {string} frequency - Fréquence d'origine (ex: '15 minutes', '1 hour')
 * @returns {Object} - Agrégats journaliers
 */
function computeDailyAggregates(values, valueType, frequency) {
  // Filtrer les valeurs valides (numériques et finies)
  const validValues = values
    .map(v => v.value)
    .filter(v =>
      typeof v === 'number'
      && !Number.isNaN(v)
      && Number.isFinite(v)
    )

  if (validValues.length === 0) {
    return null
  }

  const min = Math.min(...validValues)
  const max = Math.max(...validValues)
  const sum = validValues.reduce((acc, v) => acc + v, 0)
  const mean = sum / validValues.length
  const count = validValues.length

  // Calculer la couverture temporelle en heures
  const coverageHours = calculateCoverageHours(values, frequency)

  // Gérer les remarques
  const remarks = values
    .filter(v => v.remark)
    .map(v => v.remark)

  const hasRemark = remarks.length > 0
  const uniqueRemarks = hasRemark
    ? [...new Set(remarks)].slice(0, 10)
    : undefined

  const aggregates = {
    min,
    max,
    mean,
    count,
    coverageHours
  }

  // Ajouter sum seulement pour les valeurs cumulatives
  if (valueType === 'cumulative') {
    aggregates.sum = sum
  }

  if (hasRemark) {
    aggregates.hasRemark = true
    aggregates.uniqueRemarks = uniqueRemarks
  }

  return aggregates
}

/**
 * Calcule la couverture temporelle en heures basée sur les timestamps réels des valeurs.
 * Analyse la plage horaire min-max couverte dans la journée.
 *
 * @param {Array} values - Valeurs infra-journalières [{time: 'HH:MM', value, remark?}, ...]
 * @param {string} frequency - Fréquence (ex: '15 minutes', '1 hour', '1 second')
 * @returns {number} - Couverture en heures (0 à 25, peut être >24 pour changements d'heure)
 */
function calculateCoverageHours(values, frequency) {
  if (!values || values.length === 0) {
    return 0
  }

  // Si une seule valeur, utiliser la durée théorique de la fréquence
  if (values.length === 1) {
    return FREQUENCY_TO_HOURS[frequency] || 1
  }

  // Extraire et parser les heures/minutes de tous les timestamps
  const timeValues = values
    .map(v => {
      if (!v.time) {
        return null
      }

      const [hours, minutes = 0, seconds = 0] = v.time.split(':').map(Number)
      // Convertir en heures décimales
      return hours + (minutes / 60) + (seconds / 3600)
    })
    .filter(t => t !== null)

  if (timeValues.length === 0) {
    return 0
  }

  // Calculer la plage couverte : différence entre min et max + la durée d'une mesure
  const minTime = Math.min(...timeValues)
  const maxTime = Math.max(...timeValues)

  // Durée théorique d'une mesure selon la fréquence
  const measureDuration = FREQUENCY_TO_HOURS[frequency] || 1

  // Couverture = plage entre première et dernière mesure + durée d'une mesure
  const coverage = (maxTime - minTime) + measureDuration

  // Limiter à 25h pour gérer les changements d'heure (heure d'été/hiver)
  return Math.min(Math.max(coverage, 0), 25)
}

export async function insertSeriesWithValues({attachmentId, dossierId, territoire, series}) {
  if (!territoire || typeof territoire !== 'string') {
    throw new Error('territoire est obligatoire (string) pour créer des séries')
  }

  if (!dossierId) {
    throw new Error('dossierId est obligatoire pour créer des séries')
  }

  const now = new Date()
  const seriesDocs = series.map(s => ({
    attachmentId,
    dossierId,
    territoire,
    pointPrelevement: s.pointPrelevement ?? null,
    parameter: s.parameter,
    unit: s.unit ?? null,
    frequency: s.frequency,
    valueType: s.valueType,
    originalFrequency: s.originalFrequency || null,
    minDate: s.minDate,
    maxDate: s.maxDate,
    extras: s.extras || null,
    hasSubDaily: s.frequency !== '1 day',
    numberOfValues: Array.isArray(s.data) ? s.data.length : 0,
    hash: s.hash || null,
    createdAt: now,
    updatedAt: now
  }))

  if (seriesDocs.length === 0) {
    return {insertedSeriesIds: [], totalValueDocs: 0}
  }

  const {insertedIds} = await mongo.db.collection('series').insertMany(seriesDocs)

  const valueDocs = []

  for (const [index, s] of series.entries()) {
    const seriesId = insertedIds[index]
    if (s.frequency === '1 day') {
      // Séries journalières : stockage direct
      for (const row of s.data) {
        valueDocs.push({
          seriesId,
          date: row.date,
          values: buildValueObject(row)
        })
      }
    } else if (['1 month', '1 quarter', '1 year'].includes(s.frequency)) {
      // Fréquences super-daily : stockage direct sans regroupement
      for (const row of s.data) {
        valueDocs.push({
          seriesId,
          date: row.date,
          values: {value: row.value, ...(row.remark ? {remark: row.remark} : {})}
        })
      }
    } else {
      // Séries infra-journalières : regrouper par date et calculer les agrégats
      const byDate = new Map()
      for (const row of s.data) {
        const list = byDate.get(row.date) || []
        list.push({time: row.time, value: row.value, ...(row.remark ? {remark: row.remark} : {})})
        byDate.set(row.date, list)
      }

      for (const [date, values] of byDate.entries()) {
        const dailyAggregates = computeDailyAggregates(values, s.valueType, s.frequency)

        const valueDoc = {
          seriesId,
          date,
          values
        }

        // Ajouter les agrégats journaliers s'ils ont pu être calculés
        if (dailyAggregates) {
          valueDoc.dailyAggregates = dailyAggregates
        }

        valueDocs.push(valueDoc)
      }
    }
  }

  if (valueDocs.length > 0) {
    await mongo.db.collection('series_values').insertMany(valueDocs)
  }

  return {insertedSeriesIds: Object.values(insertedIds), totalValueDocs: valueDocs.length}
}

export async function deleteSeriesByAttachmentId(attachmentId) {
  const series = await mongo.db.collection('series').find({attachmentId}).project({_id: 1}).toArray()
  if (series.length === 0) {
    return {deletedSeries: 0, deletedValues: 0}
  }

  const seriesIds = series.map(s => s._id)
  const {deletedCount: deletedValues} = await mongo.db.collection('series_values').deleteMany({seriesId: {$in: seriesIds}})
  const {deletedCount: deletedSeries} = await mongo.db.collection('series').deleteMany({_id: {$in: seriesIds}})
  return {deletedSeries, deletedValues}
}

export async function getSeriesHashesByAttachmentId(attachmentId) {
  return mongo.db.collection('series')
    .find({attachmentId})
    .project({_id: 1, hash: 1})
    .toArray()
}

export async function deleteSeriesByIds(seriesIds) {
  if (!Array.isArray(seriesIds) || seriesIds.length === 0) {
    return {deletedSeries: 0, deletedValues: 0}
  }

  const {deletedCount: deletedValues} = await mongo.db.collection('series_values').deleteMany({seriesId: {$in: seriesIds}})
  const {deletedCount: deletedSeries} = await mongo.db.collection('series').deleteMany({_id: {$in: seriesIds}})
  return {deletedSeries, deletedValues}
}

export async function getSeriesByDossierId(dossierId) {
  return mongo.db.collection('series').find({dossierId}).toArray()
}

export async function getSeriesValues(seriesId) {
  return mongo.db.collection('series_values').find({seriesId}).toArray()
}

export async function updateSeriesComputed(seriesIds, {preleveurId, pointId, dossierStatus}) {
  if (!Array.isArray(seriesIds) || seriesIds.length === 0) {
    return {matched: 0, modified: 0}
  }

  const doc = {}
  if (preleveurId) {
    doc['computed.preleveur'] = preleveurId
  }

  if (pointId) {
    doc['computed.point'] = pointId
  }

  if (dossierStatus) {
    doc['computed.dossierStatus'] = dossierStatus
  }

  if (Object.keys(doc).length === 0) {
    return {matched: 0, modified: 0}
  }

  const {matchedCount, modifiedCount} = await mongo.db.collection('series').updateMany(
    {_id: {$in: seriesIds}},
    {$set: doc}
  )

  return {matched: matchedCount, modified: modifiedCount}
}

// New helpers
// listSeries : recherche générique de séries.
// Obligatoire: territoire (codeTerritoire) afin d'isoler les données et gérer les droits.
// Critères exclusifs / combinables:
//  - attachmentId : liste toutes les séries d'une pièce jointe (ignores autres critères sauf from/to)
//  - pointId et/ou preleveurId : filtre sur computed.point et/ou computed.preleveur
//  - from / to : limite temporelle sur les jours intégrés (integratedDays) ou sur minDate/maxDate selon onlyIntegratedDays
//  - onlyIntegratedDays : si true, l'intervalle from/to est appliqué sur la présence de jours dans computed.integratedDays.
//                         si false (défaut), filtrage préliminaire via minDate/maxDate et raffinement via integratedDays seulement
//                         quand integratedDays est présent.
// Retour: métadonnées de séries sans champs sensibles (attachmentId, extras, computed.integratedDays).
export function buildOverlapFilter({from, to, onlyIntegratedDays}) {
  return function (list) {
    if (!from && !to) {
      return list
    }

    const inRange = d => (!from || d >= from) && (!to || d <= to)

    if (onlyIntegratedDays) {
      return list.filter(s => Array.isArray(s?.computed?.integratedDays)
        ? s.computed.integratedDays.some(inRange)
        : false)
    }

    return list.filter(s => {
      if (!Array.isArray(s?.computed?.integratedDays)) {
        return true
      }

      return s.computed.integratedDays.some(inRange)
    })
  }
}

export function buildAttachmentQuery({attachmentId, territoire, from, to}) {
  const query = {attachmentId, territoire}

  if (from) {
    query.maxDate = {$gte: from}
  }

  if (to) {
    query.minDate = query.minDate ? {...query.minDate, $lte: to} : {$lte: to}
  }

  return query
}

export function buildPointPreleveurQuery({territoire, pointId, preleveurId, parameter, from, to, onlyIntegratedDays}) {
  const query = {territoire}
  if (pointId) {
    query['computed.point'] = pointId
  }

  if (preleveurId) {
    query['computed.preleveur'] = preleveurId
  }

  if (parameter) {
    query.parameter = parameter
  }

  if (from || to) {
    if (onlyIntegratedDays) {
      const elemMatch = {}
      if (from) {
        elemMatch.$gte = from
      }

      if (to) {
        elemMatch.$lte = to
      }

      query['computed.integratedDays'] = elemMatch
    } else {
      if (from) {
        query.maxDate = {$gte: from}
      }

      if (to) {
        query.minDate = query.minDate ? {...query.minDate, $lte: to} : {$lte: to}
      }
    }
  }

  return query
}

export async function listSeries({
  territoire,
  attachmentId,
  pointId,
  preleveurId,
  parameter,
  from,
  to,
  onlyIntegratedDays = false
}) {
  if (!territoire) {
    throw new Error('territoire est obligatoire pour listSeries')
  }

  const projection = {
    attachmentId: 0,
    extras: 0
  }

  const col = mongo.db.collection('series')

  // Cas 1: attachmentId fourni -> on ignore pointId/preleveurId et on retourne directement les séries de la pièce jointe.
  const overlapFilter = buildOverlapFilter({from, to, onlyIntegratedDays})

  if (attachmentId) {
    const raw = await col.find(buildAttachmentQuery({attachmentId, territoire, from, to})).project(projection).toArray()
    return overlapFilter(raw)
  }

  // Cas 2: recherche par pointId / preleveurId (au moins un des deux doit être fourni)
  const baseQuery = buildPointPreleveurQuery({territoire, pointId, preleveurId, parameter, from, to, onlyIntegratedDays})

  if (!(pointId || preleveurId)) {
    // Pas de critère exploitable hors attachmentId -> retourne liste vide pour éviter fuite.
    return []
  }

  // Pré-filtrage temporel
  let candidates = await col.find(baseQuery).project(projection).toArray()

  // Fallback: si filtrage par pointId demandé mais aucune série (computed.point non encore peuplé),
  // retenter via champ brut pointPrelevement
  if (pointId && candidates.length === 0) {
    const fallbackQuery = {...baseQuery}
    delete fallbackQuery['computed.point']
    fallbackQuery.pointPrelevement = pointId
    candidates = await col.find(fallbackQuery).project(projection).toArray()
  }

  return onlyIntegratedDays ? candidates : overlapFilter(candidates)
}

export async function getSeriesById(seriesId) {
  return mongo.db.collection('series').findOne({_id: seriesId})
}

/**
 * Récupère les valeurs d'une série dans une plage de dates.
 * @param {ObjectId} seriesId - ID de la série
 * @param {Object} options - Options de filtrage
 * @param {string} options.start - Date de début (YYYY-MM-DD)
 * @param {string} options.end - Date de fin (YYYY-MM-DD)
 * @param {boolean} options.useAggregates - Si true, retourne uniquement dailyAggregates (séries infra-journalières), sinon values brutes
 * @returns {Promise<Array>} - Liste des documents {date, values} ou {date, dailyAggregates}
 */
export async function getSeriesValuesInRange(seriesId, {start, end, useAggregates = false}) {
  const query = {seriesId}
  if (start || end) {
    query.date = {}
    if (start) {
      query.date.$gte = start
    }

    if (end) {
      query.date.$lte = end
    }

    if (Object.keys(query.date).length === 0) {
      delete query.date
    }
  }

  // Si useAggregates est true, on veut seulement les documents qui ont dailyAggregates
  if (useAggregates) {
    query.dailyAggregates = {$exists: true}
  }

  // Projection : retourner seulement les champs pertinents
  const projection = useAggregates
    ? {date: 1, dailyAggregates: 1, _id: 0}
    : {date: 1, values: 1, _id: 0}

  return mongo.db.collection('series_values')
    .find(query)
    .project(projection)
    .sort({date: 1})
    .toArray()
}

// Création d'index (à appeler au démarrage)
export async function ensureSeriesIndexes() {
  // Index multikey sur array integratedDays combiné avec preleveur et point
  // Ajout minDate/maxDate pour filtrage rapide sur overlap éventuel
  await mongo.db.collection('series').createIndex({
    'computed.preleveur': 1,
    'computed.point': 1,
    'computed.integratedDays': 1,
    minDate: 1,
    maxDate: 1
  }, {name: 'series_computed_integratedDays'})

  await mongo.db.collection('series').createIndex({attachmentId: 1})
  await mongo.db.collection('series').createIndex({dossierId: 1})
  await mongo.db.collection('series_values').createIndex({seriesId: 1, date: 1}, {unique: true})
}

// Ajoute une liste de dates intégrées (jours avec valeurs effectivement intégrées) dans computed.integratedDays
// Ne crée pas de doublons grâce à $addToSet + $each
export async function updateSeriesIntegratedDays(seriesIds, dates) {
  if (!Array.isArray(seriesIds) || seriesIds.length === 0) {
    return {matched: 0, modified: 0}
  }

  if (!Array.isArray(dates) || dates.length === 0) {
    return {matched: 0, modified: 0}
  }

  const uniqueDates = [...new Set(dates)]
  const {matchedCount, modifiedCount} = await mongo.db.collection('series').updateMany(
    {_id: {$in: seriesIds}},
    {
      $addToSet: {'computed.integratedDays': {$each: uniqueDates}},
      $set: {'computed.updatedAt': new Date()}
    }
  )

  return {matched: matchedCount, modified: modifiedCount}
}
