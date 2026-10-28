import {summarizeNativeIssues, mergeNativeDiagnostics} from './native-diagnostics.js'
import {nativeConflicts} from './native-conflicts.js'
import {nativeRecoveryReference, retainNativeRecovery} from './native-overlap-recovery.js'
import {NATIVE_ASSOCIATION_ISSUE_CODES, canRepairNativePointAssociation, planNativePointAssociationRepair,
  resolveNativePointAssociation, refreshNativeAssociationDiagnostics} from './native-point-association.js'
import {computeGlobalPointMatchingStatus} from '../handlers/chunks.js'
export {nativeConflicts, nativeDimension, periodsOverlap} from './native-conflicts.js'
import {refreshVolumeMetadataForSourceIds} from '../services/volume-totals.js'
import {refreshSourceDeclarantsLastDeclarationAt} from '../models/declarant.js'
/* eslint-disable no-await-in-loop */
import {createHash} from 'node:crypto'
import {Prisma} from '@prisma/client'
import createHttpError from 'http-errors'
import {normalizeMetricTypeCode} from '../constants/metric-type-codes.js'
import {refreshMostRecentAvailableDateForDeclarantPoints} from '../services/declaration-side-effects.js'

export const NATIVE_DECLARATION_TYPES = new Set(['reunion_multi_param', 'reunion_camion_citerne', 'reunion-multi-param', 'reunion-camion-citerne'])
export function exactDecimal(value) {
  if (typeof value !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(value)) throw new Error('Valeur décimale invalide')
  const decimal = new Prisma.Decimal(value)
  if (decimal.decimalPlaces() > 30 || decimal.abs().gte(new Prisma.Decimal('1e23'))) throw new Error('Précision dépassée (23 entiers, 30 décimales)')
  return decimal.toFixed()
}

export function normalizeNativeValues(series) {
  const values = []
  const errors = []
  const seen = new Map()
  for (const item of series.data ?? []) {
    try {
      const periodStart = new Date(item.periodStart)
      const periodEnd = new Date(item.periodEnd)
      if (!Number.isFinite(periodStart.getTime()) || !Number.isFinite(periodEnd.getTime()) || periodStart > periodEnd) throw new Error('Période invalide')
      const value = exactDecimal(item.value)
      const key = `${periodStart.toISOString()}/${periodEnd.toISOString()}`
      if (seen.has(key)) {
        if (seen.get(key) !== value) {
          const previousIndex = values.findIndex(previous => +previous.periodStart === +periodStart && +previous.periodEnd === +periodEnd)
          if (previousIndex >= 0) values.splice(previousIndex, 1)
          seen.set(key, null)
          throw new Error('Valeurs contradictoires pour la même période : toutes exclues')
        }
        errors.push({code: 'DUPLICATE_ROW', severity: 'warning', seriesKey: series.seriesKey, ...item.metadata, message: 'Ligne identique déjà présente'})
        continue
      }
      seen.set(key, value)
      values.push({periodStart, periodEnd, value, metricTypeCode: normalizeMetricTypeCode(series.parameter === 'relevé d’index de compteur' ? 'index' : series.parameter), unit: series.unit,
        frequency: series.frequency, valueKind: 'DECLARED', remark: item.remark ?? null, metadata: {...item.metadata, rawValue: item.value, nativeTemporal: true}})
    } catch (error) {
      errors.push({code: 'INVALID_VALUE', severity: 'error', seriesKey: series.seriesKey, ...item.metadata, message: error.message, rawValue: item.value})
    }
  }
  values.sort((a, b) => a.periodStart - b.periodStart || a.periodEnd - b.periodEnd)
  return {values, errors}
}


function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function businessDate(date) { return new Date(new Date(+date + 4 * 3600000).toISOString().slice(0, 10)) }
function sameRevision(old, next) {
  return old && !old.metadata?.superseded && (old.contentHash === next.contentHash
    || (old.contentHash === next.legacyContentHash && old.metadata?.valueType === next.series.valueType))
}

