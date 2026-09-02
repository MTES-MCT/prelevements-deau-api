import createHttpError from 'http-errors'

import {
  setAuditSubject,
  setAuditTarget
} from '../audit/context.js'
import {stageAuditMutation} from '../audit/mutations.js'
import {sendAccountCreationNotification} from '../services/account-notifications.js'
import {
  deactivateAdminAgent,
  replaceAdminAgentEmail,
  restoreAdminAgent,
  updateAdminAgentProfile
} from '../services/admin-agent-account.js'
import {sendAdminAgentAccountNotification} from '../services/admin-agent-notifications.js'
import {
  createAdminAgent,
  getAdminAgent,
  listAdminAgents
} from '../services/admin-agents.js'

function getAgentLabel(agent) {
  return [agent?.firstName, agent?.lastName].filter(Boolean).join(' ').trim()
    || agent?.email
    || agent?.id
    || null
}

function setAgentAuditContext(request, agent) {
  if (!agent) {
    return
  }

  setAuditSubject(request, agent)
  setAuditTarget(request, {
    id: agent.id,
    label: getAgentLabel(agent),
    type: 'USER'
  })
}

function stageAgentMutation(request, operation, before, after) {
  const agent = after ?? before

  stageAuditMutation(request, {
    operation,
    entityType: 'AGENT_ACCOUNT',
    entityId: agent?.id,
    entityLabel: getAgentLabel(agent),
    before,
    after
  })
}

function stageInitialHabilitationMutation(request, agent, zoneId) {
  const normalizedZoneId = String(zoneId).toLowerCase()
  const habilitation = agent?.habilitations?.find(item =>
    String(item.zoneId).toLowerCase() === normalizedZoneId)

  if (!habilitation) {
    return
  }

  stageAuditMutation(request, {
    operation: 'CREATE',
    entityType: 'ZONE_AGENT_ASSIGNMENT',
    entityId: `${habilitation.zoneId}:${agent.id}`,
    entityLabel: getAgentLabel(agent),
    after: {
      zoneId: habilitation.zoneId,
      instructorUserId: agent.id,
      isAdmin: habilitation.isAdmin,
      startDate: habilitation.startDate,
      endDate: habilitation.endDate,
      permissions: habilitation.permissions
    }
  })
}

function withWarnings(agent, result) {
  const warnings = result?.warnings ?? []
  return warnings.length > 0 ? {...agent, warnings} : agent
}

export async function listAdminAgentsHandler(req, res) {
  res.status(200).send(await listAdminAgents(req.query))
}

export async function createAdminAgentHandler(req, res) {
  const agent = await createAdminAgent(req.body)

  setAgentAuditContext(req, agent)
  stageAgentMutation(req, 'CREATE', null, agent)
  stageInitialHabilitationMutation(req, agent, req.body.zoneId)
  res.status(201).send(agent)
}

export async function getAdminAgentHandler(req, res) {
  const agent = await getAdminAgent(req.params.agentId)

  setAgentAuditContext(req, agent)
  res.status(200).send(agent)
}

export async function updateAdminAgentProfileHandler(req, res) {
  const before = await getAdminAgent(req.params.agentId)
  const result = await updateAdminAgentProfile(req.params.agentId, req.body)
  const after = await getAdminAgent(req.params.agentId)

  setAgentAuditContext(req, after)
  stageAgentMutation(req, 'UPDATE', before, after)
  res.status(200).send(withWarnings(after, result))
}

export async function replaceAdminAgentEmailHandler(req, res) {
  const before = await getAdminAgent(req.params.agentId)
  const result = await replaceAdminAgentEmail(req.params.agentId, req.body, {
    notify: sendAdminAgentAccountNotification
  })
  const after = await getAdminAgent(req.params.agentId)

  setAgentAuditContext(req, after)
  stageAgentMutation(req, 'UPDATE', before, after)
  res.status(200).send(withWarnings(after, result))
}

export async function deactivateAdminAgentHandler(req, res) {
  const before = await getAdminAgent(req.params.agentId)
  const result = await deactivateAdminAgent(req.params.agentId, req.body, {
    notify: sendAdminAgentAccountNotification
  })
  const after = await getAdminAgent(req.params.agentId)

  setAgentAuditContext(req, after)
  stageAgentMutation(req, 'UPDATE', before, after)
  res.status(200).send(withWarnings(after, result))
}

export async function restoreAdminAgentHandler(req, res) {
  const before = await getAdminAgent(req.params.agentId)
  const result = await restoreAdminAgent(req.params.agentId, req.body, {
    notify: sendAdminAgentAccountNotification
  })
  const after = await getAdminAgent(req.params.agentId)

  setAgentAuditContext(req, after)
  stageAgentMutation(req, 'UPDATE', before, after)
  res.status(200).send(withWarnings(after, result))
}

export async function sendAdminAgentAccountCreationNotificationHandler(req, res) {
  const before = await getAdminAgent(req.params.agentId)

  if (before.accountStatus !== 'ACTIVE') {
    const error = createHttpError(409, 'Impossible d’envoyer une invitation à un agent désactivé.')
    error.data = {code: 'AGENT_DISABLED'}
    throw error
  }

  await sendAccountCreationNotification(before, {role: 'INSTRUCTOR'})
  const after = await getAdminAgent(req.params.agentId)

  setAgentAuditContext(req, after)
  res.status(200).send(after)
}
