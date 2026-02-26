// Handlers/series.js
import createHttpError from 'http-errors'
import {listSeries, getSeriesById, getSeriesValuesInRange} from '../models/series.js'

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

/**
 * GET /series?sourceId=...&pointId=...&preleveurId=...&metricTypeCode=...
 */
export async function listSeriesMetadataSearch(req, res) {
  const {preleveurId, pointId, metricTypeCode, startDate, endDate, sourceId} = req.query

  if (!preleveurId && !pointId && !sourceId) {
    throw createHttpError(400, 'Au moins un critère preleveurId, pointId ou sourceId est requis')
  }

  if (startDate) {
    validateDateParam('startDate', startDate)
  }

  if (endDate) {
    validateDateParam('endDate', endDate)
  }

  if (startDate && endDate && startDate > endDate) {
    throw createHttpError(400, 'startDate doit être <= endDate')
  }

  const series = await listSeries({
    sourceId: sourceId || undefined,
    pointIds: pointId ? [pointId] : undefined,
    preleveurId: preleveurId || undefined,
    parameter: metricTypeCode || undefined,
    startDate: startDate || undefined,
    endDate: endDate || undefined
  })

  const mapped = series.map(s => ({
    id: s.id,
    parameter: s.parameter, // MetricTypeCode
    unit: s.unit,
    frequency: s.frequency,
    valueType: s.valueType,
    minDate: s.minDate,
    maxDate: s.maxDate,
    hasSubDaily: false,
    pointPrelevement: s.computed?.point || null
  }))

  res.send({series: mapped})
}

/**
 * GET /series/:seriesId/values?startDate=...&endDate=...
 */
export async function getSeriesValuesHandler(req, res) {
  const startDate = req.query.startDate || req.query.start
  const endDate = req.query.endDate || req.query.end

  if (startDate) {
    validateDateParam('startDate', startDate)
  }

  if (endDate) {
    validateDateParam('endDate', endDate)
  }

  if (startDate && endDate && startDate > endDate) {
    throw createHttpError(400, 'startDate doit être <= endDate')
  }

  const series = await getSeriesById(req.params.seriesId)
  if (!series) {
    throw createHttpError(404, 'Série introuvable')
  }

  const values = await getSeriesValuesInRange(req.params.seriesId, {startDate, endDate})

  // Daily payload
  const daily = values.map(v => ({date: v.date, ...v.values}))

  res.send({
    series: {
      id: series.id,
      parameter: series.parameter,
      unit: series.unit,
      frequency: series.frequency,
      valueType: series.valueType,
      minDate: series.minDate,
      maxDate: series.maxDate,
      pointPrelevement: series.pointPrelevement || series.computed?.point || null
    },
    values: daily
  })
}

/**
 * GET /series/:seriesId
 */
export async function getSeriesMetadataHandler(req, res) {
  const series = await getSeriesById(req.params.seriesId)
  if (!series) {
    throw createHttpError(404, 'Série introuvable')
  }

  res.send({
    series: {
      id: series.id,
      parameter: series.parameter,
      unit: series.unit,
      frequency: series.frequency,
      valueType: series.valueType,
      minDate: series.minDate,
      maxDate: series.maxDate,
      hasSubDaily: false,
      pointPrelevement: series.pointPrelevement || series.computed?.point || null
    }
  })
}