async function repairReceivedNativeAssociations(tx, source, declaration) {
  const candidates = source.chunks.filter(canRepairNativePointAssociation)
  if (!candidates.length) return
  const points = await tx.pointPrelevement.findMany({where: {
    sourceId: {in: [...new Set(candidates.map(chunk => chunk.metadata.sourcePointReference))]}, deletedAt: null
  }, orderBy: {id: 'asc'}})
  for (const point of points) await tx.$queryRaw`SELECT id FROM "PointPrelevement" WHERE id = ${point.id}::uuid FOR UPDATE`
  let changed = false
  for (const chunk of candidates.sort((a, b) => a.id.localeCompare(b.id))) {
    const point = points.find(point => point.sourceId === chunk.metadata.sourcePointReference)
    if (!point) continue
    const values = await tx.chunkValue.findMany({where: {chunkId: chunk.id}, select: {periodStart: true, periodEnd: true, metricTypeCode: true}})
    const data = await planNativePointAssociationRepair(tx, {chunk, point, values, declarantUserId: declaration.declarantUserId})
    if (data) {
      await tx.chunk.update({where: {id: chunk.id}, data})
      Object.assign(chunk, data)
      changed = true
    }
  }
  if (!changed) return
  source.metadata = {...source.metadata, ...refreshNativeAssociationDiagnostics(source.metadata, source.chunks)}
  await tx.source.update({where: {id: source.id}, data: {metadata: source.metadata,
    globalInstructionStatus: computeGlobalPointMatchingStatus(source.chunks.filter(chunk => !chunk.metadata?.superseded))}})
  await refreshMostRecentAvailableDateForDeclarantPoints({declarantUserId: declaration.declarantUserId,
    pointPrelevementIds: source.chunks.map(chunk => chunk.pointPrelevementId), client: tx})
  await refreshVolumeMetadataForSourceIds([source.id], tx)
  await refreshSourceDeclarantsLastDeclarationAt(source.id, {client: tx})
}

