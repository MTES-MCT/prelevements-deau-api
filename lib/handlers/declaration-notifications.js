import createHttpError from 'http-errors'
import Joi from 'joi'

import {
  computeDeclarationNotificationRecipients,
  getDeclarationNotificationRun,
  listDeclarationNotificationRuns,
  listUpcomingDeclarationNotificationPreviews,
  sendDeclarationNotificationNow,
  sendDeclarationNotificationRun
} from '../services/declaration-notifications.js'

const uuidSchema = Joi.string().guid({version: 'uuidv4'}).required()
const previewQuerySchema = Joi.object({
  notificationType: Joi.string().valid('reminder', 'followup').required(),
  periodType: Joi.string().valid('month', 'week').required(),
  periodKey: Joi.string().required(),
  zoneId: Joi.string().guid({version: 'uuidv4'}).allow('', null)
})
const sendNowBodySchema = Joi.object({
  notificationType: Joi.string().valid('reminder', 'followup').required(),
  periodType: Joi.string().valid('month', 'week').required(),
  periodKey: Joi.string().required(),
  scheduledFor: Joi.date().iso()
})
const runsQuerySchema = Joi.object({
  status: Joi.string().valid('SCHEDULED', 'SENDING', 'SENT', 'PARTIAL_FAILURE', 'FAILED', 'BLOCKED').allow('', null),
  limit: Joi.number().integer().min(1).max(200).default(50)
})

function validateRunId(value) {
  const {error, value: uuid} = uuidSchema.validate(value)

  if (error) {
    throw createHttpError(400, 'Identifiant d’envoi invalide.')
  }

  return uuid
}

export async function listUpcomingDeclarationNotificationsHandler(_req, res) {
  const upcoming = await listUpcomingDeclarationNotificationPreviews()

  res.send({data: upcoming})
}

export async function previewDeclarationNotificationHandler(req, res) {
  const {error, value} = previewQuerySchema.validate(req.query, {abortEarly: false})

  if (error) {
    throw createHttpError(400, 'Paramètres de prévisualisation invalides.')
  }

  const preview = await computeDeclarationNotificationRecipients({
    notificationType: value.notificationType,
    periodType: value.periodType,
    periodKey: value.periodKey,
    zoneId: value.zoneId || null
  })

  res.send({data: preview})
}

export async function listDeclarationNotificationRunsHandler(req, res) {
  const {error, value} = runsQuerySchema.validate(req.query, {abortEarly: false})

  if (error) {
    throw createHttpError(400, 'Paramètres invalides.')
  }

  const runs = await listDeclarationNotificationRuns({
    status: value.status || null,
    limit: value.limit
  })

  res.send({data: runs})
}

export async function sendDeclarationNotificationNowHandler(req, res) {
  const {error, value} = sendNowBodySchema.validate(req.body, {abortEarly: false})

  if (error) {
    throw createHttpError(400, 'Paramètres d’envoi invalides.')
  }

  const run = await sendDeclarationNotificationNow({
    notificationType: value.notificationType,
    periodType: value.periodType,
    periodKey: value.periodKey,
    scheduledFor: value.scheduledFor || new Date()
  })
  const detailedRun = await getDeclarationNotificationRun(run.id)

  res.send({data: detailedRun})
}

export async function getDeclarationNotificationRunHandler(req, res) {
  const runId = validateRunId(req.params.runId)
  const run = await getDeclarationNotificationRun(runId)

  res.send({data: run})
}

export async function retryDeclarationNotificationFailuresHandler(req, res) {
  const runId = validateRunId(req.params.runId)
  const run = await sendDeclarationNotificationRun(runId, {onlyFailures: true})

  res.send({data: run})
}
