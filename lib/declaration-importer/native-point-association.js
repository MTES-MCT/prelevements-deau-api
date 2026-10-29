import {nativeConflicts} from './native-conflicts.js'
import {mergeNativeDiagnostics} from './native-diagnostics.js'

export const NATIVE_ASSOCIATION_ISSUE_CODES = new Set([
  'UNMATCHED_POINT', 'EXPLOITATION_NOT_FOUND', 'EXPLOITATION_PERIOD_NOT_COVERED', 'EXPLOITATION_AMBIGUOUS', 'OVERLAPPING_SERIES'
])

// A source identifier identifies the point, independently of an exploitation's
// period. It does not create or extend an exploitation or its permissions.
export async function resolveNativePointAssociation(client, {point, declarantUserId, minDate, maxDate, seriesKey}) {
  if (!point) return {pointId: null, exploitation: null, issues: [
    {code: 'UNMATCHED_POINT', severity: 'warning', seriesKey, message: 'Identifiant du point introuvable'}
  ]}
  const candidates = await client.declarantPointPrelevement.findMany({where: {pointPrelevementId: point.id, declarantUserId}})
  const covering = candidates.filter(candidate => (!candidate.startDate || +candidate.startDate <= +minDate)
    && (!candidate.endDate || +candidate.endDate >= +maxDate))
  const exploitation = covering.length === 1 ? covering[0] : null
  const code = covering.length > 1 ? 'EXPLOITATION_AMBIGUOUS' : candidates.length ? 'EXPLOITATION_PERIOD_NOT_COVERED' : 'EXPLOITATION_NOT_FOUND'
  const messages = {
    EXPLOITATION_AMBIGUOUS: 'Point identifié ; plusieurs exploitations couvrent cette période',
    EXPLOITATION_PERIOD_NOT_COVERED: 'Point identifié ; aucune exploitation ne couvre toute la période déclarée',
    EXPLOITATION_NOT_FOUND: 'Point identifié ; aucune exploitation enregistrée pour ce préleveur'
  }
  return {pointId: point.id, exploitation, issues: exploitation ? [] : [{code, severity: 'warning', seriesKey, message: messages[code]}]}
}

export function canRepairNativePointAssociation(chunk) {
  const preservedDecision = [chunk.metadata?.superseded, chunk.pointPrelevementId, chunk.exploitationId,
    chunk.instructedAt, chunk.instructedByInstructorUserId, chunk.instructionComment,
    chunk.parsingInfo?.detachedAt, chunk.parsingInfo?.changedByUserId, chunk.parsingInfo?.reconciledAt,
    chunk.parsingInfo?.pointAssociationOrigin].some(Boolean)
  return chunk.metadata?.nativeTemporal === true && !preservedDecision && chunk.instructionStatus === 'PENDING'
    && typeof chunk.metadata?.sourcePointReference === 'string'
    && chunk.parsingInfo?.issues?.some(issue => issue.code === 'UNMATCHED_POINT')
}

// Only the unresolved automatic association is repaired. Measures, revision
// hashes, manual decisions and rejected series are never rewritten on replay.
export async function planNativePointAssociationRepair(client, {chunk, point, declarantUserId, values, additionalChunkIds = []}) {
  if (!canRepairNativePointAssociation(chunk) || !point || point.deletedAt
    || point.sourceId !== chunk.metadata.sourcePointReference || chunk.preleveurUserId !== declarantUserId) return null
  const association = await resolveNativePointAssociation(client, {point, declarantUserId,
    minDate: chunk.minDate, maxDate: chunk.maxDate, seriesKey: chunk.seriesKey})
  const conflict = await nativeConflicts(client, {pointPrelevementId: point.id, preleveurUserId: declarantUserId,
    metadata: chunk.metadata, values, excludeChunkId: chunk.id, sourceId: chunk.sourceId, additionalChunkIds})
  const issues = [...association.issues]
  if (conflict) issues.push({code: 'OVERLAPPING_SERIES', severity: 'error', seriesKey: chunk.seriesKey,
    message: 'Une série existante couvre déjà cette période : nouvelle série écartée'})
  const diagnostics = replaceAssociationIssues({parsingErrors: chunk.parsingInfo?.issues,
    parsingErrorCounts: chunk.parsingInfo?.issueCounts}, issues)
  return {pointPrelevementId: point.id, exploitationId: association.exploitation?.id ?? null, flowType: point.flowType,
    ...(association.exploitation ? {usageId: association.exploitation.usageId} : {}),
    instructionStatus: conflict ? 'REJECTED' : association.exploitation ? 'VALIDATED' : 'PENDING',
    parsingInfo: {...chunk.parsingInfo, issues: diagnostics.parsingErrors, issueCounts: diagnostics.parsingErrorCounts,
      issuesSampled: diagnostics.parsingErrorsSampled, pointAssociationOrigin: 'AUTOMATIC'}}
}

function replaceAssociationIssues(metadata, issues) {
  // Keep all parser counts (including unsampled errors); replace only the
  // association diagnostics, which can be rebuilt from current chunks.
  const before = mergeNativeDiagnostics(metadata, [])
  const removed = Object.entries(before.parsingErrorCounts.byCode).filter(([code]) => NATIVE_ASSOCIATION_ISSUE_CODES.has(code))
  const counts = {...before.parsingErrorCounts, byCode: {...before.parsingErrorCounts.byCode}, bySeverity: {...before.parsingErrorCounts.bySeverity}}
  for (const [code, count] of removed) {
    delete counts.byCode[code]
    counts.total -= count
    const severity = code === 'OVERLAPPING_SERIES' ? 'error' : 'warning'
    counts.bySeverity[severity] = Math.max(0, (counts.bySeverity[severity] ?? 0) - count)
    if (!counts.bySeverity[severity]) delete counts.bySeverity[severity]
  }
  return mergeNativeDiagnostics({parsingErrors: before.parsingErrors.filter(issue => !NATIVE_ASSOCIATION_ISSUE_CODES.has(issue.code)), parsingErrorCounts: counts}, issues)
}

export function refreshNativeAssociationDiagnostics(metadata, chunks) {
  return replaceAssociationIssues(metadata,
    chunks.filter(chunk => !chunk.metadata?.superseded).flatMap(chunk => (chunk.parsingInfo?.issues ?? []).filter(issue => NATIVE_ASSOCIATION_ISSUE_CODES.has(issue.code))))
}