export async function ingestNativeDeclaration({declaration, data, errors = [], processingMetadata = {}, client}) {
  const run = async tx => {
    // Serialize replay and association on this dossier, including its first ingestion.
    await tx.$queryRaw`SELECT id FROM "Declaration" WHERE id = ${declaration.id}::uuid FOR UPDATE`
    const previous = await tx.source.findUnique({where: {declarationId: declaration.id}, include: {chunks: true}})
    const batch = data?.batch
    const receiptHash = batch ? digest({data, errors}) : null
    let receipt = batch ? previous?.metadata?.nativeBatch : null
    if (batch) {
      if (!/^[a-zA-Z0-9_-]{16,128}$/.test(batch.id ?? '') || !Number.isInteger(batch.index) || !Number.isInteger(batch.total)
        || batch.index < 0 || batch.total < 1 || batch.index >= batch.total || batch.total > 10000) throw createHttpError(400, 'Lot natif invalide.')
      if (receipt?.id === batch.id) {
        if (receipt.total !== batch.total) throw createHttpError(409, 'Le nombre de parties du lot a changé.')
        if (receipt.hashes?.[batch.index]) {
          if (receipt.hashes[batch.index] !== receiptHash) throw createHttpError(409, 'Une partie du lot a changé. Utilisez une nouvelle version du lot.')
          await repairReceivedNativeAssociations(tx, previous, declaration)
          if (receipt.nextIndex === receipt.total && previous.status !== 'COMPLETED') {
            await tx.source.update({where: {id: previous.id}, data: {status: 'COMPLETED', globalInstructionStatus: computeGlobalPointMatchingStatus(previous.chunks.filter(chunk => !chunk.metadata?.superseded))}})
            await tx.declaration.update({where: {id: declaration.id}, data: {processingStatus: 'COMPLETED', processingCompletedAt: new Date(), processingError: null}})
            await refreshMostRecentAvailableDateForDeclarantPoints({declarantUserId: declaration.declarantUserId, pointPrelevementIds: previous.chunks.map(chunk => chunk.pointPrelevementId), client: tx})
            await refreshVolumeMetadataForSourceIds([previous.id], tx)
            await refreshSourceDeclarantsLastDeclarationAt(previous.id, {client: tx})
          }
          return {sourceId: previous.id, imported: true, replayed: true, completed: receipt.nextIndex === receipt.total}
        }
        if (batch.index !== receipt.nextIndex) throw createHttpError(409, 'Partie reçue dans le désordre.')
      } else {
        if (batch.index !== 0) throw createHttpError(409, 'La première partie du lot est requise.')
        receipt = {id: batch.id, total: batch.total, nextIndex: 0, keys: [], hashes: []}
      }
    }
    const finalize = !batch || batch.index === batch.total - 1
    const metadata = {nativeTemporal: true, provenance: 'PE', ...previous?.metadata, ...processingMetadata, declarationType: declaration.type, fileCount: declaration.files?.length ?? 0}
    const source = await tx.source.upsert({where: {declarationId: declaration.id}, create: {
      type: 'DECLARATION', declarationId: declaration.id, status: 'PROCESSING', metadata
    }, update: {status: 'PROCESSING', metadata}})
    const prepared = (data?.series ?? []).map(series => {
      const normalized = normalizeNativeValues(series)
      const revision = {point: series.pointPrelevement, parameter: series.parameter, unit: series.unit,
        frequency: series.frequency, metadata: series.metadata, values: normalized.values, errors: normalized.errors}
      return {series, ...normalized, contentHash: digest({...revision, valueType: series.valueType}), legacyContentHash: digest(revision)}
    })
    for (const old of previous?.chunks ?? []) {
      const recovery = nativeRecoveryReference(old)
      if (recovery) {
        const parentNext = prepared.find(item => item.series.seriesKey === recovery.parentSeriesKey)
        if ((parentNext && parentNext.contentHash !== recovery.parentContentHash) || (!batch && !parentNext)) {
          await tx.chunk.update({where: {id: old.id}, data: {instructionStatus: 'REJECTED', metadata: {...old.metadata, superseded: true}}})
        }
        continue
      }
      const next = prepared.find(item => item.series.seriesKey === old.seriesKey)
      // Retire the previous revisions inside this transaction before checking
      // overlaps: PENDING is also a visible series, not an excluded revision.
      if ((!batch && !next) || (next && !sameRevision(old, next))) await tx.chunk.update({where: {id: old.id}, data: {instructionStatus: 'REJECTED'}})
    }
    const points = await tx.pointPrelevement.findMany({where: {sourceId: {in: [...new Set(prepared.map(item => item.series.pointPrelevement).filter(Boolean))]}, deletedAt: null}})
    // Lock points in UUID order to prevent cross-dossier deadlocks.
    for (const point of [...points].sort((a, b) => a.id.localeCompare(b.id))) await tx.$queryRaw`SELECT id FROM "PointPrelevement" WHERE id = ${point.id}::uuid FOR UPDATE`
    const pointsBySourceId = new Map(points.map(point => [point.sourceId, point]))
    const issues = [...errors]
    const keys = new Set(batch ? receipt.keys : [])
    const fallback = await tx.sandreWaterUse.findUnique({where: {code: '0'}})
    if (!fallback) throw new Error('Usage Sandre inconnu absent')
    for (const preparedSeries of prepared.sort((a, b) => String(a.series.pointPrelevement).localeCompare(String(b.series.pointPrelevement)))) {
      const {series, values, errors: valueErrors, contentHash} = preparedSeries
      if (!series.nativeTemporal || !series.seriesKey || keys.has(series.seriesKey) || !series.parameter || !series.unit || !series.frequency) {
        throw createHttpError(400, 'Identité ou contrat de série native invalide')
      }
      keys.add(series.seriesKey)
      for (const issue of valueErrors) issues.push(issue)
      const old = previous?.chunks.find(c => c.seriesKey === series.seriesKey)
      if (sameRevision(old, preparedSeries)) {
        const association = await planNativePointAssociationRepair(tx, {chunk: old, point: pointsBySourceId.get(series.pointPrelevement),
          declarantUserId: declaration.declarantUserId, values})
        if (association) {
          await tx.chunk.update({where: {id: old.id}, data: association})
          Object.assign(old, association)
        }
        issues.push(...(old.parsingInfo?.issues ?? []).filter(issue => NATIVE_ASSOCIATION_ISSUE_CODES.has(issue.code)))
        continue
      }
      if (!values.length) {
        // Keep any old decision and data as a rejected revision rather than deleting its audit.
        if (old) await tx.chunk.update({where: {id: old.id}, data: {instructionStatus: 'REJECTED', contentHash,
          metadata: {...old.metadata, superseded: true}}})
        continue
      }
      const min = new Date(values.reduce((result, v) => Math.min(result, +v.periodStart), Infinity))
      const max = new Date(values.reduce((result, v) => Math.max(result, +v.periodEnd - (v.periodEnd > v.periodStart ? 1 : 0)), -Infinity))
      const point = pointsBySourceId.get(series.pointPrelevement)
      const {pointId, exploitation, issues: associationIssues} = await resolveNativePointAssociation(tx, {
        point, declarantUserId: declaration.declarantUserId, minDate: businessDate(min), maxDate: businessDate(max), seriesKey: series.seriesKey
      })
      const chunkMetadata = {...series.metadata, nativeTemporal: true, parameter: values[0].metricTypeCode, unit: series.unit,
        frequency: series.frequency, valueType: series.valueType, sourcePointReference: series.pointPrelevement}
      const conflict = await nativeConflicts(tx, {pointPrelevementId: pointId, preleveurUserId: declaration.declarantUserId,
        metadata: chunkMetadata, values, sourceId: source.id, excludeChunkId: old?.id ?? '00000000-0000-0000-0000-000000000000'})
      issues.push(...associationIssues)
      if (conflict) issues.push({code: 'OVERLAPPING_SERIES', severity: 'error', seriesKey: series.seriesKey, message: 'Une série existante couvre déjà cette période : nouvelle série écartée'})
      const instructionStatus = conflict ? 'REJECTED' : exploitation ? 'VALIDATED' : 'PENDING'
      const chunkData = {seriesKey: series.seriesKey, contentHash, autoCalculateVolumes: false, pointPrelevementName: series.pointPrelevement,
        pointPrelevementId: pointId, exploitationId: exploitation?.id ?? null, flowType: pointId ? point.flowType : null,
        preleveurUserId: declaration.declarantUserId, submittedByDeclarantUserId: declaration.createdByDeclarantUserId ?? declaration.declarantUserId,
        usageId: exploitation?.usageId ?? fallback.id, instructionStatus, instructedAt: null,
        instructedByInstructorUserId: null, instructionComment: null, metadata: {...chunkMetadata, importHistory: [...(old?.metadata?.importHistory ?? []), {date: new Date().toISOString(), contentHash, reason: old ? 'REIMPORT' : 'IMPORT'}]},
        minDate: businessDate(min), maxDate: businessDate(max), parsingInfo: {...summarizeNativeIssues(issues.filter(e => e.seriesKey === series.seriesKey), 25), ...(pointId ? {pointAssociationOrigin: 'AUTOMATIC'} : {})}}
      const chunk = old ? await tx.chunk.update({where: {id: old.id}, data: chunkData}) : await tx.chunk.create({data: {...chunkData, sourceId: source.id}})
      if (old) {
        const replaced = await tx.chunkValue.findMany({where: {chunkId: chunk.id}})
        for (let offset = 0; offset < replaced.length; offset += 1000) await tx.chunkValueReplacement.createMany({data: replaced.slice(offset, offset + 1000).map(value => ({
          replacedChunkValueId: value.id, replacedChunkId: chunk.id, replacedSourceId: source.id,
          pointPrelevementId: old.pointPrelevementId, metricTypeCode: value.metricTypeCode, unit: value.unit,
          frequency: value.frequency, periodStart: value.periodStart, periodEnd: value.periodEnd,
          valueKind: value.valueKind, value: value.value, conflictPolicy: 'NATIVE_REIMPORT',
          metadata: {previousContentHash: old.contentHash, remark: value.remark, provenance: value.metadata}
        }))})
        await tx.chunkValue.deleteMany({where: {chunkId: chunk.id}})
      }
      for (let offset = 0; offset < values.length; offset += 1000) await tx.chunkValue.createMany({data: values.slice(offset, offset + 1000).map(value => ({...value, chunkId: chunk.id}))})
    }
    for (const old of finalize ? previous?.chunks ?? [] : []) {
      if (retainNativeRecovery(old, {chunks: previous.chunks, prepared, keys})) continue
      if (old.seriesKey && !keys.has(old.seriesKey)) await tx.chunk.update({where: {id: old.id}, data: {instructionStatus: 'REJECTED', metadata: {...old.metadata, superseded: true}}})
    }
    const chunks = await tx.chunk.findMany({where: {sourceId: source.id}})
    const diagnostics = refreshNativeAssociationDiagnostics(mergeNativeDiagnostics(batch && batch.index > 0 ? previous?.metadata : null, issues), chunks)
    await tx.source.update({where: {id: source.id}, data: {status: finalize ? 'COMPLETED' : 'PROCESSING', globalInstructionStatus: computeGlobalPointMatchingStatus(chunks.filter(chunk => !chunk.metadata?.superseded)), metadata: {...metadata, ...diagnostics, ...(batch ? {nativeBatch: {...receipt, nextIndex: batch.index + 1, keys: [...keys], hashes: [...receipt.hashes, receiptHash]}} : {nativeBatch: null})}}})
    await tx.declaration.update({where: {id: declaration.id}, data: {processingStatus: finalize ? 'COMPLETED' : 'PROCESSING', processingCompletedAt: finalize ? new Date() : null, processingError: null}})
    // The first part withdraws any previous publication; the last publishes the
    // complete revision. Intermediate parts remain invisible (PROCESSING), so
    // rescanning every value and rewriting every cache there is unnecessary.
    if (finalize || batch.index === 0) {
      await refreshMostRecentAvailableDateForDeclarantPoints({declarantUserId: declaration.declarantUserId, pointPrelevementIds: [...chunks, ...(previous?.chunks ?? [])].map(c => c.pointPrelevementId), client: tx})
      await refreshVolumeMetadataForSourceIds([source.id], tx)
      await refreshSourceDeclarantsLastDeclarationAt(source.id, {client: tx})
    }
    return {sourceId: source.id, imported: chunks.length > 0, completed: finalize, errors: diagnostics.parsingErrors, errorCounts: diagnostics.parsingErrorCounts}
  }
  return typeof client.$transaction === 'function' ? client.$transaction(run, {timeout: 180000, maxWait: 30000}) : run(client)
}
