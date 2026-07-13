export const METRIC_TYPE_CODES = {
  VOLUME: 'volume',
  DEBIT: 'débit',
  INDEX: 'index',
  // Alias de lecture conservés pendant la migration des producteurs.
  VOLUME_PRELEVE: 'volume prélevé',
  VOLUME_REJETE: 'volume rejeté',
  DEBIT_PRELEVE: 'débit prélevé',
  RELEVE_INDEX: 'relevé d\'index'
}

export const LEGACY_METRIC_TYPE_CODES = {
  VOLUME_PRELEVE: 'volume prélevé',
  VOLUME_REJETE: 'volume rejeté',
  DEBIT_PRELEVE: 'débit prélevé',
  RELEVE_INDEX: 'relevé d\'index'
}

const NORMALIZED_METRIC_TYPE_CODES = new Map([
  [METRIC_TYPE_CODES.VOLUME, METRIC_TYPE_CODES.VOLUME],
  [LEGACY_METRIC_TYPE_CODES.VOLUME_PRELEVE, METRIC_TYPE_CODES.VOLUME],
  [LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE, METRIC_TYPE_CODES.VOLUME],
  [METRIC_TYPE_CODES.DEBIT, METRIC_TYPE_CODES.DEBIT],
  [LEGACY_METRIC_TYPE_CODES.DEBIT_PRELEVE, METRIC_TYPE_CODES.DEBIT],
  [METRIC_TYPE_CODES.INDEX, METRIC_TYPE_CODES.INDEX],
  [LEGACY_METRIC_TYPE_CODES.RELEVE_INDEX, METRIC_TYPE_CODES.INDEX]
])

export function normalizeMetricTypeCode(metricTypeCode) {
  return NORMALIZED_METRIC_TYPE_CODES.get(metricTypeCode) ?? metricTypeCode
}

export function inferFlowTypeFromLegacyMetricTypeCode(metricTypeCode) {
  if (metricTypeCode === LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE) {
    return 'REJET'
  }

  if (
    metricTypeCode === LEGACY_METRIC_TYPE_CODES.VOLUME_PRELEVE
    || metricTypeCode === LEGACY_METRIC_TYPE_CODES.DEBIT_PRELEVE
  ) {
    return 'PRELEVEMENT'
  }

  return null
}

export function isVolumeMetricTypeCode(metricTypeCode) {
  return normalizeMetricTypeCode(metricTypeCode) === METRIC_TYPE_CODES.VOLUME
}

export function isIndexMetricTypeCode(metricTypeCode) {
  return normalizeMetricTypeCode(metricTypeCode) === METRIC_TYPE_CODES.INDEX
}

export function getCompatibleMetricTypeCodes(metricTypeCode) {
  const normalized = normalizeMetricTypeCode(metricTypeCode)

  if (normalized === METRIC_TYPE_CODES.VOLUME) {
    return [
      METRIC_TYPE_CODES.VOLUME,
      LEGACY_METRIC_TYPE_CODES.VOLUME_PRELEVE,
      LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE
    ]
  }

  if (normalized === METRIC_TYPE_CODES.DEBIT) {
    return [METRIC_TYPE_CODES.DEBIT, LEGACY_METRIC_TYPE_CODES.DEBIT_PRELEVE]
  }

  if (normalized === METRIC_TYPE_CODES.INDEX) {
    return [METRIC_TYPE_CODES.INDEX, LEGACY_METRIC_TYPE_CODES.RELEVE_INDEX]
  }

  return [normalized]
}
