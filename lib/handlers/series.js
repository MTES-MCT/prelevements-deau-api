import createHttpError from 'http-errors'
import mongo from '../util/mongo.js'
import {listSeries, getSeriesById, getSeriesValuesInRange} from '../models/series.js'
import {getPointsPrelevementByIds} from '../models/point-prelevement.js'
import {buildPointInfo, enrichWithPointInfo} from '../util/point-info.js'

function validateDateParam(label, value) {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/
  if (!dateRegex.test(value)) {
    throw createHttpError(400, `Paramètre ${label} invalide (YYYY-MM-DD attendu)`)
  }

  const d = new Date(value)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw createHttpError(400, `Paramètre ${label} invalide (date non valide)`)
  }

  return value
}

// Pure builder used by tests & handlers
export async function buildSeriesListForAttachment(attachment, territoireCode, {withPoint = false} = {}) {
  const series = await listSeries({territoire: territoireCode, attachmentId: attachment._id})
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

  let startDate
  let endDate

  if (start) {
    startDate = validateDateParam('start', start)
  }

  if (end) {
    endDate = validateDateParam('end', end)
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
        ...(series.originalFrequency ? {originalFrequency: series.originalFrequency} : {}),
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
      ...(series.originalFrequency ? {originalFrequency: series.originalFrequency} : {}),
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
  const series = await buildSeriesListForAttachment(req.attachment, req.territoire.code, {withPoint})
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
  const {preleveurId, pointId, from, to, onlyIntegratedDays} = req.query

  if (!preleveurId && !pointId) {
    throw createHttpError(400, 'Au moins un critère preleveurId ou pointId est requis')
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

  const preleveurOid = preleveurId ? mongo.parseObjectId(preleveurId) : null
  const pointOid = pointId ? mongo.parseObjectId(pointId) : null

  if (preleveurId && !preleveurOid) {
    throw createHttpError(400, 'Identifiant preleveurId invalide')
  }

  if (pointId && !pointOid) {
    throw createHttpError(400, 'Identifiant pointId invalide')
  }

  const series = await listSeries({
    territoire: req.territoire.code,
    preleveurId: preleveurOid,
    pointIds: pointOid ? [pointOid] : undefined,
    from,
    to,
    onlyIntegratedDays: onlyIntegratedDays === '1'
  })

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
