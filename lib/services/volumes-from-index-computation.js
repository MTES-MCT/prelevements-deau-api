import {METRIC_TYPE_CODES} from '../constants/metric-type-codes.js'

/** Séries d’index telles qu’ingérées par l’API déclaration ou le connecteur compte de service. */
export const INDEX_METRIC_TYPE_CODES = [
  METRIC_TYPE_CODES.RELEVE_INDEX,
  METRIC_TYPE_CODES.INDEX
]

export const VOLUME_PRELEVE_METRIC_CODE = METRIC_TYPE_CODES.VOLUME_PRELEVE

const DEFAULT_UNIT = 'm³'

function isDeclaredValue(value) {
  return value.valueKind === 'DECLARED'
}

function isIndexMetricCode(code) {
  return INDEX_METRIC_TYPE_CODES.includes(code)
}

function toFiniteNumber(value) {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

function toValidDate(value) {
  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    return null
  }

  return date
}

function compareChunkIds(a, b) {
  return String(a).localeCompare(String(b))
}

function getDeclaredValues(chunk) {
  return (chunk.chunkValues ?? []).filter(isDeclaredValue)
}

function getChunkState(chunk) {
  const declaredValues = getDeclaredValues(chunk)
  const declaredMetricCodes = [
    ...new Set(declaredValues.map(value => value.metricTypeCode))
  ]

  if (declaredMetricCodes.includes(VOLUME_PRELEVE_METRIC_CODE)) {
    return {
      chunkId: chunk.id,
      eligible: false,
      created: 0,
      reason: 'DECLARED_VOLUME_PRESENT'
    }
  }

  const onlyIndexDeclared = declaredMetricCodes.length > 0
    && declaredMetricCodes.every(isIndexMetricCode)

  if (!onlyIndexDeclared) {
    return {
      chunkId: chunk.id,
      eligible: false,
      created: 0,
      reason: 'NOT_INDEX_ONLY_DECLARED'
    }
  }

  return {
    chunkId: chunk.id,
    eligible: true,
    created: 0,
    reason: null
  }
}

function extractIndexReadings(chunks, chunkStates) {
  const readings = []

  for (const chunk of chunks) {
    const state = chunkStates.get(chunk.id)

    if (!state?.eligible) {
      continue
    }

    for (const value of getDeclaredValues(chunk)) {
      if (!isIndexMetricCode(value.metricTypeCode)) {
        continue
      }

      const date = toValidDate(value.date)
      const numberValue = toFiniteNumber(value.value)

      if (!date || numberValue === null) {
        continue
      }

      readings.push({
        chunkId: chunk.id,
        date,
        value: numberValue,
        unit: value.unit ?? DEFAULT_UNIT
      })
    }
  }

  return readings
}

/**
 * À partir de relevés d’index triables par date, produit des volumes.
 *
 * Règles métier :
 * - dédoublonnage par date avec conservation du plus grand index ;
 * - tie-break déterministe par chunkId si plusieurs lignes ont le même index max ;
 * - volume = delta entre deux index consécutifs ;
 * - si delta négatif, on considère une remise à zéro et on prend l’index courant ;
 * - le volume est rattaché au chunk du relevé de fin d’intervalle.
 *
 * @param {Array<{ chunkId: string, date: Date | string, value: unknown, unit?: string | null }>} readings
 * @returns {Array<{ chunkId: string, periodStart: Date, periodEnd: Date, date: Date, value: number, unit: string }>}
 */
export function computeVolumeRowsFromIndexReadings(readings) {
  const byDateMs = new Map()

  for (const reading of readings) {
    const date = toValidDate(reading.date)
    const value = toFiniteNumber(reading.value)

    if (!date || value === null || !reading.chunkId) {
      continue
    }

    const normalized = {
      chunkId: reading.chunkId,
      date,
      value,
      unit: reading.unit ?? DEFAULT_UNIT
    }

    const key = date.getTime()
    const existing = byDateMs.get(key)
    const shouldReplace = !existing
      || normalized.value > existing.value
      || (
        normalized.value === existing.value
        && compareChunkIds(normalized.chunkId, existing.chunkId) < 0
      )

    if (shouldReplace) {
      byDateMs.set(key, normalized)
    }
  }

  const uniqueRows = [...byDateMs.values()]
    .sort((a, b) => a.date.getTime() - b.date.getTime())

  const volumeRows = []

  for (let i = 1; i < uniqueRows.length; i++) {
    const previous = uniqueRows[i - 1]
    const current = uniqueRows[i]
    const diff = current.value - previous.value
    const volume = diff >= 0 ? diff : current.value

    if (!Number.isFinite(volume)) {
      continue
    }

    volumeRows.push({
      chunkId: current.chunkId,
      periodStart: previous.date,
      periodEnd: current.date,
      date: current.date,
      value: volume,
      unit: current.unit
    })
  }

  return volumeRows
}

export function planVolumesFromIndexReconstruction(chunks) {
  const pointIds = [
    ...new Set(chunks.map(chunk => chunk.pointPrelevementId).filter(Boolean))
  ]

  if (pointIds.length > 1) {
    throw new Error('planVolumesFromIndexReconstruction requires chunks from a single point')
  }

  const chunkStates = new Map()

  for (const chunk of chunks) {
    chunkStates.set(chunk.id, getChunkState(chunk))
  }

  const eligibleChunkIds = [...chunkStates.values()]
    .filter(state => state.eligible)
    .map(state => state.chunkId)

  const readings = extractIndexReadings(chunks, chunkStates)
  const computedRows = computeVolumeRowsFromIndexReadings(readings)
  const rowsByChunkId = new Map()

  for (const row of computedRows) {
    const rows = rowsByChunkId.get(row.chunkId) ?? []
    rows.push(row)
    rowsByChunkId.set(row.chunkId, rows)
  }

  for (const state of chunkStates.values()) {
    if (!state.eligible) {
      continue
    }

    state.created = (rowsByChunkId.get(state.chunkId) ?? []).length
    state.reason = state.created === 0 ? 'NO_INTERVAL_ENDING_IN_CHUNK' : null
  }

  const details = chunks.map(chunk => {
    const state = chunkStates.get(chunk.id)

    return {
      chunkId: chunk.id,
      created: state?.created ?? 0,
      skipped: !state?.eligible,
      reason: state?.reason ?? null
    }
  })

  return {
    eligibleChunkIds,
    computedRows,
    chunksConsidered: chunks.length,
    chunksUpdated: eligibleChunkIds.length,
    volumesCreated: computedRows.length,
    details
  }
}
