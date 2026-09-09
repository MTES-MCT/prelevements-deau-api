import {Prisma} from '@prisma/client'
import {prisma} from '../../db/prisma.js'
import {getCompatibleMetricTypeCodes, METRIC_TYPE_CODES} from '../constants/metric-type-codes.js'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const INDEX_PATTERN = /^\d{1,16}(?:\.\d{1,4})?$/

export function campaignDate(value) {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : value
  if (typeof text !== 'string' || !DATE_PATTERN.test(text)) {
    throw new Error('Date de campagne invalide.')
  }

  const date = new Date(`${text}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new Error('Date de campagne invalide.')
  }

  return text
}

export function campaignPeriodBounds(period) {
  const start = new Date(`${campaignDate(period.startDate)}T00:00:00.000Z`)
  const end = new Date(`${campaignDate(period.endDate)}T00:00:00.000Z`)
  if (start >= end) {
    throw new Error('Les bornes de la période sont inversées.')
  }

  return {periodStart: start, periodEnd: end}
}

function indexValue(value) {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value) : ''
  return INDEX_PATTERN.test(text) ? new Prisma.Decimal(text) : null
}

function issue(code, context, extra = {}) {
  return {code, severity: 'ERROR', ...context, ...extra}
}

function readingKey(targetId, compteurId, date) {
  return `${targetId}:${compteurId}:${date}`
}

function sourceDate(source) {
  return campaignDate(source.readingDate ?? source.periodStart)
}

function checkExistingReading(reading, target, source) {
  if (!source || !reading.sourceValueUpdatedAt
    || new Date(source.updatedAt).getTime() !== new Date(reading.sourceValueUpdatedAt).getTime()) {
    return 'STALE_SOURCE_READING'
  }

  if (source.chunk?.pointPrelevementId !== target.pointPrelevementId
    || source.chunk?.preleveurUserId !== target.preleveurUserId
    || !getCompatibleMetricTypeCodes(METRIC_TYPE_CODES.INDEX).includes(source.metricTypeCode)
    || source.valueKind !== 'DECLARED'
    || source.chunk?.instructionStatus === 'REJECTED'
    || source.chunk?.source?.status !== 'COMPLETED') {
    return 'INVALID_SOURCE_READING'
  }

  if (source.chunk.compteurId && source.chunk.compteurId !== reading.compteurId) {
    return 'SOURCE_METER_MISMATCH'
  }

  if (!source.chunk.compteurId && reading.meterConfirmed !== true) {
    return 'AMBIGUOUS_HISTORICAL_METER'
  }

  if (sourceDate(source) !== campaignDate(reading.readingDate)
    || (!reading.correctionOfChunkValueId && !indexValue(reading.value)?.eq(source.value))) {
    return 'SOURCE_READING_CHANGED'
  }

  return null
}

function prepareReadings({targets, readings, existingReadings}) {
  const targetMap = new Map(targets.map(target => [target.id, target]))
  const sourceMap = new Map(existingReadings.map(source => [source.id, source]))
  const prepared = new Map()
  const issues = []
  const referenced = new Map()
  for (const rawReading of readings) {
    let reading = {...rawReading}
    const context = {targetId: reading.targetId, compteurId: reading.compteurId, readingDate: reading.readingDate}
    const target = targetMap.get(reading.targetId)
    const allowedMeter = target && (reading.compteurId === null
      ? !target.meters?.length
      : target.meters?.some(meter => meter.compteurId === reading.compteurId))
    if (!allowedMeter) {
      issues.push(issue('UNKNOWN_TARGET_OR_METER', context))
      continue
    }

    let date
    try {
      date = campaignDate(reading.readingDate)
    } catch {
      issues.push(issue('INVALID_READING_DATE', context))
      continue
    }

    const key = readingKey(target.id, reading.compteurId, date)
    if (prepared.has(key)) {
      issues.push(issue('DUPLICATE_READING', context))
      continue
    }

    const missing = reading.value === null || reading.value === undefined || reading.value === ''
    const reason = typeof reading.missingReason === 'string' ? reading.missingReason.trim() : ''
    const value = missing ? null : indexValue(reading.value)
    if ((!missing && !value) || (!missing && reason)) {
      issues.push(issue('INVALID_INDEX', context))
      continue
    }

    if (missing && !reason) {
      issues.push(issue('MISSING_REASON_REQUIRED', context))
    }

    // Sans inventaire, l'identité du compteur n'est pas déduite du point.
    // La continuité doit être confirmée explicitement pour chaque relevé saisi.
    if (!missing && reading.compteurId === null && reading.meterConfirmed !== true) {
      issues.push(issue('METER_CONTINUITY_CONFIRMATION_REQUIRED', context))
    }

    let sourceId = reading.sourceChunkValueId ?? reading.correctionOfChunkValueId
    if (reading.correctionOfChunkValueId && (reading.sourceChunkValueId || !reading.correctionReason?.trim() || missing)) {
      issues.push(issue('CORRECTION_REASON_REQUIRED', context))
      continue
    }

    if (!sourceId) {
      const candidates = existingReadings.filter(source => source.chunk?.pointPrelevementId === target.pointPrelevementId
        && source.chunk?.preleveurUserId === target.preleveurUserId && sourceDate(source) === date
        && (reading.compteurId === null || !source.chunk?.compteurId || source.chunk.compteurId === reading.compteurId))
      const candidate = candidates.length === 1 ? candidates[0] : null
      if (reading.compteurId && candidate?.chunk.compteurId === reading.compteurId && value?.eq(candidate.value)) {
        sourceId = candidate.id
        reading = {...reading, sourceChunkValueId: candidate.id, sourceValueUpdatedAt: candidate.updatedAt}
      } else if (candidates.length > 0) {
        issues.push(issue('EXISTING_READING_REFERENCE_REQUIRED', context))
        continue
      }
    }

    if (sourceId) {
      const previousReference = referenced.get(sourceId)
      const sourceProblem = checkExistingReading(reading, target, sourceMap.get(sourceId))
      if (sourceProblem || (previousReference && previousReference !== key)) {
        issues.push(issue(sourceProblem ?? 'SOURCE_READING_REUSED_FOR_ANOTHER_METER', context))
        continue
      }

      referenced.set(sourceId, key)
    }

    prepared.set(key, {...reading, readingDate: date, decimal: value, missingReason: reason || null})
  }

  return {prepared, issues}
}

function prepareEvents(targets, events) {
  const targetMap = new Map(targets.map(target => [target.id, target]))
  const prepared = []
  const issues = []
  const seen = new Set()
  for (const event of events) {
    const context = {targetId: event.targetId, compteurId: event.previousCompteurId, at: event.at}
    const target = targetMap.get(event.targetId)
    const meterIds = new Set(target?.meters?.map(meter => meter.compteurId) ?? [])
    let at
    try {
      at = campaignDate(event.at)
    } catch {
      issues.push(issue('INVALID_METER_EVENT_DATE', context))
      continue
    }

    const nextCompteurId = event.type === 'RESET' ? event.previousCompteurId : event.nextCompteurId
    const previousIndex = indexValue(event.previousIndex)
    const nextIndex = indexValue(event.nextIndex)
    const key = `${event.targetId}:${event.previousCompteurId}:${at}`
    if (!['RESET', 'REPLACEMENT'].includes(event.type)
      || !meterIds.has(event.previousCompteurId) || !meterIds.has(nextCompteurId)
      || (event.type === 'REPLACEMENT' && nextCompteurId === event.previousCompteurId)
      || (event.type === 'RESET' && event.nextCompteurId && event.nextCompteurId !== event.previousCompteurId)
      || (event.previousIndex !== null && !previousIndex) || (event.nextIndex !== null && !nextIndex)
      || typeof event.reason !== 'string' || !event.reason.trim()
      || seen.has(key)) {
      issues.push(issue('INVALID_METER_EVENT', context))
      continue
    }

    seen.add(key)
    prepared.push({...event, at, nextCompteurId, previousIndex, nextIndex})
  }

  return {prepared: prepared.sort((a, b) => a.at.localeCompare(b.at)), issues}
}

function getBoundary({targetId, compteurId, date, value, eventMissingReason, readings, context, missing}) {
  if (value) {
    return value
  }

  const reading = eventMissingReason ? null : readings.get(readingKey(targetId, compteurId, date))
  if (reading?.decimal) {
    return reading.decimal
  }

  missing.push({
    ...context,
    compteurId,
    readingDate: date,
    reason: eventMissingReason ?? reading?.missingReason ?? null,
    justified: Boolean(eventMissingReason ?? reading?.missingReason)
  })
  return null
}

function calculateMeter({target, meter, start, end, events, readings, context, missing, conflicts}) {
  const meterEvents = events.filter(event => event.targetId === target.id)
  const replacementsIn = meterEvents.filter(event => event.type === 'REPLACEMENT' && event.nextCompteurId === meter.compteurId)
  const replacementsOut = meterEvents.filter(event => event.type === 'REPLACEMENT' && event.previousCompteurId === meter.compteurId)
  const starts = [...(meter.startDate ? [campaignDate(meter.startDate)] : []), ...replacementsIn.map(event => event.at)]
  const ends = [...(meter.endDate ? [campaignDate(meter.endDate)] : []), ...replacementsOut.map(event => event.at)]
  const meterStart = starts.length > 0 ? starts.sort().at(-1) : start
  const meterEnd = ends.length > 0 ? ends.sort()[0] : end
  // Comparaison lexicographique de dates civiles, pas conversion numérique.
  // eslint-disable-next-line unicorn/prefer-math-min-max
  const from = meterStart > start ? meterStart : start
  // eslint-disable-next-line unicorn/prefer-math-min-max
  const to = meterEnd < end ? meterEnd : end
  if (from >= to) {
    return []
  }

  const opening = replacementsIn.find(event => event.at === from)
    ?? meterEvents.find(event => event.type === 'RESET' && event.previousCompteurId === meter.compteurId && event.at === from)
  const closing = replacementsOut.find(event => event.at === to)
    ?? meterEvents.find(event => event.type === 'RESET' && event.previousCompteurId === meter.compteurId && event.at === to)
  if ((from > start && !opening) || (to < end && !closing)) {
    conflicts.push(issue('METER_TRANSITION_REQUIRED', {...context, compteurId: meter.compteurId}))
    return []
  }

  const resets = meterEvents.filter(event => event.type === 'RESET' && event.previousCompteurId === meter.compteurId && event.at > from && event.at < to)
  const boundaries = [
    {date: from, after: opening?.nextIndex, afterMissingReason: opening?.nextIndex === null ? (opening.nextMissingReason || opening.reason) : null},
    ...resets.map(event => ({
      date: event.at,
      before: event.previousIndex,
      after: event.nextIndex,
      beforeMissingReason: event.previousIndex === null ? (event.previousMissingReason || event.reason) : null,
      afterMissingReason: event.nextIndex === null ? (event.nextMissingReason || event.reason) : null
    })),
    {date: to, before: closing?.previousIndex, beforeMissingReason: closing?.previousIndex === null ? (closing.previousMissingReason || closing.reason) : null}
  ]
  const segments = []
  for (let index = 1; index < boundaries.length; index++) {
    const a = boundaries[index - 1]
    const b = boundaries[index]
    const options = {targetId: target.id, compteurId: meter.compteurId, readings, context, missing}
    const startValue = getBoundary({...options, date: a.date, value: a.after, eventMissingReason: a.afterMissingReason})
    const endValue = getBoundary({...options, date: b.date, value: b.before, eventMissingReason: b.beforeMissingReason})
    if (!startValue || !endValue) {
      continue
    }

    const delta = endValue.minus(startValue)
    if (delta.isNegative()) {
      conflicts.push(issue('NEGATIVE_DELTA_REQUIRES_EVENT', {...context, compteurId: meter.compteurId, from: a.date, to: b.date}))
      continue
    }

    segments.push({compteurId: meter.compteurId, from: a.date, to: b.date, startValue: startValue.toString(), endValue: endValue.toString(), value: delta.toString()})
  }

  return segments
}

/** Calcul exact par compteur, ou par point si sa continuité est confirmée sans inventaire. */
export function calculateCampaignIndexTotals({campaign, periods = campaign?.periods ?? [], targets, readings = [], meterEvents = [], existingReadings = []}) {
  const preparedReadings = prepareReadings({targets, readings, existingReadings})
  const preparedEvents = prepareEvents(targets, meterEvents)
  const issues = [...preparedReadings.issues, ...preparedEvents.issues]
  const indexPeriods = periods.filter(period => period.kind === 'INDEX')
  if (indexPeriods.length === 0 || targets.length === 0) {
    issues.push(issue('CAMPAIGN_TARGETS_AND_PERIODS_REQUIRED', {}))
  }

  const allowedDates = new Set(indexPeriods.flatMap(period => [
    period.startReadingDate ?? campaign?.indexDates?.[period.position],
    period.endReadingDate ?? campaign?.indexDates?.[period.position + 1]
  ]).filter(Boolean).map(value => campaignDate(value)))
  const sortedDates = [...allowedDates].sort()
  for (const reading of preparedReadings.prepared.values()) {
    if (!allowedDates.has(reading.readingDate)) {
      issues.push(issue('READING_OUTSIDE_CAMPAIGN_BOUNDARIES', {targetId: reading.targetId, compteurId: reading.compteurId, readingDate: reading.readingDate}))
    }
  }

  for (const event of preparedEvents.prepared) {
    if (event.at < sortedDates[0] || event.at > sortedDates.at(-1)) {
      issues.push(issue('METER_EVENT_OUTSIDE_CAMPAIGN', {targetId: event.targetId, at: event.at}))
    }
  }

  const totals = []
  for (const target of targets) {
    for (const period of indexPeriods) {
      const context = {targetId: target.id, periodId: period.id}
      const conflicts = issues.filter(problem => problem.targetId === target.id)
      const missing = []
      const segments = []
      let bounds
      try {
        const start = campaignDate(period.startReadingDate ?? campaign?.indexDates?.[period.position])
        const end = campaignDate(period.endReadingDate ?? campaign?.indexDates?.[period.position + 1])
        bounds = campaignPeriodBounds(period)
        if (start >= end) {
          conflicts.push(issue('METER_OR_PERIOD_REQUIRED', context))
        } else {
          const uniqueMeterIds = new Set()
          // Cette ligne de calcul n'est pas un Compteur et n'est jamais persistée
          // dans l'inventaire. Les index restent rattachés au point avec un ID null.
          const meters = target.meters?.length ? target.meters : [{compteurId: null}]
          for (const meter of meters) {
            if (uniqueMeterIds.has(meter.compteurId)) {
              conflicts.push(issue('AMBIGUOUS_METER_BINDING', {...context, compteurId: meter.compteurId}))
              continue
            }

            uniqueMeterIds.add(meter.compteurId)
            segments.push(...calculateMeter({target, meter, start, end, events: preparedEvents.prepared, readings: preparedReadings.prepared, context, missing, conflicts}))
          }

          if (segments.length === 0 && missing.length === 0 && conflicts.length === 0) {
            conflicts.push(issue('NO_ACTIVE_METER', context))
          }
        }
      } catch {
        conflicts.push(issue('INVALID_PERIOD_OR_METER_DATE', context))
      }

      for (const absent of missing.filter(item => !item.justified)) {
        conflicts.push(issue('MISSING_READING', context, {compteurId: absent.compteurId, readingDate: absent.readingDate}))
      }

      let sum = new Prisma.Decimal(0)
      for (const segment of segments) {
        sum = sum.plus(segment.value)
      }

      if (sum.gt('9999999999999999.9999')) {
        conflicts.push(issue('VOLUME_OUT_OF_RANGE', context))
      }

      const status = conflicts.length > 0 ? 'CONFLICT' : (missing.length > 0 ? 'MISSING' : 'COMPLETE')

      totals.push({
        ...context,
        ...bounds,
        value: status === 'COMPLETE' ? sum.toString() : null,
        status,
        conflicts,
        missing,
        segments
      })
    }
  }

  const allIssues = [...issues, ...totals.flatMap(total => total.conflicts)]
  return {
    totals,
    issues: allIssues,
    canSubmit: allIssues.length === 0,
    resolvedReadings: [...preparedReadings.prepared.values()].map(({decimal, ...reading}) => reading)
  }
}

/** Les candidats historiques restent distincts : leur ambiguïté est résolue explicitement. */
export async function loadCampaignExistingReadings({campaign, targets, client = prisma}) {
  if (targets.length === 0) {
    return []
  }

  const dates = [...new Set(campaign.periods.filter(period => period.kind === 'INDEX').flatMap(period => [
    campaignDate(period.startReadingDate ?? campaign.indexDates[period.position]),
    campaignDate(period.endReadingDate ?? campaign.indexDates[period.position + 1])
  ]))].map(date => new Date(`${date}T00:00:00.000Z`))
  const values = await client.chunkValue.findMany({
    where: {
      valueKind: 'DECLARED',
      metricTypeCode: {in: getCompatibleMetricTypeCodes(METRIC_TYPE_CODES.INDEX)},
      OR: [{readingDate: {in: dates}}, {readingDate: null, periodStart: {in: dates}}],
      chunk: {
        OR: targets.map(target => ({pointPrelevementId: target.pointPrelevementId, preleveurUserId: target.preleveurUserId})),
        instructionStatus: {not: 'REJECTED'},
        source: {status: 'COMPLETED'}
      }
    },
    include: {chunk: {select: {
      pointPrelevementId: true,
      preleveurUserId: true,
      compteurId: true,
      instructionStatus: true,
      source: {select: {status: true, type: true, declaration: {select: {code: true}}}},
      sourceId: true
    }}},
    orderBy: [{updatedAt: 'desc'}, {id: 'desc'}]
  })
  return values.flatMap(value => targets.filter(target => target.pointPrelevementId === value.chunk.pointPrelevementId
    && target.preleveurUserId === value.chunk.preleveurUserId).map(target => ({
    ...value,
    value: value.value.toString(),
    targetId: target.id,
    compteurId: value.chunk.compteurId,
    readingDate: sourceDate(value),
    sourceChunkValueId: value.id,
    sourceValueUpdatedAt: value.updatedAt,
    requiresMeterConfirmation: !value.chunk.compteurId,
    sourceType: value.chunk.source.type,
    declarationCode: value.chunk.source.declaration?.code ?? null
  })))
}
