import mongo from '../util/mongo.js'
// ObjectId import not needed explicitly; using insertedIds mapping from insertMany

/*
Series document shape:
{
  _id,
  attachmentId, dossierId,
  territoire,
  pointPrelevement, parameter, unit, frequency, valueType,
  minDate, maxDate, extras, hasSubDaily,
  hash,
  createdAt, updatedAt,
  computed? { preleveur?, point?, dossierStatus?, integratedDays?, updatedAt? }
}

Series values (daily): { _id, seriesId, date, values: { value, remark? } }
Series values (sub-daily): { _id, seriesId, date, values: [ {time, value, remark?} ] }
*/

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
      for (const row of s.data) {
        valueDocs.push({
          seriesId,
          date: row.date,
          values: {value: row.value, ...(row.remark ? {remark: row.remark} : {})}
        })
      }
    } else {
      // Regrouper par date
      const byDate = new Map()
      for (const row of s.data) {
        const list = byDate.get(row.date) || []
        list.push({time: row.time, value: row.value, ...(row.remark ? {remark: row.remark} : {})})
        byDate.set(row.date, list)
      }

      for (const [date, values] of byDate.entries()) {
        valueDocs.push({seriesId, date, values})
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

export function buildPointPreleveurQuery({territoire, pointId, preleveurId, from, to, onlyIntegratedDays}) {
  const query = {territoire}
  if (pointId) {
    query['computed.point'] = pointId
  }

  if (preleveurId) {
    query['computed.preleveur'] = preleveurId
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
  const baseQuery = buildPointPreleveurQuery({territoire, pointId, preleveurId, from, to, onlyIntegratedDays})

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

export async function getSeriesValuesInRange(seriesId, {start, end}) {
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

  return mongo.db.collection('series_values')
    .find(query)
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
