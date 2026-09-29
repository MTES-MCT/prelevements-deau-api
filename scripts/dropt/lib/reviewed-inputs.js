import {clean, digest, SCOPE} from './epidropt.js'

const fail = code => { throw new Error(code) }

// Corrections are an explicit, private ledger. Original workbooks are never
// rewritten and a changed source row must be reviewed again, not silently used.
export function applyReviewedInputs(epidropt, review) {
  if (!review) return {epidropt, decisions: []}
  if (review.version !== 1 || !Array.isArray(review.corrections) || !Array.isArray(review.additions ?? [])) fail('REVIEWED_INPUT_FORMAT_INVALID')
  const result = structuredClone(epidropt)
  const decisions = []
  const seen = new Set()
  for (const correction of review.corrections) {
    const {sheet, row, expectedHash, values = {}, fields = {}, evidence} = correction
    if (!['Points prélèvement', 'Exploitations', 'Préleveurs'].includes(sheet)
      || !evidence?.file || !evidence?.cell || !evidence?.decision || !/^[a-f\d]{64}$/.test(expectedHash)) fail('REVIEWED_INPUT_PROOF_REQUIRED')
    const key = `${sheet}:${row}`
    if (seen.has(key)) fail('REVIEWED_INPUT_ROW_REPEATED')
    seen.add(key)
    const matches = result[sheet].filter(item => item.row === row)
    if (matches.length !== 1 || digest(matches[0]) !== expectedHash) fail('REVIEWED_INPUT_SOURCE_CHANGED')
    const target = matches[0]
    const allowedColumns = sheet === 'Points prélèvement' ? [24] : sheet === 'Exploitations' ? [2] : []
    if (Object.keys(values).some(column => !allowedColumns.includes(Number(column)))
      || Object.keys(fields).some(field => !['countingCode', 'declarantName'].includes(field))) fail('REVIEWED_INPUT_FIELD_FORBIDDEN')
    for (const [column, value] of Object.entries(values)) target.values[Number(column)] = value
    Object.assign(target, fields)
    decisions.push({sheet, row, beforeHash: expectedHash, afterHash: digest(target), evidence})
  }
  for (const addition of review.additions ?? []) {
    const {sheet, record, evidence} = addition
    if (sheet !== 'Préleveurs' || !Array.isArray(record?.values) || !clean(record.values[4])
      || !/^\d{14}$/.test(clean(record.values[3])) || !evidence?.file || !evidence?.cell || !evidence?.decision) fail('REVIEWED_INPUT_ADDITION_INVALID')
    if (result[sheet].some(item => item.row === record.row || clean(item.values[3]) === clean(record.values[3]))) fail('REVIEWED_INPUT_ADDITION_ALREADY_PRESENT')
    result[sheet].push(structuredClone(record))
    decisions.push({sheet, row: record.row, afterHash: digest(record), evidence, action: 'ADD_REVIEWED_IDENTITY'})
  }
  return {epidropt: result, decisions}
}

// The prepare step may project explicitly reviewed fusions, but the actual
// application still checks all database dependencies before making any change.
export function projectReviewedIdentities(snapshot, plan) {
  if (!plan) return snapshot
  if (!snapshot?.tables || plan.scope !== SCOPE || !Array.isArray(plan.merges)) fail('REVIEWED_IDENTITIES_SNAPSHOT_REQUIRED')
  const result = structuredClone(snapshot)
  const references = result.tables.externalReferences ??= []
  for (const merge of plan.merges) {
    const target = result.tables.points.find(point => point.id === merge.targetPointId)
    const source = result.tables.points.find(point => point.id === merge.sourcePointId)
    if (!target || target.deletedAt || !source || source.id === target.id) fail('REVIEWED_IDENTITIES_TARGET_INVALID')
    const previous = references.filter(ref => ref.provider === 'pe-import-alias' && ref.scope === SCOPE && ref.kind === 'POINT' && ref.externalId === source.id)
    if (previous.length > 1 || previous.some(ref => ref.pointPrelevementId !== target.id)) fail('REVIEWED_IDENTITIES_ALIAS_CONFLICT')
    if (!previous.length) references.push({provider: 'pe-import-alias', scope: SCOPE, kind: 'POINT', externalId: source.id,
      pointPrelevementId: target.id, metadata: {projectedPlanHash: digest(plan), exploitationAliases: (merge.exploitationMerges ?? []).map(pair => ({...pair,
        sourceSourceId: result.tables.exploitations.find(item => item.id === pair.sourceId)?.sourceId ?? null}))}})
  }
  const retired = new Set([...(plan.retireExploitationIds ?? []),
    ...plan.merges.flatMap(merge => (merge.exploitationMerges ?? []).map(pair => pair.sourceId))])
  result.tables.exploitations = result.tables.exploitations.filter(item => !retired.has(item.id))
  return result
}
