import {
  getAuditEventFilterOptions,
  listAuditEvents
} from '../services/audit-events.js'

export async function listAuditEventsHandler(request, response) {
  const result = await listAuditEvents(request.query, {
    excludeId: request.auditEventId
  })

  response.status(200).send({
    success: true,
    data: result
  })
}

export function getAuditEventFilterOptionsHandler(request, response) {
  response.status(200).send({
    success: true,
    data: getAuditEventFilterOptions()
  })
}
