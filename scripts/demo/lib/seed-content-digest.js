import {createHash} from 'node:crypto'

const DAY_IN_MILLISECONDS = 86_400_000
const FREQUENCIES = Object.freeze({
  MONTHLY: '1 month',
  WEEKLY: '1 week',
  DAILY: '1 day'
})

function canonicalize(value) {
  if (value instanceof Date) {
    return value.toISOString()
  }

  if (value && typeof value === 'object' && typeof value.toJSON === 'function') {
    return canonicalize(value.toJSON())
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    )
  }

  return value
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function digest(items) {
  return sha256(stableStringify(items))
}

export function deterministicUuid(datasetId, key) {
  const hex = sha256(`${datasetId}:${key}`)
  const variant = (Number.parseInt(hex[16], 16) % 4 + 8).toString(16)

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32)
  ].join('-')
}

function dateOnly(value) {
  return new Date(`${value}T00:00:00.000Z`)
}

function addUtcDay(value) {
  return new Date(value.getTime() + DAY_IN_MILLISECONDS)
}

function declarationTimestamp(year, lastReferenceYear) {
  const day = year === lastReferenceYear ? '09-01' : '12-31'
  return new Date(`${year}-${day}T12:00:00.000Z`)
}

function rootUsageCode(usage) {
  return usage?.parent?.code ?? usage?.code ?? null
}

function actorMaps(dataset) {
  const preleveursBySourceId = new Map(
    dataset.preleveurs.map(preleveur => [preleveur.sourceId, preleveur])
  )
  const actorIdsByKey = new Map([['ougc', dataset.personas.ougc.id]])

  for (const key of ['irrigant', 'industriel', 'aep']) {
    const sourceId = dataset.personas[key].preleveurSourceId
    actorIdsByKey.set(key, preleveursBySourceId.get(sourceId)?.id)
  }

  return {preleveursBySourceId, actorIdsByKey}
}

function expectedDeclaration(dataset, declaration, actors) {
  return {
    id: declaration.id,
    code: declaration.code,
    declarantUserId: actors.preleveursBySourceId.get(declaration.targetKey)?.id,
    createdByDeclarantUserId: declaration.authorKey
      ? actors.actorIdsByKey.get(declaration.authorKey)
      : null,
    autoValidationEnabled: true,
    importSourceId: declaration.importSourceId,
    type: declaration.type,
    comment: `Jeu de démonstration synthétique ${dataset.metadata.id}`,
    dataSourceType: declaration.dataSourceType,
    waterWithdrawalType: declaration.waterWithdrawalType,
    consolidatedAt: null,
    processingStatus: 'COMPLETED',
    processingJobId: null,
    processingAttemptCount: 0,
    processingQueuedAt: null,
    processingStartedAt: null,
    processingCompletedAt: declarationTimestamp(
      declaration.year,
      Math.max(...dataset.metadata.referenceYears)
    ),
    processingFailedAt: null,
    processingError: null,
    createdAt: declarationTimestamp(
      declaration.year,
      Math.max(...dataset.metadata.referenceYears)
    )
  }
}

function expectedSource(dataset, declaration) {
  return {
    id: deterministicUuid(dataset.metadata.id, `${declaration.sourceId}:source`),
    type: 'DECLARATION',
    status: 'COMPLETED',
    globalInstructionStatus: declaration.chunks.some(chunk => chunk.pointSourceId === null)
      ? 'PARTIALLY_VALIDATED'
      : 'VALIDATED',
    metadata: {
      fixture: {
        datasetId: dataset.metadata.id,
        version: dataset.metadata.version,
        sourceId: declaration.sourceId,
        cadence: declaration.cadence,
        year: declaration.year,
        digest: sha256(stableStringify(declaration))
      },
      sourceCode: declaration.sourceCode
    },
    declarationId: declaration.id
  }
}

function expectedChunk({dataset, declaration, chunk, actors, pointsBySourceId}) {
  const starts = chunk.values.map(value => dateOnly(value.periodStart))
  const ends = chunk.values.map(value => dateOnly(value.periodEnd))
  const matched = chunk.status === 'MATCHED'
  const submittedByDeclarantUserId = declaration.authorKey
    ? actors.actorIdsByKey.get(declaration.authorKey)
    : null

  return {
    id: chunk.id,
    sourceId: deterministicUuid(dataset.metadata.id, `${declaration.sourceId}:source`),
    pointPrelevementName: chunk.externalPointId,
    pointPrelevementId: chunk.pointSourceId
      ? pointsBySourceId.get(chunk.pointSourceId)?.id
      : null,
    flowType: 'PRELEVEMENT',
    preleveurUserId: actors.preleveursBySourceId.get(declaration.targetKey)?.id,
    submittedByDeclarantUserId,
    collecteurUserId: declaration.authorKey === 'ougc'
      ? actors.actorIdsByKey.get('ougc')
      : null,
    usageCode: chunk.usageCode,
    instructionStatus: matched ? 'VALIDATED' : 'PENDING',
    instructedAt: matched
      ? declarationTimestamp(
        declaration.year,
        Math.max(...dataset.metadata.referenceYears)
      )
      : null,
    instructedByInstructorUserId: null,
    instructionComment: matched
      ? 'Validation synthétique du jeu de démonstration'
      : null,
    parsingInfo: {
      fixtureSourceId: chunk.sourceId,
      externalPointId: chunk.externalPointId,
      matchStatus: chunk.status
    },
    minDate: new Date(Math.min(...starts.map(date => date.getTime()))),
    maxDate: new Date(Math.max(...ends.map(date => date.getTime()))),
    metadata: {
      fixture: {
        datasetId: dataset.metadata.id,
        sourceId: chunk.sourceId,
        cadence: chunk.cadence
      }
    }
  }
}

