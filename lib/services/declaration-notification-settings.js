import createHttpError from 'http-errors'

import {prisma} from '../../db/prisma.js'

export const DECLARATION_NOTIFICATION_DEFINITIONS = Object.freeze([
  {notificationType: 'reminder', periodType: 'week'},
  {notificationType: 'followup', periodType: 'week'},
  {notificationType: 'reminder', periodType: 'month'},
  {notificationType: 'followup', periodType: 'month'}
])

const NOTIFICATION_TYPES = new Set(['reminder', 'followup'])
const PERIOD_TYPES = new Set(['week', 'month'])

function normalizeDefinition(notificationType, periodType) {
  const normalizedNotificationType = String(notificationType || '').toLowerCase()
  const normalizedPeriodType = String(periodType || '').toLowerCase()

  if (!NOTIFICATION_TYPES.has(normalizedNotificationType) || !PERIOD_TYPES.has(normalizedPeriodType)) {
    throw createHttpError(400, 'Type de notification invalide.')
  }

  return {
    notificationType: normalizedNotificationType,
    periodType: normalizedPeriodType,
    dbNotificationType: normalizedNotificationType.toUpperCase(),
    dbPeriodType: normalizedPeriodType.toUpperCase()
  }
}

function serializeSetting(setting, definition) {
  return {
    notificationType: definition.notificationType,
    periodType: definition.periodType,
    enabled: setting?.enabled ?? true,
    updatedAt: setting?.updatedAt ?? null
  }
}

export function getDeclarationNotificationSettingLabel(notificationType, periodType) {
  const definition = normalizeDefinition(notificationType, periodType)
  const notificationLabel = definition.notificationType === 'followup' ? 'relances' : 'rappels'
  const periodLabel = definition.periodType === 'week'
    ? 'hebdomadaires'
    : (definition.notificationType === 'followup' ? 'mensuelles' : 'mensuels')

  return `${notificationLabel} ${periodLabel}`
}

export async function listDeclarationNotificationSettings({client = prisma} = {}) {
  const rows = await client.declarationNotificationSetting.findMany()
  const rowsByKey = new Map(rows.map(row => [
    `${row.notificationType}:${row.periodType}`,
    row
  ]))

  return DECLARATION_NOTIFICATION_DEFINITIONS.map(definition => serializeSetting(
    rowsByKey.get(`${definition.notificationType.toUpperCase()}:${definition.periodType.toUpperCase()}`),
    definition
  ))
}

export async function isDeclarationNotificationEnabled({notificationType, periodType, client = prisma}) {
  const definition = normalizeDefinition(notificationType, periodType)
  const setting = await client.declarationNotificationSetting.findUnique({
    where: {
      notificationType_periodType: {
        notificationType: definition.dbNotificationType,
        periodType: definition.dbPeriodType
      }
    }
  })

  return setting?.enabled ?? true
}

export async function updateDeclarationNotificationSetting({
  notificationType,
  periodType,
  enabled,
  client = prisma
}) {
  const definition = normalizeDefinition(notificationType, periodType)
  const setting = await client.declarationNotificationSetting.upsert({
    where: {
      notificationType_periodType: {
        notificationType: definition.dbNotificationType,
        periodType: definition.dbPeriodType
      }
    },
    create: {
      notificationType: definition.dbNotificationType,
      periodType: definition.dbPeriodType,
      enabled
    },
    update: {enabled}
  })

  return serializeSetting(setting, definition)
}
