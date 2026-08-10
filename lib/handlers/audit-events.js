import {
  getAuditEventDetail,
  getAuditEventFilterOptions,
  listResourceAuditHistory,
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

export async function getAuditEventDetailHandler(request, response) {
  response.status(200).send({
    success: true,
    data: await getAuditEventDetail(request.params.eventId)
  })
}

export async function listResourceAuditHistoryHandler(request, response) {
  response.status(200).send({
    success: true,
    data: await listResourceAuditHistory({
      query: request.query,
      resourceId: request.params.resourceId,
      resourceType: request.params.resourceType,
      user: request.user
    })
  })
}