function expectedValue(dataset, chunk, value) {
  return {
    id: deterministicUuid(
      dataset.metadata.id,
      `${chunk.sourceId}:value:${value.periodStart}`
    ),
    chunkId: chunk.id,
    metricTypeCode: 'volume',
    unit: 'm³',
    frequency: FREQUENCIES[chunk.cadence],
    periodStart: dateOnly(value.periodStart),
    periodEnd: addUtcDay(dateOnly(value.periodEnd)),
    valueKind: 'DECLARED',
    value: String(value.valueM3)
  }
}

function sorted(items) {
  return items.sort((left, right) =>
    String(left?.id ?? '').localeCompare(String(right?.id ?? '')))
}

export function buildExpectedOwnedContentRecords(dataset) {
  const actors = actorMaps(dataset)
  const pointsBySourceId = new Map(dataset.points.map(point => [point.sourceId, point]))
  const declarations = []
  const sources = []
  const chunks = []
  const values = []

  for (const declaration of dataset.declarations) {
    declarations.push(expectedDeclaration(dataset, declaration, actors))
    sources.push(expectedSource(dataset, declaration))

    for (const chunk of declaration.chunks) {
      chunks.push(expectedChunk({
        dataset,
        declaration,
        chunk,
        actors,
        pointsBySourceId
      }))
      values.push(...chunk.values.map(value => expectedValue(dataset, chunk, value)))
    }
  }

  return {declarations, sources, chunks, values}
}

export function buildExpectedOwnedContentDigests(dataset) {
  const records = buildExpectedOwnedContentRecords(dataset)

  return Object.fromEntries(Object.entries(records)
    .map(([key, items]) => [key, digest(sorted(items))]))
}

function actualDeclaration(declaration) {
  if (!declaration) {
    return null
  }

  return {
    id: declaration.id,
    code: declaration.code,
    declarantUserId: declaration.declarantUserId,
    createdByDeclarantUserId: declaration.createdByDeclarantUserId,
    autoValidationEnabled: declaration.autoValidationEnabled,
    importSourceId: declaration.importSourceId,
    type: declaration.type,
    comment: declaration.comment,
    dataSourceType: declaration.dataSourceType,
    waterWithdrawalType: declaration.waterWithdrawalType,
    consolidatedAt: declaration.consolidatedAt,
    processingStatus: declaration.processingStatus,
    processingJobId: declaration.processingJobId,
    processingAttemptCount: declaration.processingAttemptCount,
    processingQueuedAt: declaration.processingQueuedAt,
    processingStartedAt: declaration.processingStartedAt,
    processingCompletedAt: declaration.processingCompletedAt,
    processingFailedAt: declaration.processingFailedAt,
    processingError: declaration.processingError,
    createdAt: declaration.createdAt
  }
}

function actualSource(source) {
  return {
    id: source.id,
    type: source.type,
    status: source.status,
    globalInstructionStatus: source.globalInstructionStatus,
    metadata: source.metadata,
    declarationId: source.declarationId
  }
}

function actualChunk(chunk) {
  return {
    id: chunk.id,
    sourceId: chunk.sourceId,
    pointPrelevementName: chunk.pointPrelevementName,
    pointPrelevementId: chunk.pointPrelevementId,
    flowType: chunk.flowType,
    preleveurUserId: chunk.preleveurUserId,
    submittedByDeclarantUserId: chunk.submittedByDeclarantUserId,
    collecteurUserId: chunk.collecteurUserId,
    usageCode: rootUsageCode(chunk.usage),
    instructionStatus: chunk.instructionStatus,
    instructedAt: chunk.instructedAt,
    instructedByInstructorUserId: chunk.instructedByInstructorUserId,
    instructionComment: chunk.instructionComment,
    parsingInfo: chunk.parsingInfo,
    minDate: chunk.minDate,
    maxDate: chunk.maxDate,
    metadata: chunk.metadata
  }
}

function actualValue(value) {
  return {
    id: value.id,
    chunkId: value.chunkId,
    metricTypeCode: value.metricTypeCode,
    unit: value.unit,
    frequency: value.frequency,
    periodStart: value.periodStart,
    periodEnd: value.periodEnd,
    valueKind: value.valueKind,
    value: String(value.value)
  }
}

export function buildActualOwnedContentDigests(sources) {
  const declarations = sources.map(source => actualDeclaration(source.declaration))
  const sourceRecords = sources.map(actualSource)
  const chunks = sources.flatMap(source => source.chunks ?? []).map(actualChunk)
  const values = sources.flatMap(source => source.chunks ?? [])
    .flatMap(chunk => chunk.chunkValues ?? [])
    .map(actualValue)

  return {
    declarations: digest(sorted(declarations)),
    sources: digest(sorted(sourceRecords)),
    chunks: digest(sorted(chunks)),
    values: digest(sorted(values))
  }
}
