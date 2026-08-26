import createHttpError from 'http-errors'
import Joi from 'joi'

import {
  buildDeclarationNotificationEmailPreview,
  clearUpcomingDeclarationNotificationPreviewsCache,
  computeDeclarationNotificationRecipients,
  getDeclarationNotificationRun,
  listDeclarationNotificationRuns,
  listUpcomingDeclarationNotificationPreviews,
  sendDeclarationNotificationNow,
  sendDeclarationNotificationRun
} from '../services/declaration-notifications.js'
import {
  listDeclarationNotificationSettings,
  updateDeclarationNotificationSetting
} from '../services/declaration-notification-settings.js'
import {withRequestPerformancePhase} from '../util/request-performance.js'

const uuidSchema = Joi.string().guid({version: 'uuidv4'}).required()
const previewQuerySchema = Joi.object({
  notificationType: Joi.string().valid('reminder', 'followup').required(),
  periodType: Joi.string().valid('month', 'week').required(),
  periodKey: Joi.string().required(),
  zoneId: Joi.string().guid({version: 'uuidv4'}).allow('', null),
  scheduledFor: Joi.date().iso()
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
const settingParamsSchema = Joi.object({
  notificationType: Joi.string().valid('reminder', 'followup').required(),
  periodType: Joi.string().valid('month', 'week').required()
})
const settingBodySchema = Joi.object({
  enabled: Joi.boolean().required()
})
const emailPreviewBodySchema = Joi.alternatives().try(
  Joi.object({
    notificationType: Joi.string().valid('reminder', 'followup').required(),
    periodType: Joi.string().valid('month', 'week').required(),
    periodKey: Joi.string().required(),
    email: Joi.string().email().required(),
    scheduledFor: Joi.date().iso()
  }),
  Joi.object({
    runId: Joi.string().guid({version: 'uuidv4'}).required(),
    recipientId: Joi.string().guid({version: 'uuidv4'}).required()
  })
)

function validateRunId(value) {
  const {error, value: uuid} = uuidSchema.validate(value)

  if (error) {
    throw createHttpError(400, 'Identifiant d’envoi invalide.')
  }

  return uuid
}

export async function listUpcomingDeclarationNotificationsHandler(_req, res) {
  const upcoming = await withRequestPerformancePhase(
    'notification_upcoming',
    () => listUpcomingDeclarationNotificationPreviews()
  )

  res.send({data: upcoming})
}

export async function listDeclarationNotificationSettingsHandler(_req, res) {
  const settings = await listDeclarationNotificationSettings()

  res.send({data: settings})
}

export async function updateDeclarationNotificationSettingHandler(req, res) {
  const params = settingParamsSchema.validate(req.params, {abortEarly: false})
  const body = settingBodySchema.validate(req.body, {abortEarly: false})

  if (params.error || body.error) {
    throw createHttpError(400, 'Paramètres d’activation invalides.')
  }

  const setting = await updateDeclarationNotificationSetting({
    notificationType: params.value.notificationType,
    periodType: params.value.periodType,
    enabled: body.value.enabled
  })
  clearUpcomingDeclarationNotificationPreviewsCache()

  res.send({data: setting})
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
    zoneId: value.zoneId || null,
    scheduledFor: value.scheduledFor || new Date()
  })

  res.send({data: preview})
}

export async function previewDeclarationNotificationEmailHandler(req, res) {
  const {error, value} = emailPreviewBodySchema.validate(req.body, {abortEarly: false})

  if (error) {
    throw createHttpError(400, 'Paramètres de l’aperçu du mail invalides.')
  }

  const preview = await buildDeclarationNotificationEmailPreview(value)

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
