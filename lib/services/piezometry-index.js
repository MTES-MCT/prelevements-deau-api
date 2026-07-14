const MINIMUM_REFERENCE_YEARS = 15
const MINIMUM_CURRENT_MONTH_DAYS = 5
const REFERENCE_HISTORY_YEARS = 30
const MINIMUM_IPS = -3
const MAXIMUM_IPS = 3

const IPS_CLASSES = [
  {maximum: -1.28, key: 'VERY_LOW', label: 'Niveau très bas'},
  {maximum: -0.84, key: 'LOW', label: 'Niveau bas'},
  {maximum: -0.25, key: 'MODERATELY_LOW', label: 'Niveau modérément bas'},
  {maximum: 0.25, key: 'NORMAL', label: 'Niveau autour de la normale'},
  {maximum: 0.84, key: 'MODERATELY_HIGH', label: 'Niveau modérément haut'},
  {maximum: 1.28, key: 'HIGH', label: 'Niveau haut'},
  {maximum: Number.POSITIVE_INFINITY, key: 'VERY_HIGH', label: 'Niveau très haut'}
]

function mean(values) {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length
}

function standardDeviation(values) {
  if (values.length < 2) {
    return 0
  }

  const average = mean(values)
  const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0)
    / (values.length - 1)
  return Math.sqrt(variance)
}

function quantile(sortedValues, probability) {
  if (sortedValues.length === 1) {
    return sortedValues[0]
  }

  const position = (sortedValues.length - 1) * probability
  const lowerIndex = Math.floor(position)
  const upperIndex = Math.ceil(position)
  const weight = position - lowerIndex
  return sortedValues[lowerIndex] + ((sortedValues[upperIndex] - sortedValues[lowerIndex]) * weight)
}

function evaluatePolynomial(coefficients, value) {
  return coefficients.reduce((result, coefficient) => (result * value) + coefficient)
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1
  const absoluteValue = Math.abs(value) / Math.sqrt(2)
  const t = 1 / (1 + (0.327_591_1 * absoluteValue))
  const polynomial = evaluatePolynomial([
    1.061_405_429,
    -1.453_152_027,
    1.421_413_741,
    -0.284_496_736,
    0.254_829_592,
    0
  ], t)
  const approximation = 1 - (polynomial * Math.exp(-(absoluteValue ** 2)))
  return 0.5 * (1 + (sign * approximation))
}

// Peter J. Acklam's inverse-normal approximation, accurate well beyond chart precision.
function inverseNormalCdf(probability) {
  const a = [
    -39.696_830_286_653_76,
    220.946_098_424_520_5,
    -275.928_510_446_968_7,
    138.357_751_867_269,
    -30.664_798_066_147_16,
    2.506_628_277_459_239
  ]
  const b = [
    -54.476_098_798_224_06,
    161.585_836_858_040_9,
    -155.698_979_859_886_6,
    66.801_311_887_719_72,
    -13.280_681_552_885_72
  ]
  const c = [
    -0.007_784_894_002_430_293,
    -0.322_396_458_041_136_5,
    -2.400_758_277_161_838,
    -2.549_732_539_343_734,
    4.374_664_141_464_968,
    2.938_163_982_698_783
  ]
  const d = [
    0.007_784_695_709_041_462,
    0.322_467_129_070_039_8,
    2.445_134_137_142_996,
    3.754_408_661_907_416
  ]
  const lowerBoundary = 0.024_25
  const upperBoundary = 1 - lowerBoundary

  if (probability < lowerBoundary) {
    const q = Math.sqrt(-2 * Math.log(probability))
    const numerator = evaluatePolynomial(c, q)
    const denominator = evaluatePolynomial([...d, 1], q)
    return numerator / denominator
  }

  if (probability > upperBoundary) {
    const q = Math.sqrt(-2 * Math.log(1 - probability))
    const numerator = evaluatePolynomial(c, q)
    const denominator = evaluatePolynomial([...d, 1], q)
    return -(numerator / denominator)
  }

  const q = probability - 0.5
  const r = q * q
  const numerator = evaluatePolynomial(a, r) * q
  const denominator = evaluatePolynomial([...b, 1], r)
  return numerator / denominator
}

