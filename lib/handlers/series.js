import createHttpError from 'http-errors'
import mongo from '../util/mongo.js'
import {getSeriesByAttachmentId, getSeriesById, getSeriesValuesInRange, searchSeriesMetadata} from '../models/series.js'
import {getPointsPrelevementByIds} from '../models/point-prelevement.js'
import {buildPointInfo, enrichWithPointInfo} from '../util/point-info.js'

// Pure builder used by tests & handlers
export async function buildSeriesListForAttachment(attachment, {withPoint = false} = {}) {
  const series = await getSeriesByAttachmentId(attachment._id)
  const mapped = series.map(s => ({
    _id: s._id,
    parameter: s.parameter,
    unit: s.unit,
    frequency: s.frequency,
    valueType: s.valueType,
    minDate: s.minDate,
    maxDate: s.maxDate,
    hasSubDaily: s.hasSubDaily || (s.frequency !== '1 day') || undefined,
    pointPrelevement: s.pointPrelevement || null,
    pointInfo: undefined
  }))
  if (withPoint) {
    await enrichWithPointInfo(mapped, {
      getId(i) {
        return i.pointPrelevement
      },
      setInfo(i, info) {
        i.pointInfo = info
      },
      fetchPoints(ids) {
        return getPointsPrelevementByIds(ids.map(id => mongo.parseObjectId(id)))
      }
    })
  }

  return mapped
}

export async function buildSeriesValuesPayload(seriesIdRaw, {start, end, withPoint = false}) {
  const seriesId = mongo.parseObjectId(seriesIdRaw)
  if (!seriesId) {
    throw createHttpError(404, 'Série introuvable')
  }

  const series = await getSeriesById(seriesId)
  if (!series) {
    throw createHttpError(404, 'Série introuvable')
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/
  let startDate
  let endDate

  if (start) {
    if (!dateRegex.test(start)) {
      throw createHttpError(400, 'Paramètre start invalide (YYYY-MM-DD attendu)')
    }

    startDate = start
  }

  if (end) {
    if (!dateRegex.test(end)) {
      throw createHttpError(400, 'Paramètre end invalide (YYYY-MM-DD attendu)')
    }

    endDate = end
  }

  if (startDate && endDate && startDate > endDate) {
    throw createHttpError(400, 'start doit être <= end')
  }

  const values = await getSeriesValuesInRange(series._id, {start: startDate, end: endDate})

  let pointInfo
  if (withPoint && series.pointPrelevement) {
    const points = await getPointsPrelevementByIds([series.pointPrelevement])
    pointInfo = buildPointInfo(points[0])
  }

  if (series.frequency === '1 day') {
    const daily = values.map(v => ({date: v.date, ...v.values}))
    return {
      series: {
        _id: series._id,
        parameter: series.parameter,
        unit: series.unit,
        frequency: series.frequency,
        valueType: series.valueType,
        minDate: series.minDate,
        maxDate: series.maxDate,
        pointPrelevement: series.pointPrelevement || null,
        ...(withPoint ? {pointInfo: pointInfo || null} : {})
      },
      values: daily
    }
  }

  const subDaily = values.map(v => ({date: v.date, values: v.values}))
  return {
    series: {
      _id: series._id,
      parameter: series.parameter,
      unit: series.unit,
      frequency: series.frequency,
      valueType: series.valueType,
      minDate: series.minDate,
      maxDate: series.maxDate,
      hasSubDaily: true,
      pointPrelevement: series.pointPrelevement || null,
      ...(withPoint ? {pointInfo: pointInfo || null} : {})
    },
    values: subDaily
  }
}

// Express handlers (req, res)
export async function listSeriesForAttachment(req, res) {
  const withPoint = req.query.withPoint === '1'
  const series = await buildSeriesListForAttachment(req.attachment, {withPoint})
  res.send({series})
}

export async function getSeriesValuesHandler(req, res) {
  const withPoint = req.query.withPoint === '1'
  const payload = await buildSeriesValuesPayload(req.params.seriesId, {start: req.query.start, end: req.query.end, withPoint})
  res.send(payload)
}

export async function getSeriesMetadataHandler(req, res) {
  const seriesId = mongo.parseObjectId(req.params.seriesId)
  if (!seriesId) {
    throw createHttpError(404, 'Série introuvable')
  }

  const series = await getSeriesById(seriesId)
  if (!series) {
    throw createHttpError(404, 'Série introuvable')
  }

  let pointInfo
  if (req.query.withPoint === '1' && series.pointPrelevement) {
    const points = await getPointsPrelevementByIds([series.pointPrelevement])
    pointInfo = buildPointInfo(points[0])
  }

  res.send({
    series: {
      _id: series._id,
      parameter: series.parameter,
      unit: series.unit,
      frequency: series.frequency,
      valueType: series.valueType,
      minDate: series.minDate,
      maxDate: series.maxDate,
      hasSubDaily: series.hasSubDaily || (series.frequency !== '1 day') || undefined,
      pointPrelevement: series.pointPrelevement || null,
      ...(req.query.withPoint === '1' ? {pointInfo: pointInfo || null} : {})
    }
  })
}

// Recherche de séries (métadonnées uniquement) selon preleveurId, pointId, from, to
export async function listSeriesMetadataSearch(req, res) {
  const {preleveurId, pointId, from, to} = req.query
  if (!preleveurId || !pointId) {
    throw createHttpError(400, 'Paramètres preleveurId et pointId requis')
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/
  if (from && !dateRegex.test(from)) {
    throw createHttpError(400, 'Paramètre from invalide (YYYY-MM-DD attendu)')
  }

  if (to && !dateRegex.test(to)) {
    throw createHttpError(400, 'Paramètre to invalide (YYYY-MM-DD attendu)')
  }

  if (from && to && from > to) {
    throw createHttpError(400, 'from doit être <= to')
  }

  const preleveurOid = mongo.parseObjectId(preleveurId)
  const pointOid = mongo.parseObjectId(pointId)
  if (!preleveurOid || !pointOid) {
    throw createHttpError(400, 'Identifiant invalide')
  }

  const series = await searchSeriesMetadata({preleveurId: preleveurOid, pointId: pointOid, from, to})
  // Mapping final minimal déjà filtré (on retire computed.integratedDays du retour pour rester sobre)
  const mapped = series.map(s => ({
    _id: s._id,
    parameter: s.parameter,
    unit: s.unit,
    frequency: s.frequency,
    valueType: s.valueType,
    minDate: s.minDate,
    maxDate: s.maxDate,
    hasSubDaily: s.hasSubDaily || (s.frequency !== '1 day') || undefined,
    pointPrelevement: s.pointPrelevement || null
  }))

  res.send({series: mapped})
}
