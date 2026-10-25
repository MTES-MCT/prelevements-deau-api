// Complete source files and parsed migration parts remain available in private storage.
// Keep database/API diagnostics bounded, including when a dossier has hundreds of thousands of bad cells.
export function summarizeNativeIssues(issues = [], limit = 100) {
  const byCode = new Map(), bySeverity = new Map(), representatives = new Map()
  for (const issue of issues) {
    const code = String(issue?.code ?? 'UNKNOWN'), severity = String(issue?.severity ?? 'error')
    byCode.set(code, (byCode.get(code) ?? 0) + 1)
    bySeverity.set(severity, (bySeverity.get(severity) ?? 0) + 1)
    if (!representatives.has(code)) representatives.set(code, issue)
  }
  const sample = [...representatives.values()].slice(0, limit)
  const chosen = new Set(sample)
  for (const issue of issues) {
    if (sample.length >= limit) break
    if (!chosen.has(issue)) { sample.push(issue); chosen.add(issue) }
  }
  return {issues: sample, issueCounts: {total: issues.length, byCode: Object.fromEntries(byCode), bySeverity: Object.fromEntries(bySeverity)}, issuesSampled: issues.length > sample.length}
}

function mergeCounts(left = {}, right = {}) {
  const merged = new Map(Object.entries(left))
  for (const [key, value] of Object.entries(right)) merged.set(key, (merged.get(key) ?? 0) + value)
  return Object.fromEntries(merged)
}

export function mergeNativeDiagnostics(previous, currentIssues) {
  const before = previous?.parsingErrorCounts ? {
    issues: previous.parsingErrors ?? [], issueCounts: previous.parsingErrorCounts
  } : summarizeNativeIssues(previous?.parsingErrors ?? [])
  const current = summarizeNativeIssues(currentIssues)
  const counts = {total: before.issueCounts.total + current.issueCounts.total,
    byCode: mergeCounts(before.issueCounts.byCode, current.issueCounts.byCode),
    bySeverity: mergeCounts(before.issueCounts.bySeverity, current.issueCounts.bySeverity)}
  const {issues} = summarizeNativeIssues([...before.issues, ...current.issues])
  return {parsingErrors: issues, parsingErrorCounts: counts,
    parsingErrorsSampled: counts.total > issues.length, hasAnomalies: counts.total > 0}
}