function gaussianKernelBandwidth(values) {
  const sortedValues = [...values].sort((first, second) => first - second)
  const deviation = standardDeviation(sortedValues)
  if (!Number.isFinite(deviation) || deviation === 0) {
    return 0
  }

  const interquartileRange = quantile(sortedValues, 0.75) - quantile(sortedValues, 0.25)
  const robustSpread = interquartileRange > 0
    ? Math.min(deviation, interquartileRange / 1.34)
    : deviation
  return 0.9 * robustSpread * (sortedValues.length ** -0.2)
}

export function calculateMonthlyIps(referenceValues, value) {
  const bandwidth = gaussianKernelBandwidth(referenceValues)
  if (!Number.isFinite(bandwidth) || bandwidth <= 0) {
    return null
  }

  const probability = mean(referenceValues.map(referenceValue =>
    normalCdf((value - referenceValue) / bandwidth)
  ))
  const clampedProbability = Math.min(normalCdf(MAXIMUM_IPS), Math.max(
    normalCdf(MINIMUM_IPS),
    probability
  ))
  return Math.min(MAXIMUM_IPS, Math.max(MINIMUM_IPS, inverseNormalCdf(clampedProbability)))
}

export function getIpsClass(value) {
  return IPS_CLASSES.find(item => value < item.maximum) ?? IPS_CLASSES.at(-1)
}

