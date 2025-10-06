import mongo from '../util/mongo.js'
// ObjectId import not needed explicitly; using insertedIds mapping from insertMany

/*
Series document shape:
{
  _id,
  attachmentId, demarcheNumber, dossierNumber,
  pointPrelevement, parameter, unit, frequency, valueType,
  minDate, maxDate, extras, hasSubDaily,
  createdAt, updatedAt
}

Series values (daily): { _id, seriesId, date, values: { value, remark? } }
Series values (sub-daily): { _id, seriesId, date, values: [ {time, value, remark?} ] }
*/

export async function insertSeriesWithValues({attachmentId, demarcheNumber, dossierNumber, territoire, series}) {
  if (!territoire || typeof territoire !== 'string') {
    throw new Error('territoire est obligatoire (string) pour créer des séries')
  }

  const now = new Date()
  const seriesDocs = series.map(s => ({
    attachmentId,
    demarcheNumber,
    dossierNumber,
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

export async function getDailySeriesByDossier(demarcheNumber, dossierNumber) {
  return mongo.db.collection('series').find({demarcheNumber, dossierNumber, frequency: '1 day'}).toArray()
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
export async function getSeriesByAttachmentId(attachmentId) {
  return mongo.db.collection('series')
    .find({attachmentId})
    .project({
      attachmentId: 0,
      dossierNumber: 0,
      demarcheNumber: 0,
      extras: 0
    })
    .toArray()
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
  await mongo.db.collection('series').createIndex({demarcheNumber: 1, dossierNumber: 1}, {sparse: true})
  await mongo.db.collection('series_values').createIndex({seriesId: 1, date: 1}, {unique: true})
}

// Recherche métadonnées séries selon preleveur, point et plage de dates (from/to) sur integratedDays
export async function searchSeriesMetadata({preleveurId, pointId, from, to}) {
  if (!preleveurId || !pointId) {
    return []
  }

  const query = {
    'computed.preleveur': preleveurId,
    'computed.point': pointId
  }

  // Si plage fournie, filtrer sur dates intégrées présentes dans intervalle
  if (from || to) {
    // On récupère par recouvrement minDate/maxDate pour accélérer puis on filtrera après côté JS sur integratedDays
    if (from) {
      query.maxDate = {$gte: from}
    }

    if (to) {
      query.minDate = query.minDate ? {...query.minDate, $lte: to} : {$lte: to}
    }
  }

  const projection = {
    attachmentId: 0,
    dossierNumber: 0,
    demarcheNumber: 0,
    extras: 0
  }

  const candidates = await mongo.db.collection('series').find(query).project(projection).toArray()

  if (!from && !to) {
    return candidates
  }

  // Filtrage final: garder séries qui ont au moins une date integratedDays dans l'intervalle
  return candidates.filter(s => Array.isArray(s?.computed?.integratedDays)
    ? s.computed.integratedDays.some(d => (!from || d >= from) && (!to || d <= to))
    : false)
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
