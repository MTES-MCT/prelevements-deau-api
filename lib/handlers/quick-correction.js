/* eslint-disable no-await-in-loop -- Lock series and write changes sequentially in a single transaction. */
import {createHash, randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import createHttpError from 'http-errors'
import {Prisma} from '@prisma/client'
import {prisma} from '../../db/prisma.js'
import {isDatabaseWriteConflict} from '../util/database-write-conflict.js'
import {resolveHistoricalQuickExploitation} from '../services/quick-declaration-series.js'
import {resourceIdSchema} from '../validation/resource-id.js'
import {INDEX_METRIC_TYPE_CODES, lockPointForReconstruction} from '../services/volumes-from-index.js'
import {isVolumeMetricTypeCode} from '../constants/metric-type-codes.js'
import {buildChunkActorData} from '../services/chunk-actors.js'
import {refreshSourceDeclarantsLastDeclarationAt} from '../models/declarant.js'
import {addExploitationSecondaryUsage} from '../models/exploitation.js'
import {findAllowedDeclarationTypeForDeclarant, normalizeDeclarationTypeCode} from '../models/declaration-type.js'
import {syncDeclarantZonesFromPoint} from '../services/zone-permissions.js'
import {refreshMostRecentAvailableDateForDeclarantPoints} from '../services/declaration-side-effects.js'
import {getWaterUseRootId, resolveWaterUseInput} from '../services/sandre-water-uses.js'
import {assertManualCollectionAccess, assertManualVolumePublication} from '../services/manual-collection.js'
import {applyConflictPolicyForIncomingChunkValues, findConflictingChunkValuesForIncomingChunkValues} from '../services/chunk-value-conflicts.js'
import {captureQuickVolumes, compareQuickVolumes, captureQuickEffectiveReadings, restoredQuickReadingWarnings, findQuickIndexWarnings, findQuickMixedWarnings, getQuickPreviousReadings, quickSeriesKey, reconstructQuickVolumes} from '../services/quick-declaration-impact.js'
import {refreshVolumeMetadataForSourceIds} from '../services/volume-totals.js'
import {
  assertCanDeclareFor, assertLegacyQuickDeclarationFlowType, assertQuickDeclarationEnabled,
  assertQuickPointUsageNameAccess, createQuickDeclarationSchema, editQuickDeclarationSchema, ensureUniquePointEntries,
  ensureUniquePointUsageNames, generateDossierCode, getLinkedExploitationsByPointId, getQuickDeclarationPointDisplayName,
  getQuickDeclarationValuePeriodEnd, getTargetDeclarantUserId, parseQuickDeclarationDate, quickDeclarationExploitationWhere, resolveQuickExploitation
} from './declarations.js'

const quickType = {id: null, code: 'quick-declaration', name: 'Saisie rapide', version: 1, isAvailable: true}
const asDate = value => value.toISOString().slice(0, 10)
const forbidden = () => createHttpError(403, 'Vous ne pouvez pas modifier cette saisie en ligne.')
const stale = () => createHttpError(409, 'La déclaration ou les données voisines ont changé. Vérifiez le nouvel aperçu avant de confirmer.')
const includeSource = {chunks: {orderBy: {id: 'asc'}, include: {pointPrelevement: true, compteur: true, exploitation: {select: {countingCode: true}}, usage: true, chunkValues: {where: {valueKind: 'DECLARED'}}}}}

function chunkEntry(chunk) {
  const declared = chunk.chunkValues.find(row => INDEX_METRIC_TYPE_CODES.includes(row.metricTypeCode) || isVolumeMetricTypeCode(row.metricTypeCode))
  if (!declared) return null
  const start = asDate(declared.periodStart)
  const dates = INDEX_METRIC_TYPE_CODES.includes(declared.metricTypeCode)
    ? {readingDate: start}
    : {periodStartDate: start, periodEndDate: asDate(new Date(declared.periodEnd.getTime() - 1))}
  return {
    id: chunk.id,
    pointPrelevementId: chunk.pointPrelevementId,
    exploitationId: chunk.exploitationId,
    compteurId: chunk.compteurId,
    countingCode: chunk.exploitation?.countingCode ?? null,
    pointName: chunk.pointPrelevement ? getQuickDeclarationPointDisplayName(chunk.pointPrelevement) : chunk.pointPrelevementName,
    compteurName: chunk.compteur?.serialNumber ?? null,
    usageId: chunk.usageId,
    usageLabel: chunk.usage?.label ?? null,
    value: Number(declared.value),
    ...dates
  }
}

function scopeFromChunks(chunks) {
  return chunks.map(({pointPrelevementId, exploitationId, minDate, maxDate}) =>
    ({pointPrelevementId, exploitationId, minDate: asDate(minDate), maxDate: asDate(maxDate)}))
}

function isManualChunk(chunk, owner) {
  return chunk.calculationStrategy === 'GENERIC' && !chunk.metadata?.nativeTemporal && !chunk.metadata?.physicalMeterRequired
    && !chunk.metadata?.collectionResponseId && (!chunk.preleveurUserId || chunk.preleveurUserId === owner)
    && (!chunk.parsingInfo?.parser || chunk.parsingInfo.parser === 'quick-declaration-form')
    && chunk.chunkValues.length <= 1 && chunk.chunkValues.every(v => INDEX_METRIC_TYPE_CODES.includes(v.metricTypeCode) || isVolumeMetricTypeCode(v.metricTypeCode))
}

async function getRetainedScope(client, declaration) {
  const chunks = scopeFromChunks(declaration.source.chunks)
  if (!declaration.source.metadata?.quickRevision) return chunks
  // Old revisions kept the original scope only on revision one. New revisions retain
  // all comptages, including a row added in one correction and removed in another.
  const [history] = await client.$queryRaw`SELECT COALESCE(
    (SELECT "after"->'scope' FROM "QuickDeclarationRevision" WHERE "declarationId" = ${declaration.id}::uuid ORDER BY revision DESC LIMIT 1),
    (SELECT "before"->'scope' FROM "QuickDeclarationRevision" WHERE "declarationId" = ${declaration.id}::uuid AND revision = 1),
    '[]'::jsonb) AS scope`
  return mergeScope(chunks, history.scope)
}

function mergeScope(existing, added) {
  return [...new Map([...existing, ...added].map(row => {
    const identity = row.exploitationId ?? [row.minDate, row.maxDate].join('/')
    const key = [row.pointPrelevementId, identity].join('/')
    return [key, row]
  })).values()]
}

async function authorizeEditScope(client, user, declaration, scope) {
  const declarantUserId = declaration.declarantUserId
  const access = {actorDeclarantUserId: user.id, targetDeclarantUserId: declarantUserId, client}
  await assertCanDeclareFor(access)
  await assertQuickDeclarationEnabled(access)
  if (!scope.length && user.id !== declarantUserId) throw forbidden()
  // Resolve an old row against every exploitation first. A single delegated exploitation
  // among two candidates doesn't identify which exploitation owns the measurement.
  const all = await client.declarantPointPrelevement.findMany({where: {
    declarantUserId, pointPrelevementId: {in: [...new Set(scope.map(row => row.pointPrelevementId))]}
  }, include: {pointPrelevement: true, collecteurs: {select: {collecteurUserId: true}}}})
  const byId = new Map(all.map(e => [e.id, e]))
  const resolve = row => {
    const candidates = row.exploitationId ? [] : all.filter(e => e.pointPrelevementId === row.pointPrelevementId
      && (!e.startDate || asDate(e.startDate) <= row.maxDate) && (!e.endDate || asDate(e.endDate) >= row.minDate))
    const [candidate] = candidates
    const complete = candidates.length === 1 && (!candidate.startDate || asDate(candidate.startDate) <= row.minDate)
      && (!candidate.endDate || asDate(candidate.endDate) >= row.maxDate)
    const id = row.exploitationId ?? (complete ? candidate.id : null)
    const e = byId.get(id)
    if (!e || e.pointPrelevementId !== row.pointPrelevementId || e.excludeFromQuickDeclaration || e.pointPrelevement.deletedAt
      || e.pointPrelevement.collectionMode === 'EXTERNAL' || (user.id !== declarantUserId && !e.collecteurs.some(c => c.collecteurUserId === user.id))) throw forbidden()
    return e
  }
  scope.forEach(resolve)
  return resolve
}

async function getEditableEntries(client, declaration, resolveScope) {
  const entries = declaration.source.chunks.map(chunkEntry).filter(Boolean)
  for (const entry of entries.filter(e => !e.exploitationId)) {
    const periodStartDate = entry.readingDate ?? entry.periodStartDate
    const periodEndDate = entry.readingDate ?? entry.periodEndDate
    const match = resolveScope?.({...entry, minDate: periodStartDate, maxDate: periodEndDate})
    entry.effectiveExploitationId = match?.id ?? await resolveHistoricalQuickExploitation(client, {
      declarantUserId: declaration.declarantUserId, pointPrelevementId: entry.pointPrelevementId, periodStartDate, periodEndDate
    })
    if (!match && entry.effectiveExploitationId) {
      const exploitation = await client.declarantPointPrelevement.findUnique({where: {id: entry.effectiveExploitationId}, select: {countingCode: true}})
      entry.countingCode = exploitation?.countingCode ?? null
    } else {
      entry.countingCode = match?.countingCode ?? null
    }
  }
  return entries
}

export async function getEditableQuickDeclaration(client, user, declarationId) {
  if (resourceIdSchema.required().validate(declarationId).error) throw createHttpError(404, 'Déclaration introuvable.')
  if (!['DECLARANT', 'ADMIN'].includes(user.role)) throw forbidden()
  const declaration = await client.declaration.findUnique({where: {id: declarationId, files: {none: {}}},
    include: {collectionResponse: {select: {id: true}}, source: {include: includeSource}}})
  const source = declaration?.source
  if (!source || declaration.collectionResponse || source.metadata?.collectionCampaignId || source.type !== 'DECLARATION'
    || source.metadata?.manualQuickDeclaration !== true || source.metadata?.nativeTemporal || declaration.dataSourceType !== 'MANUAL'
    || !source.chunks.every(chunk => isManualChunk(chunk, declaration.declarantUserId))) throw createHttpError(404, 'Saisie en ligne introuvable.')
  const scope = await getRetainedScope(client, declaration)
  const resolveScope = user.role === 'ADMIN' ? null : await authorizeEditScope(client, user, declaration, scope)
  const entries = await getEditableEntries(client, declaration, resolveScope)
  return {declaration, entries, scope}
}

function publicDraft({declaration, entries}) {
  const meta = declaration.source.metadata
  return {id: declaration.id, code: declaration.code, createdAt: declaration.createdAt, sourceId: declaration.source.id,
    declarantUserId: declaration.declarantUserId, revision: meta.quickRevision ?? 0,
    measurementType: meta.measurementType === 'INDEX' || (!meta.measurementType && entries[0]?.readingDate) ? 'INDEX' : 'VOLUME',
    comment: declaration.comment, aotDecreeNumber: declaration.aotDecreeNumber, entries}
}

export async function getAvailableQuickEntries(client, user, declarantUserId, exploitationIds) {
  const exploitations = await client.declarantPointPrelevement.findMany({
    where: {...quickDeclarationExploitationWhere({declarantUserId, actorDeclarantUserId: user.role === 'ADMIN' ? undefined : user.id}),
      declarant: {declarantRole: 'PRELEVEUR', quickDeclarationEnabled: true},
      ...(exploitationIds ? {id: {in: exploitationIds}} : {})},
    select: {id: true, countingCode: true, pointPrelevementId: true, pointPrelevement: {select: {name: true, usageName: true, flowType: true}},
      usageId: true, usage: {select: {id: true, label: true, kind: true, parentId: true}}},
    orderBy: [{pointPrelevement: {name: 'asc'}}, {countingCode: 'asc'}, {id: 'asc'}]
  })
  return exploitations.map(row => ({exploitationId: row.id, pointPrelevementId: row.pointPrelevementId,
    pointName: getQuickDeclarationPointDisplayName(row.pointPrelevement), countingCode: row.countingCode,
    compteurId: null, compteurName: null, usageId: row.usageId, usageLabel: row.usage.label,
    flowType: row.pointPrelevement.flowType, rootUsageId: getWaterUseRootId(row.usage)}))
}

export async function getEditableQuickHandler(req, res, next) {
  try {
    const data = await prisma.$transaction(async client => {
      const draft = publicDraft(await getEditableQuickDeclaration(client, req.user, req.params.declarationId))
      const options = draft.entries.length ? await getAvailableQuickEntries(client, req.user, draft.declarantUserId) : []
      draft.availableEntries = options.map(({rootUsageId, ...entry}) => entry)
      if (draft.measurementType === 'INDEX') {
        const previous = await getQuickPreviousReadings(client, draft)
        for (const entry of draft.entries) {
          if (previous.has(entry.id)) entry.previousReading = previous.get(entry.id)
        }
      }
      return draft
    }, {isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead})
    return res.json({success: true, data})
  } catch (error) { return next(error) }
}

function getDates(body, entry, isIndex) {
  if (isIndex) return {readingDate: asDate(parseQuickDeclarationDate(entry.readingDate ?? body.readingDate, 'La date du relevé'))}
  const start = parseQuickDeclarationDate(entry.periodStartDate ?? body.periodStartDate, 'La date de début')
  const end = parseQuickDeclarationDate(entry.periodEndDate ?? body.periodEndDate, 'La date de fin')
  if (end < start) throw createHttpError(400, 'La date de fin doit être postérieure ou égale à la date de début.')
  return {periodStartDate: asDate(start), periodEndDate: asDate(end)}
}

async function retainedCorrectionEntry(client, declarantUserId, old, input, dates) {
  if (!old || input.pointPrelevementId !== old.pointPrelevementId
    || (input.exploitationId ?? null) !== old.exploitationId || input.usageId !== old.usageId
    || (input.countingCode != null && input.countingCode !== old.countingCode)) throw forbidden()
  if (!old.exploitationId) {
    const destinationId = await resolveHistoricalQuickExploitation(client, {
      declarantUserId, pointPrelevementId: old.pointPrelevementId,
      periodStartDate: dates.readingDate ?? dates.periodStartDate, periodEndDate: dates.readingDate ?? dates.periodEndDate
    })
    if (old.effectiveExploitationId !== destinationId) throw forbidden()
  }
  const {readingDate, periodStartDate, periodEndDate, ...identity} = old
  return {...identity, ...dates, value: input.value ?? input.index}
}

function addedCorrectionEntry(option, currentEntries, input, dates) {
  if (!option || option.pointPrelevementId !== input.pointPrelevementId || option.usageId !== input.usageId
    || (input.countingCode != null && input.countingCode !== option.countingCode)) throw forbidden()
  const occupied = currentEntries.some(entry => {
    const id = entry.effectiveExploitationId ?? entry.exploitationId
    return id ? id === option.exploitationId : entry.pointPrelevementId === option.pointPrelevementId
  })
  if (occupied) throw createHttpError(400, 'Ce comptage appartient déjà à une ligne du dossier. Modifiez ou rétablissez cette ligne.')
  return {...option, ...dates, value: input.value ?? input.index}
}

async function prepareQuickCorrection(client, user, body, current) {
  const declarantUserId = current.declaration.declarantUserId
  const isIndex = body.measurementType === 'INDEX'
  if (body.revision !== (current.declaration.source.metadata.quickRevision ?? 0)) throw stale()
  if (!current.entries.length) throw createHttpError(409, 'Cette déclaration ne contient plus de mesure active.')
  if ([body.declarantUserId, body.preleveurUserId, body.targetDeclarantUserId].some(id => id && id !== declarantUserId) || body.pointUsageNames.length) throw forbidden()
  const oldById = new Map(current.entries.map(row => [row.id, row]))
  const existingIds = body.entries.filter(row => row.id).map(row => row.id)
  if (new Set(existingIds).size !== existingIds.length) throw createHttpError(400, 'Une ligne est présente plusieurs fois.')
  const newInputs = body.entries.filter(entry => !entry.id)
  ensureUniquePointEntries(newInputs)
  const options = newInputs.length ? await getAvailableQuickEntries(client, user, declarantUserId, newInputs.map(e => e.exploitationId)) : []
  const optionsById = new Map(options.map(option => [option.exploitationId, option]))
  const entries = []
  for (const input of body.entries) {
    const dates = getDates(body, input, isIndex)
    const entry = input.id
      ? await retainedCorrectionEntry(client, declarantUserId, oldById.get(input.id), input, dates)
      : addedCorrectionEntry(optionsById.get(input.exploitationId), current.entries, input, dates)
    entries.push(entry)
  }
  entries.sort((a, b) => (a.id ?? a.exploitationId).localeCompare(b.id ?? b.exploitationId))
  return {declarantUserId, measurementType: body.measurementType, entries, declarationType: quickType}
}

async function prepareDraft(client, user, body, current) {
  if (current) return prepareQuickCorrection(client, user, body, current)
  const declarantUserId = getTargetDeclarantUserId(body, user.id)
  const isIndex = body.measurementType === 'INDEX'
  let declarationType = quickType
  await assertCanDeclareFor({actorDeclarantUserId: user.id, targetDeclarantUserId: declarantUserId, client})
  await assertQuickDeclarationEnabled({actorDeclarantUserId: user.id, targetDeclarantUserId: declarantUserId, client})
  const requestedType = normalizeDeclarationTypeCode(body.type)
  if (requestedType && requestedType !== quickType.code) {
    declarationType = await findAllowedDeclarationTypeForDeclarant(declarantUserId, requestedType, new Date(), client)
    if (!declarationType) throw forbidden()
  }
  const pointIds = [...new Set([...body.entries, ...body.pointUsageNames].map(row => row.pointPrelevementId))]
  const byPoint = await getLinkedExploitationsByPointId({declarantUserId, actorDeclarantUserId: user.id, pointPrelevementIds: pointIds, client})
  assertManualCollectionAccess(byPoint, pointIds)
  assertQuickPointUsageNameAccess(byPoint, body.pointUsageNames)
  ensureUniquePointUsageNames(body.pointUsageNames)
  assertLegacyQuickDeclarationFlowType(body.measurementType, byPoint)
  const entries = []
  for (const input of body.entries) {
    const dates = getDates(body, input, isIndex)
    if (input.id) throw createHttpError(400, 'Une nouvelle ligne ne possède pas d’identifiant.')
    const exploitation = resolveQuickExploitation(byPoint, input)
    const usage = await resolveWaterUseInput(input, {declaration: true, client})
    entries.push({pointPrelevementId: input.pointPrelevementId, exploitationId: exploitation.id,
      compteurId: null, compteurName: null, pointName: getQuickDeclarationPointDisplayName(exploitation.pointPrelevement),
      flowType: exploitation.pointPrelevement.flowType ?? 'PRELEVEMENT',
      usageId: usage.id, rootUsageId: getWaterUseRootId(usage), value: input.value ?? input.index, ...dates})
  }
  ensureUniquePointEntries(entries)
  return {declarantUserId, measurementType: isIndex ? 'INDEX' : 'VOLUME', entries, declarationType}
}

function datesOf(row) {
  return row.readingDate ? {readingDate: row.readingDate} : {periodStartDate: row.periodStartDate, periodEndDate: row.periodEndDate}
}

function sameMeasure(a, b) {
  return a.value === b.value && a.readingDate === b.readingDate && a.periodStartDate === b.periodStartDate && a.periodEndDate === b.periodEndDate
}

function sourceMetadata(meta, draft, isEdit) {
  const result = {...meta}
  for (const key of ['readingDate', 'periodStartDate', 'periodEndDate', 'reconstructionResults']) delete result[key]
  const starts = draft.entries.map(row => row.readingDate ?? row.periodStartDate).sort()
  const ends = draft.entries.map(row => row.readingDate ?? row.periodEndDate).sort()
  if (starts.length) {
    if (draft.measurementType === 'INDEX' && starts[0] === ends.at(-1)) result.readingDate = starts[0]
    else Object.assign(result, {periodStartDate: starts[0], periodEndDate: ends.at(-1)})
  }
  return {...result, manualQuickDeclaration: true, measurementType: draft.measurementType, entriesCount: draft.entries.length,
    ...(isEdit ? {quickModifiedAt: new Date().toISOString(), quickRevision: (meta.quickRevision ?? 0) + 1} : {})}
}

function measureRow(row, chunkId) {
  const isIndex = Boolean(row.readingDate)
  const periodStart = new Date(row.readingDate ?? row.periodStartDate)
  return {id: randomUUID(), chunkId, metricTypeCode: isIndex ? 'index' : 'volume', unit: 'm³', frequency: isIndex ? 'instant' : '1 day',
    periodStart, periodEnd: getQuickDeclarationValuePeriodEnd(isIndex, new Date(row.readingDate ?? row.periodEndDate)), valueKind: 'DECLARED', value: row.value}
}

function chunkMetadata(meta, row, flowType) {
  const result = {...meta}
  for (const key of ['readingDate', 'periodStartDate', 'periodEndDate', 'indexValue', 'indexUnit']) delete result[key]
  return {...result, quickDeclaration: true, flowType, measurementType: row.readingDate ? 'INDEX' : 'VOLUME', declaredValue: row.value,
    ...datesOf(row), unit: 'm³', ...(row.readingDate ? {indexValue: row.value, indexUnit: 'm³'} : {})}
}

function addConflictWarnings(context, row, identity, conflicts, warnings) {
  const {draft, displacedValues, insertedValues, activeReadings} = context
  for (const conflict of conflicts) {
    if (conflict.valueKind !== 'DECLARED' || conflict.calculationStrategy === 'METER') continue
    if (row.readingDate && !activeReadings.has(conflict.chunkValueId)) continue
    if (!insertedValues.has(conflict.chunkValueId)) displacedValues.push(conflict.chunkValueId)
    const conflictStart = asDate(conflict.periodStart)
    const conflictEnd = row.readingDate ? conflictStart : asDate(new Date(conflict.periodEnd.getTime() - 1))
    warnings.push({pointPrelevementId: row.pointPrelevementId, exploitationId: identity.exploitationId, pointName: row.pointName,
      compteurId: row.compteurId, compteurName: row.compteurName, ...(row.id ? {entryId: row.id} : {}),
      ...(conflict.declarationId && conflict.preleveurUserId === draft.declarantUserId && !conflict.sourceMetadata?.collectionCampaignId
        ? {declarationCode: conflict.declarationCode} : {}),
      code: row.readingDate ? 'INDEX_SAME_DATE' : 'VOLUME_OVERLAP',
      message: row.readingDate
        ? `Un index de ${Number(conflict.value).toLocaleString('fr-FR')} m³ est déjà enregistré à cette date.`
        : 'La nouvelle période remplace la totalité du volume déclaré sur la période qui se chevauche.',
      periodStartDate: conflictStart, periodEndDate: conflictEnd,
      ...(row.readingDate ? {readingDate: row.readingDate, neighborDate: conflictStart, neighborValue: Number(conflict.value)} : {}),
      value: Number(conflict.value), valueKind: conflict.valueKind})
  }
}

async function writeMeasure(client, context, row, chunk, warnings) {
  const {draft, declaration, source, actorData, insertedValues} = context
  const flowType = chunk?.flowType ?? row.flowType
  const data = {minDate: new Date(row.readingDate ?? row.periodStartDate), maxDate: new Date(row.readingDate ?? row.periodEndDate),
    metadata: chunkMetadata(chunk?.metadata, row, flowType)}
  const record = chunk
    ? await client.chunk.update({where: {id: chunk.id}, data})
    : await client.chunk.create({data: {...data, ...actorData, flowType, usageId: row.usageId, sourceId: source.id,
      pointPrelevementId: row.pointPrelevementId, exploitationId: row.exploitationId, pointPrelevementName: row.pointName,
      instructionStatus: 'VALIDATED', parsingInfo: {parser: 'quick-declaration-form', reason: 'MANUAL_QUICK_DECLARATION'}}})
  const incoming = measureRow(row, record.id)
  const identity = {includeQuickLegacyActor: true, pointPrelevementId: row.pointPrelevementId, preleveurUserId: draft.declarantUserId, exploitationId: row.effectiveExploitationId ?? row.exploitationId}
  if (record.instructionStatus !== 'REJECTED') {
    const conflicts = (await findConflictingChunkValuesForIncomingChunkValues({client, ...identity, valueRows: [incoming]}))
      .filter(v => v.calculationStrategy === 'METER' || (v.valueKind === 'DECLARED' && !v.orangePartition
        && v.effectiveExploitationId === identity.exploitationId && v.compteurId === row.compteurId))
    addConflictWarnings(context, row, identity, conflicts, warnings)
    if (!row.readingDate) {
      const result = await applyConflictPolicyForIncomingChunkValues({...identity, client, valueRows: [incoming],
        // Only this exact series may be replaced. METER observations retain the existing publication protection.
        findConflictingChunkValues: async () => conflicts, requestedPolicy: 'REPLACE_EXISTING',
        replaceComment: 'AUTO_REPLACED_BY_QUICK_DECLARATION', replacementSourceId: source.id,
        replacementMetadata: {manualQuickDeclaration: true, measurementType: 'VOLUME', declarationId: declaration.id,
          declarationCode: declaration.code, incomingChunkId: record.id}})
      assertManualVolumePublication(result, 1)
    }
  }
  await client.chunkValue.create({data: incoming})
  insertedValues.add(incoming.id)
  return record.id
}

async function saveQuickSource(client, user, body, current, draft) {
  const declaration = current?.declaration ?? await client.declaration.create({data: {
    code: generateDossierCode(), type: draft.declarationType.code, declarantUserId: draft.declarantUserId,
    createdByDeclarantUserId: user.id, comment: body.comment?.trim() || null, aotDecreeNumber: body.aotDecreeNumber?.trim() || null,
    dataSourceType: 'MANUAL', waterWithdrawalType: 'unknown', processingStatus: 'COMPLETED', processingCompletedAt: new Date()
  }})
  const metadata = sourceMetadata(current?.declaration.source.metadata ?? {}, draft, Boolean(current))
  const source = current
    ? await client.source.update({where: {id: declaration.source.id}, data: {metadata}})
    : await client.source.create({data: {type: 'DECLARATION', status: 'COMPLETED', globalInstructionStatus: 'VALIDATED',
      declarationId: declaration.id, metadata}})
  const actorData = user.role === 'ADMIN'
    ? {preleveurUserId: draft.declarantUserId, submittedByDeclarantUserId: null, collecteurUserId: null}
    : await buildChunkActorData({client, preleveurUserId: draft.declarantUserId, submittedByDeclarantUserId: user.id})
  return {declaration, source, actorData}
}

async function saveDraftEntries(client, context, current, newById, warnings) {
  const {draft, source} = context
  const oldEntries = current?.entries ?? []
  // Remove all displaced values first, so siblings and previous versions are never counted as conflicts with themselves.
  const oldById = new Map(oldEntries.map(entry => [entry.id, entry]))
  const removedIds = oldEntries.filter(row => !newById.has(row.id)).map(row => row.id)
  const changedIds = oldEntries.filter(row => newById.has(row.id) && !sameMeasure(row, newById.get(row.id))).map(row => row.id)
  if (removedIds.length) await client.chunk.deleteMany({where: {sourceId: source.id, id: {in: removedIds}}})
  if (changedIds.length) await client.chunkValue.deleteMany({where: {chunkId: {in: changedIds}}})
  const resultingEntries = []
  for (const entry of draft.entries) {
    if (oldById.has(entry.id) && sameMeasure(oldById.get(entry.id), entry)) {
      resultingEntries.push(entry)
      continue
    }
    const chunk = current?.declaration.source.chunks.find(chunk => chunk.id === entry.id)
    const id = await writeMeasure(client, context, entry, chunk, warnings)
    resultingEntries.push({...entry, id})
    if (!entry.id && entry.rootUsageId) await addExploitationSecondaryUsage(entry.exploitationId, entry.rootUsageId, {client})
  }
  return {resultingEntries, modifiedEntries: Boolean(removedIds.length || changedIds.length || draft.entries.some(e => !e.id))}
}

async function refreshPublishedVolumes(client, source, draft, impactScope) {
  const reconstructionResults = await reconstructQuickVolumes(client, impactScope)
  await refreshVolumeMetadataForSourceIds([source.id], client)
  const refreshed = await client.source.findUniqueOrThrow({where: {id: source.id}, select: {metadata: true}})
  const totals = refreshed.metadata
  await client.source.update({where: {id: source.id}, data: {metadata: {...totals,
    totalWaterVolume: (totals.totalWaterVolumeWithdrawn ?? 0) + (totals.totalWaterVolumeDischarged ?? 0),
    ...(draft.measurementType === 'INDEX' && reconstructionResults.length ? {reconstructionResults} : {})}}})
  await refreshSourceDeclarantsLastDeclarationAt(source.id, {client})
  await refreshMostRecentAvailableDateForDeclarantPoints({declarantUserId: draft.declarantUserId,
    pointPrelevementIds: impactScope.entries.map(row => row.pointPrelevementId), client})
}

function associateWarningsWithEntries(warnings, affected) {
  for (const warning of warnings.filter(w => !w.entryId)) {
    const matches = affected.filter(row => row.pointPrelevementId === warning.pointPrelevementId
      && (row.effectiveExploitationId ?? row.exploitationId) === warning.exploitationId && row.compteurId === warning.compteurId)
    const ids = new Set(matches.filter(row => !warning.readingDate || row.readingDate === warning.readingDate).map(row => row.id))
    if (ids.size === 1 && !ids.has(undefined)) warning.entryId = ids.values().next().value
  }
}

async function applyQuickDraft(client, user, body, current, draft) {
  const oldEntries = current?.entries ?? []
  const affected = [...oldEntries, ...draft.entries]
  for (const id of [...new Set(affected.map(row => row.pointPrelevementId))].sort()) {
    await lockPointForReconstruction(client, id)
  }
  const impactScope = {declarantUserId: draft.declarantUserId, entries: affected}
  const before = await captureQuickVolumes(client, impactScope)
  const newById = new Map(draft.entries.filter(entry => entry.id).map(entry => [entry.id, entry]))
  const oldDates = {declarantUserId: draft.declarantUserId,
    entries: oldEntries.filter(e => e.readingDate && e.readingDate !== newById.get(e.id)?.readingDate)}
  const previousReadings = await captureQuickEffectiveReadings(client, oldDates)
  const {declaration, source, actorData} = await saveQuickSource(client, user, body, current, draft)
  const displacedValues = []
  const candidates = await captureQuickEffectiveReadings(client, {declarantUserId: draft.declarantUserId, entries: draft.entries})
  const retainedByDate = new Map()
  for (const observation of candidates) {
    const key = [observation.pointPrelevementId, observation.exploitationId, observation.compteurId, asDate(observation.date)].join('/')
    if (!retainedByDate.has(key)) retainedByDate.set(key, observation.id)
  }
  const context = {draft, declaration, source, actorData, displacedValues, insertedValues: new Set(), activeReadings: new Set(retainedByDate.values())}
  const warnings = []
  const {resultingEntries, modifiedEntries} = await saveDraftEntries(client, context, current, newById, warnings)
  if (!current) {
    for (const {pointPrelevementId, usageName} of body.pointUsageNames) {
      await client.pointPrelevement.update({where: {id: pointPrelevementId}, data: {usageName: usageName?.trim() || null}})
    }
  }
  for (const pointPrelevementId of new Set(draft.entries.filter(e => !e.id).map(e => e.pointPrelevementId))) {
    const declarantUserIds = user.role === 'ADMIN' ? [draft.declarantUserId] : [draft.declarantUserId, user.id]
    await syncDeclarantZonesFromPoint({declarantUserIds, pointPrelevementId,
      source: 'DECLARATION', createdByUserId: user.id, client})
  }
  await refreshPublishedVolumes(client, source, draft, impactScope)
  const after = await captureQuickVolumes(client, impactScope)
  const touched = new Set([
    ...draft.entries.filter(row => !row.id),
    ...oldEntries.filter(row => !newById.has(row.id) || !sameMeasure(row, newById.get(row.id)))
  ].map(quickSeriesKey))
  const active = {declarantUserId: draft.declarantUserId,
    entries: current ? resultingEntries.filter(row => touched.has(quickSeriesKey(row))) : resultingEntries}
  if (draft.measurementType === 'INDEX') warnings.push(...await findQuickIndexWarnings(client, active))
  warnings.push(...await findQuickMixedWarnings(client, active))
  if (previousReadings.length) {
    warnings.push(...restoredQuickReadingWarnings(previousReadings, await captureQuickEffectiveReadings(client, oldDates)))
  }
  if (current) associateWarningsWithEntries(warnings, affected)
  warnings.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const modified = modifiedEntries || (current && publicDraft(current).measurementType !== draft.measurementType)
  return {declaration, source, resultingEntries, displacedValues, modified, changes: compareQuickVolumes(before, after), warnings}
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

class PreviewComplete extends Error {
  constructor(result) {
    super('Quick declaration preview')
    this.result = result
  }
}

async function runQuickTransaction(action) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(action, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 60_000
      })
    } catch (error) {
      if (!isDatabaseWriteConflict(error)) throw error
      if (attempt >= 2) throw stale()
      await delay(25 * (attempt + 1))
    }
  }
}