function monthKey(value) {
  const date = new Date(value)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function startOfUTCMonth(value) {
  const date = new Date(value)
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
}

function isCurrentUTCMonth(value, now) {
  return monthKey(value) === monthKey(now)
}

function aggregateMonthlyValues(rows) {
  const dailyBuckets = new Map()

  for (const row of rows) {
    const day = new Date(row.measurementDate ?? row.measuredAt).toISOString().slice(0, 10)
    const bucket = dailyBuckets.get(day) ?? {at: new Date(`${day}T00:00:00.000Z`), depths: [], levelsNgf: []}

    if (Number.isFinite(row.levelNgf)) {
      bucket.levelsNgf.push(row.levelNgf)
    }

    if (Number.isFinite(row.depth)) {
      bucket.depths.push(row.depth)
    }

    dailyBuckets.set(day, bucket)
  }

  const monthlyBuckets = new Map()
  for (const dailyBucket of dailyBuckets.values()) {
    const key = monthKey(dailyBucket.at)
    const bucket = monthlyBuckets.get(key) ?? {
      at: startOfUTCMonth(dailyBucket.at),
      depthDays: [],
      levelNgfDays: [],
      depthObservationDays: new Set(),
      levelNgfObservationDays: new Set()
    }
    const depth = mean(dailyBucket.depths)
    const levelNgf = mean(dailyBucket.levelsNgf)

    if (Number.isFinite(depth)) {
      bucket.depthDays.push(depth)
      bucket.depthObservationDays.add(dailyBucket.at.toISOString().slice(0, 10))
    }

    if (Number.isFinite(levelNgf)) {
      bucket.levelNgfDays.push(levelNgf)
      bucket.levelNgfObservationDays.add(dailyBucket.at.toISOString().slice(0, 10))
    }

    monthlyBuckets.set(key, bucket)
  }

  return [...monthlyBuckets.values()]
    .sort((first, second) => first.at - second.at)
    .map(bucket => ({
      at: bucket.at,
      depth: mean(bucket.depthDays),
      levelNgf: mean(bucket.levelNgfDays),
      depthObservationDays: bucket.depthObservationDays.size,
      levelNgfObservationDays: bucket.levelNgfObservationDays.size
    }))
}

function selectIndicatorMetric(monthlyValues) {
  const levelCount = monthlyValues.filter(value => Number.isFinite(value.levelNgf)).length
  const depthCount = monthlyValues.filter(value => Number.isFinite(value.depth)).length

  if (levelCount === 0 && depthCount === 0) {
    return null
  }

  return levelCount >= depthCount ? 'LEVEL_NGF' : 'DEPTH'
}

function orientedValue(value, metric) {
  return metric === 'LEVEL_NGF' ? value.levelNgf : -value.depth
}

function observationDays(value, metric) {
  return metric === 'LEVEL_NGF' ? value.levelNgfObservationDays : value.depthObservationDays
}

function round(value, precision = 4) {
  const factor = 10 ** precision
  return Math.round(value * factor) / factor
}

function buildIpsValue(monthlyValue, {
  end,
  metric,
  minimumReferenceYears,
  monthlyValuesByKey,
  now,
  referencesByMonth,
  start
}) {
  if (monthlyValue.at < start || monthlyValue.at >= end) {
    return null
  }

  if (isCurrentUTCMonth(monthlyValue.at, now)
    && observationDays(monthlyValue, metric) < MINIMUM_CURRENT_MONTH_DAYS) {
    return null
  }

  const references = referencesByMonth.get(monthlyValue.at.getUTCMonth()) ?? []
  if (references.length < minimumReferenceYears) {
    return null
  }

  const indicatorValue = calculateMonthlyIps(references, orientedValue(monthlyValue, metric))
  if (!Number.isFinite(indicatorValue)) {
    return {hasSufficientHistory: true, value: null}
  }

  const previousMonth = new Date(Date.UTC(
    monthlyValue.at.getUTCFullYear(),
    monthlyValue.at.getUTCMonth() - 1,
    1
  ))
  const previousValue = monthlyValuesByKey.get(monthKey(previousMonth))
  const changeFromPreviousMonth = previousValue
    ? orientedValue(monthlyValue, metric) - orientedValue(previousValue, metric)
    : null
  const classification = getIpsClass(indicatorValue)

  return {
    hasSufficientHistory: true,
    value: {
      at: monthlyValue.at,
      value: round(indicatorValue),
      class: classification.key,
      classLabel: classification.label,
      referenceYears: references.length,
      observationDays: observationDays(monthlyValue, metric),
      levelNgf: monthlyValue.levelNgf,
      depth: monthlyValue.depth,
      changeFromPreviousMonth: Number.isFinite(changeFromPreviousMonth)
        ? round(changeFromPreviousMonth)
        : null
    }
  }
}

export function buildPiezometryIps(rows, {
  start,
  end,
  now = new Date(),
  minimumReferenceYears = MINIMUM_REFERENCE_YEARS
}) {
  const monthlyValues = aggregateMonthlyValues(rows)
  const metric = selectIndicatorMetric(monthlyValues)
  const historyYears = new Set(monthlyValues.map(value => value.at.getUTCFullYear())).size

  if (!metric) {
    return {
      status: 'NO_DATA',
      method: 'MONTHLY_GAUSSIAN_KERNEL',
      metric: null,
      minimumReferenceYears,
      historyYears,
      values: []
    }
  }

  const validMonthlyValues = monthlyValues.filter(value => Number.isFinite(orientedValue(value, metric)))
  const referencesByMonth = new Map()
  for (const value of validMonthlyValues) {
    if (isCurrentUTCMonth(value.at, now)
      && observationDays(value, metric) < MINIMUM_CURRENT_MONTH_DAYS) {
      continue
    }

    const month = value.at.getUTCMonth()
    const references = referencesByMonth.get(month) ?? []
    references.push(orientedValue(value, metric))
    referencesByMonth.set(month, references)
  }

  const monthlyValuesByKey = new Map(validMonthlyValues.map(value => [monthKey(value.at), value]))
  const results = validMonthlyValues
    .map(monthlyValue => buildIpsValue(monthlyValue, {
      end,
      metric,
      minimumReferenceYears,
      monthlyValuesByKey,
      now,
      referencesByMonth,
      start
    }))
    .filter(Boolean)
  const values = results.map(result => result.value).filter(Boolean)
  const hasSufficientHistory = results.some(result => result.hasSufficientHistory)

  let status = 'AVAILABLE'
  if (values.length === 0) {
    status = hasSufficientHistory ? 'NO_VARIATION' : 'INSUFFICIENT_HISTORY'
  }

  return {
    status,
    method: 'MONTHLY_GAUSSIAN_KERNEL',
    metric,
    minimumReferenceYears,
    historyYears,
    historyStart: validMonthlyValues.at(0)?.at ?? null,
    historyEnd: validMonthlyValues.at(-1)?.at ?? null,
    values
  }
}

export const PIEZOMETRY_IPS = {
  classes: IPS_CLASSES,
  maximum: MAXIMUM_IPS,
  minimum: MINIMUM_IPS,
  minimumCurrentMonthDays: MINIMUM_CURRENT_MONTH_DAYS,
  minimumReferenceYears: MINIMUM_REFERENCE_YEARS,
  referenceHistoryYears: REFERENCE_HISTORY_YEARS
}
