import createHttpError from 'http-errors'
import mongo from '../util/mongo.js'
import {listSeries, getSeriesById, getSeriesValuesInRange} from '../models/series.js'
import {getPointInfo} from '../services/point-prelevement.js'

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
    await Promise.all(
      mapped.map(async item => {
        item.pointInfo = await getPointInfo(item.pointPrelevement)
      })
    )
  }

  return mapped
}

export async function buildSeriesValuesPayload(seriesIdRaw, {startDate, endDate, withPoint = false}) {
  const seriesId = mongo.parseObjectId(seriesIdRaw)
  if (!seriesId) {
    throw createHttpError(404, 'Série introuvable')
  }

  const series = await getSeriesById(seriesId)
  if (!series) {
    throw createHttpError(404, 'Série introuvable')
  }

  let validatedStartDate
  let validatedEndDate

  if (startDate) {
    validatedStartDate = validateDateParam('startDate', startDate)
  }

  if (endDate) {
    validatedEndDate = validateDateParam('endDate', endDate)
  }

  if (validatedStartDate && validatedEndDate && validatedStartDate > validatedEndDate) {
    throw createHttpError(400, 'startDate doit être <= endDate')
  }

  const values = await getSeriesValuesInRange(series._id, {startDate: validatedStartDate, endDate: validatedEndDate})

  let pointInfo
  if (withPoint && series.pointPrelevement) {
    pointInfo = await getPointInfo(series.pointPrelevement)
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
  // Fallback pour compatibilité : start/end → startDate/endDate
  const startDate = req.query.startDate || req.query.start
  const endDate = req.query.endDate || req.query.end
  const payload = await buildSeriesValuesPayload(req.params.seriesId, {startDate, endDate, withPoint})
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
    pointInfo = await getPointInfo(series.pointPrelevement)
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

// Recherche de séries (métadonnées uniquement) selon preleveurId, pointId, startDate, endDate
export async function listSeriesMetadataSearch(req, res) {
  const {preleveurId, pointId, startDate, endDate, from, to, onlyIntegratedDays} = req.query

  if (!preleveurId && !pointId) {
    throw createHttpError(400, 'Au moins un critère preleveurId ou pointId est requis')
  }

  // Fallback pour compatibilité : from/to → startDate/endDate
  const effectiveStartDate = startDate || from
  const effectiveEndDate = endDate || to

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/
  if (effectiveStartDate && !dateRegex.test(effectiveStartDate)) {
    throw createHttpError(400, 'Paramètre startDate invalide (YYYY-MM-DD attendu)')
  }

  if (effectiveEndDate && !dateRegex.test(effectiveEndDate)) {
    throw createHttpError(400, 'Paramètre endDate invalide (YYYY-MM-DD attendu)')
  }

  if (effectiveStartDate && effectiveEndDate && effectiveStartDate > effectiveEndDate) {
    throw createHttpError(400, 'startDate doit être <= endDate')
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
    startDate: effectiveStartDate,
    endDate: effectiveEndDate,
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
