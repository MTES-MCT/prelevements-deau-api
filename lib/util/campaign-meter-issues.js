import createError from 'http-errors'

export function campaignMeterEventIssue(event, code, message, extra = {}) {
  return {code, severity: 'ERROR', targetId: event.targetId, compteurId: event.previousCompteurId, at: event.at, field: 'at', message, ...extra}
}

export function campaignMeterEventError(issues) {
  return createError(400, issues[0].message, {data: {issues}})
}