async function handleQuickWrite(req, res, next, previewOnly) {
  try {
    const declarationId = req.params?.declarationId
    const edit = Boolean(declarationId)
    const schema = edit ? editQuickDeclarationSchema : createQuickDeclarationSchema
    const {error, value: body} = schema.validate(req.body, {abortEarly: false})
    if (error) throw createHttpError(400, error.message)
    if (!previewOnly && edit && !body.previewToken) throw stale()

    const result = await runQuickTransaction(async client => {
      if (edit && resourceIdSchema.validate(declarationId).error) throw createHttpError(404, 'Déclaration introuvable.')
      if (edit) await client.$queryRaw`SELECT id FROM "Declaration" WHERE id = ${declarationId}::uuid FOR UPDATE`
      const current = edit ? await getEditableQuickDeclaration(client, req.user, declarationId) : null
      const draft = await prepareDraft(client, req.user, body, current)
      const {declaration, source, resultingEntries, displacedValues, modified, changes, warnings} = await applyQuickDraft(client, req.user, body, current, draft)
      const revision = current?.declaration.source.metadata.quickRevision ?? 0
      const previewToken = digest([req.user.id, declarationId ?? null, revision, draft.declarantUserId, draft.measurementType,
        draft.entries, draft.declarationType.code, body.comment ?? '', body.aotDecreeNumber ?? '', body.pointUsageNames, displacedValues.sort(), changes, warnings])
      if (previewOnly) throw new PreviewComplete({previewToken, changes, warnings})
      if (body.previewToken && previewToken !== body.previewToken) throw stale()
      if (current && !modified) {
        // The simulation may rebuild derived volumes; leave every stored row untouched on a no-op.
        throw new PreviewComplete({id: declaration.id, code: declaration.code, sourceId: source.id, revision, measurementType: draft.measurementType})
      }
      if (current) {
        await client.quickDeclarationRevision.create({data: {declarationId, revision: revision + 1,
          actorUserId: req.authActor?.id ?? req.user.id, effectiveUserId: req.user.id,
          before: {measurementType: publicDraft(current).measurementType, entries: current.entries,
            ...(revision === 0 ? {scope: scopeFromChunks(current.declaration.source.chunks)} : {})},
          after: {measurementType: draft.measurementType, entries: resultingEntries,
            scope: mergeScope(current.scope, draft.entries.filter(e => !e.id).map(e => ({
              pointPrelevementId: e.pointPrelevementId, exploitationId: e.exploitationId,
              minDate: e.readingDate ?? e.periodStartDate, maxDate: e.readingDate ?? e.periodEndDate
            })))}}})
        await client.declaration.update({where: {id: declarationId}, data: {updatedAt: new Date()}})
      } else {
        await client.declarationProcessingEvent.create({data: {declarationId: declaration.id, status: 'COMPLETED',
          message: 'Traitement terminé', metadata: {manualQuickDeclaration: true, measurementType: draft.measurementType,
            entriesCount: draft.entries.length}, createdByUserId: req.user.id}})
      }
      if (edit) return {id: declaration.id, code: declaration.code, sourceId: source.id, revision: revision + 1, measurementType: draft.measurementType}
      return {...declaration, declarationType: draft.declarationType, files: [],
        source: await client.source.findUnique({where: {id: source.id}, include: {chunks: {include: {
          pointPrelevement: true, usage: true, chunkValues: true
        }}}})}
    })
    return res.status(edit ? 200 : 201).json({success: true, data: result})
  } catch (error) {
    if (error instanceof PreviewComplete) return res.json({success: true, data: error.result})
    const databaseCause = error.meta?.driverAdapterError?.cause
    const databaseMessage = [databaseCause?.originalMessage, error.meta?.message, error.message].join(' ')
    if (['23514', 'P2039'].some(code => [error.code, error.meta?.code, databaseCause?.originalCode].includes(code))
      && databaseMessage.includes('An active physical meter publication protects this volume interval')) {
      return next(createHttpError(409, 'Ces volumes recouvrent une publication de compteur protégée. Corrigez les relevés ou les affectations du compteur concerné.'))
    }
    return next(error)
  }
}

export const previewQuickHandler = (req, res, next) => handleQuickWrite(req, res, next, true)
export const updateQuickHandler = (req, res, next) => handleQuickWrite(req, res, next, false)
export const createQuickDeclarationHandler = (req, res, next) => handleQuickWrite(req, res, next, false)
