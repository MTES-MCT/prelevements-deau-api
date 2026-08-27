import process from 'node:process'

import createHttpError from 'http-errors'
import ExcelJS from 'exceljs'

import {prisma} from '../../db/prisma.js'
import {createAsyncTtlCache} from '../util/async-ttl-cache.js'
import {buildBrevoTemplatePreview} from './brevo-template-preview.js'
import {getExploitationSecondaryUsages} from './exploitation-usages.js'
import {
  DECLARATION_NOTIFICATION_DEFINITIONS,
  getDeclarationNotificationSettingLabel,
  isDeclarationNotificationEnabled,
  listDeclarationNotificationSettings
} from './declaration-notification-settings.js'
import {normalizeEmail} from '../util/email.js'
import {
  getEffectiveDeclarantContactEmails,
  getPrimaryDeclarantContactEmail
} from './declarant-contact-emails.js'
import {
  getDeclarationPeriodEnd,
  getDeclarationPeriodKey,
  getDeclarationPeriodLabel,
  getDeclarationPeriodStart,
  getPreviousDeclarationPeriodKey,
  parseDeclarationPeriodKey,
  parseDeclarationPeriodType
} from '../util/declaration-periods.js'

export const NOTIFICATION_TYPES = new Set(['reminder', 'followup'])
export const PERIOD_TYPES_BY_PRIORITY = new Map([
  ['month', 1],
  ['week', 2]
])

const PERIOD_TYPE_TO_DB = new Map([
  ['month', 'MONTH'],
  ['week', 'WEEK']
])

const PERIOD_TYPE_FROM_DB = new Map([
  ['MONTH', 'month'],
  ['WEEK', 'week']
])

const PERIOD_TYPE_LABELS = new Map([
  ['month', 'mensuelle'],
  ['week', 'hebdomadaire']
])

const NOTIFICATION_TYPE_TO_DB = new Map([
  ['reminder', 'REMINDER'],
  ['followup', 'FOLLOWUP']
])

const NOTIFICATION_TYPE_FROM_DB = new Map([
  ['REMINDER', 'reminder'],
  ['FOLLOWUP', 'followup']
])

const RUN_STATUS_LABELS = new Map([
  ['SCHEDULED', 'Programmé'],
  ['SENDING', 'En cours'],
  ['SENT', 'Envoyé'],
  ['PARTIAL_FAILURE', 'Partiellement échoué'],
  ['FAILED', 'Échoué'],
  ['BLOCKED', 'Bloqué']
])

const RECIPIENT_STATUS_LABELS = new Map([
  ['PENDING', 'En attente'],
  ['SENT', 'Envoyé'],
  ['FAILED', 'Échoué'],
  ['SKIPPED', 'Ignoré']
])

const DEFAULT_APP_URL = 'https://app.partageonsleau.beta.gouv.fr'
const NOTIFICATION_TIME_ZONE = 'Europe/Paris'
const upcomingPreviewsCache = createAsyncTtlCache({ttlMs: 30_000})

function toDbPeriodType(periodType) {
  return PERIOD_TYPE_TO_DB.get(parseDeclarationPeriodType(periodType))
}

function fromDbPeriodType(periodType) {
  return PERIOD_TYPE_FROM_DB.get(periodType) ?? 'month'
}

function getPeriodTypeLabel(periodType) {
  return PERIOD_TYPE_LABELS.get(periodType) ?? 'non renseignée'
}

function toDbNotificationType(notificationType) {
  const normalized = String(notificationType || '').toLowerCase()

  if (!NOTIFICATION_TYPES.has(normalized)) {
    throw createHttpError(400, 'Type de notification invalide.')
  }

  return NOTIFICATION_TYPE_TO_DB.get(normalized)
}

function fromDbNotificationType(notificationType) {
  return NOTIFICATION_TYPE_FROM_DB.get(notificationType) ?? 'reminder'
}

function optionalText(value) {
  if (value === undefined || value === null) {
    return null
  }

  const trimmed = String(value).trim()
  return trimmed || null
}

function normalizeDateOnly(value) {
  if (!value) {
    return null
  }

  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    return null
  }

  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function overlapsRange({startDate, endDate}, periodStart, periodEnd) {
  const start = normalizeDateOnly(startDate)
  const end = normalizeDateOnly(endDate)

  if (start && start > periodEnd) {
    return false
  }

  if (end && end < periodStart) {
    return false
  }

  return true
}

function isExploitationExpected(exploitation, periodStart, periodEnd) {
  return exploitation.status !== 'ABANDONNEE'
    && exploitation.pointPrelevementId
    && overlapsRange(exploitation, periodStart, periodEnd)
}

function buildDisplayName({firstName, lastName, email, socialReason} = {}) {
  return [firstName, lastName].filter(Boolean).join(' ').trim()
    || socialReason
    || email
    || null
}

function buildRecipientTemplateName(recipient) {
  const fullName = [recipient.firstName, recipient.lastName]
    .map(value => optionalText(value))
    .filter(Boolean)
    .join(' ')

  return optionalText(recipient.sigle)
    || optionalText(recipient.socialReason)
    || optionalText(fullName)
    || optionalText(recipient.email)
    || ''
}

function buildDeclarantLabel(declarant) {
  return buildDisplayName({
    firstName: declarant?.user?.firstName,
    lastName: declarant?.user?.lastName,
    email: getPrimaryDeclarantContactEmail(declarant),
    socialReason: declarant?.socialReason
  })
}

function canReceiveDeclarationNotifications(declarant) {
  return declarant?.declarationNotificationsEnabled !== false
}

function getNotificationEmails(declarant) {
  const emails = getEffectiveDeclarantContactEmails(declarant)
  const invalidEmails = []

  const normalizedEmails = new Set()
  const invalidEmailKeys = new Set()

  for (const email of emails) {
    try {
      const normalizedEmail = normalizeEmail(email, {required: false})

      if (normalizedEmail) {
        normalizedEmails.add(normalizedEmail)
      }
    } catch (error) {
      const invalidEmail = optionalText(email)

      if (invalidEmail && !invalidEmailKeys.has(invalidEmail)) {
        invalidEmails.push({
          email: invalidEmail,
          error: error.message
        })
        invalidEmailKeys.add(invalidEmail)
      }
    }
  }

  return {
    emails: [...normalizedEmails],
    invalidEmails
  }
}

function getPointZones(exploitation, {zoneId = null} = {}) {
  const zones = (exploitation.pointPrelevement?.zones ?? [])
    .map(link => link.zone)
    .filter(Boolean)

  return zoneId ? zones.filter(zone => zone.id === zoneId) : zones
}

function getZonePeriodType(zone, periodStart, periodEnd) {
  const override = (zone.declarationOverrides ?? [])
    .find(item => overlapsRange(item, periodStart, periodEnd))

  return override
    ? fromDbPeriodType(override.periodType)
    : fromDbPeriodType(zone.declarationSettings?.defaultPeriodType ?? 'MONTH')
}

export function resolveMinimumPeriodType(periodTypes) {
  let selected = 'month'

  for (const periodType of periodTypes) {
    if ((PERIOD_TYPES_BY_PRIORITY.get(periodType) ?? 0) > (PERIOD_TYPES_BY_PRIORITY.get(selected) ?? 0)) {
      selected = periodType
    }
  }

  return selected
}

function getExploitationPeriodType(exploitation, periodStart, periodEnd, {zoneId = null} = {}) {
  const zones = getPointZones(exploitation, {zoneId})

  if (zones.length === 0) {
    return null
  }

  return resolveMinimumPeriodType(
    zones.map(zone => getZonePeriodType(zone, periodStart, periodEnd))
  )
}

function serializeZone(zone, periodStart, periodEnd) {
  return {
    id: zone.id,
    code: zone.code,
    type: zone.type,
    name: zone.name,
    periodType: getZonePeriodType(zone, periodStart, periodEnd)
  }
}

function serializePoint(exploitation) {
  const point = exploitation.pointPrelevement
  const serializeUsage = usage => usage
    ? {
      id: usage.id,
      code: usage.code,
      name: usage.label ?? usage.name
    }
    : null

  return {
    id: point?.id ?? exploitation.pointPrelevementId,
    name: point?.name ?? 'Point de prélèvement',
    resourceName: point?.resourceName ?? null,
    usage: serializeUsage(exploitation.usage),
    secondaryUsages: getExploitationSecondaryUsages(exploitation)
      .map(serializeUsage)
      .filter(Boolean)
  }
}

function recipientTemplateParams({
  recipient,
  zones,
  points,
  periodType,
  periodKey,
  deadlineLabel
}) {
  const periodLabel = getDeclarationPeriodLabel(periodType, periodKey)
  const templatePeriodLabel = periodType === 'week'
    ? periodLabel.replace(/^Du\s+/, '')
    : periodLabel

  return {
    NOM: buildRecipientTemplateName(recipient),
    PERIODE: templatePeriodLabel,
    PAS_DE_TEMPS: periodType === 'week' ? 'hebdomadaire' : 'mensuel',
    DATE_LIMITE: deadlineLabel,
    LIEN_DECLARATION: process.env.FRONT_URL || process.env.APP_URL || DEFAULT_APP_URL,
    ZONES: zones.map(zone => zone.name).join(', '),
    POINTS: points.map(point => point.name).join(', ')
  }
}

function buildDeadlineLabel(notificationType, periodType, scheduledFor) {
  if (notificationType === 'followup') {
    return 'échéance dépassée'
  }

  if (periodType === 'week') {
    return '14 h aujourd’hui'
  }

  return scheduledFor.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  })
}

async function getDeclaredPointIds({pointIds, periodStart, periodEnd, client = prisma}) {
  if (pointIds.length === 0) {
    return new Set()
  }

  const chunks = await client.chunk.findMany({
    where: {
      pointPrelevementId: {in: pointIds},
      minDate: {lte: periodEnd},
      maxDate: {gte: periodStart},
      source: {
        type: 'DECLARATION'
      }
    },
    select: {
      pointPrelevementId: true
    }
  })

  return new Set(chunks
    .map(chunk => chunk.pointPrelevementId)
    .filter(Boolean))
}

async function getExpectedExploitations({periodStart, periodEnd, zoneId = null, client = prisma}) {
  return client.declarantPointPrelevement.findMany({
    where: {
      OR: [
        {startDate: null},
        {startDate: {lte: periodEnd}}
      ],
      AND: [
        {
          OR: [
            {endDate: null},
            {endDate: {gte: periodStart}}
          ]
        }
      ],
      declarant: {
        user: {deletedAt: null}
      },
      ...(zoneId
        ? {
          pointPrelevement: {
            zones: {
              some: {zoneId}
            }
          }
        }
        : {})
    },
    include: {
      connectors: true,
      usage: true,
      secondaryUsageLinks: {
        include: {usage: true},
        orderBy: {usageId: 'asc'}
      },
      declarant: {
        include: {
          contactEmails: true,
          user: {
            select: {
              email: true,
              firstName: true,
              lastName: true
            }
          }
        }
      },
      collecteurs: {
        where: {
          collecteur: {
            user: {deletedAt: null}
          }
        },
        include: {
          collecteur: {
            include: {
              contactEmails: true,
              user: {
                select: {
                  email: true,
                  firstName: true,
                  lastName: true
                }
              }
            }
          }
        }
      },
      pointPrelevement: {
        include: {
          zones: {
            include: {
              zone: {
                include: {
                  declarationSettings: true,
                  declarationOverrides: true
                }
              }
            }
          }
        }
      }
    }
  })
}

function addRecipient(recipientsByEmail, recipient, context) {
  const contactEmails = getNotificationEmails(recipient.declarant)

  for (const email of contactEmails.emails) {
    const current = recipientsByEmail.get(email) ?? {
      email,
      declarantUserId: recipient.declarantUserId,
      recipientRole: recipient.role,
      firstName: optionalText(recipient.user?.firstName),
      lastName: optionalText(recipient.user?.lastName),
      sigle: optionalText(recipient.sigle),
      socialReason: optionalText(recipient.socialReason),
      phoneNumber: optionalText(recipient.phoneNumber),
      zones: new Map(),
      points: new Map(),
      inclusionReason: context.inclusionReason
    }

    for (const zone of context.zones) {
      current.zones.set(zone.id, zone)
    }

    for (const point of context.points) {
      current.points.set(point.id, point)
    }

    recipientsByEmail.set(email, current)
  }

  return contactEmails.invalidEmails
}

function getExclusionReasonContent(reason, details = {}) {
  if (reason === 'PERIOD_TYPE_MISMATCH') {
    const expectedPeriodTypeLabel = getPeriodTypeLabel(details.expectedPeriodType)

    return {
      reasonLabel: 'Pas de temps différent',
      reasonDescription: `Ce point attend une déclaration ${expectedPeriodTypeLabel}. Il sera traité dans l’envoi correspondant.`
    }
  }

  const content = {
    EXPLOITATION_INACTIVE: {
      reasonLabel: 'Exploitation inactive',
      reasonDescription: 'L’exploitation n’est pas active sur la période calculée.'
    },
    NO_ZONE: {
      reasonLabel: 'Pas de zone de déclaration',
      reasonDescription: 'Aucune zone active ne permet de déterminer le pas de temps attendu pour ce point.'
    },
    ALREADY_DECLARED: {
      reasonLabel: 'Déclaration déjà reçue',
      reasonDescription: 'Une déclaration existe déjà pour ce point sur la période. Il est donc exclu de la relance.'
    },
    DECLARANT_EXCLUDED: {
      reasonLabel: 'Déclarant exclu',
      reasonDescription: 'Ce déclarant est configuré pour ne pas recevoir les rappels ou relances de déclaration.'
    },
    INVALID_EMAIL: {
      reasonLabel: 'Email invalide',
      reasonDescription: details.invalidEmail
        ? `L’adresse ${details.invalidEmail} n’a pas un format exploitable. Elle est ignorée pour cet envoi.`
        : 'Une adresse email rattachée à ce déclarant n’a pas un format exploitable. Elle est ignorée pour cet envoi.'
    },
    NO_EMAIL: {
      reasonLabel: 'Aucun email exploitable',
      reasonDescription: 'Aucun email n’est disponible pour le préleveur ou ses collecteurs.'
    }
  }[reason]

  return content ?? {
    reasonLabel: reason,
    reasonDescription: 'Motif technique non documenté.'
  }
}

function addExclusion(exclusions, exploitation, reason, details = {}) {
  const {excludedDeclarant, ...metadata} = details
  const declarant = excludedDeclarant ?? exploitation.declarant

  exclusions.push({
    reason,
    ...getExclusionReasonContent(reason, metadata),
    declarantUserId: declarant?.userId ?? exploitation.declarantUserId,
    declarantLabel: buildDeclarantLabel(declarant),
    pointPrelevementId: exploitation.pointPrelevementId,
    pointName: exploitation.pointPrelevement?.name ?? null,
    ...metadata
  })
}

function addInvalidEmailExclusions(exclusions, exploitation, recipient, invalidEmails) {
  for (const invalidEmail of invalidEmails) {
    addExclusion(exclusions, exploitation, 'INVALID_EMAIL', {
      excludedDeclarant: recipient.declarant,
      recipientRole: recipient.role,
      invalidEmail: invalidEmail.email
    })
  }

  return invalidEmails.length
}

// eslint-disable-next-line complexity
export async function computeDeclarationNotificationRecipients({
  notificationType,
  periodType,
  periodKey,
  zoneId = null,
  scheduledFor = new Date(),
  client = prisma
}) {
  const normalizedNotificationType = String(notificationType || '').toLowerCase()
  const normalizedPeriodType = parseDeclarationPeriodType(periodType)
  const normalizedPeriodKey = parseDeclarationPeriodKey(periodKey, normalizedPeriodType)

  if (!NOTIFICATION_TYPES.has(normalizedNotificationType)) {
    throw createHttpError(400, 'Type de notification invalide.')
  }

  if (!normalizedPeriodKey) {
    throw createHttpError(400, 'Période invalide.')
  }

  const periodStart = getDeclarationPeriodStart(normalizedPeriodType, normalizedPeriodKey)
  const periodEnd = getDeclarationPeriodEnd(normalizedPeriodType, normalizedPeriodKey)
  const exploitations = await getExpectedExploitations({
    periodStart,
    periodEnd,
    zoneId,
    client
  })
  const pointIds = [...new Set(exploitations.map(exploitation => exploitation.pointPrelevementId).filter(Boolean))]
  const declaredPointIds = await getDeclaredPointIds({
    pointIds,
    periodStart,
    periodEnd,
    client
  })
  const recipientsByEmail = new Map()
  const exclusions = []
  const expectedRows = []

  for (const exploitation of exploitations) {
    if (!isExploitationExpected(exploitation, periodStart, periodEnd)) {
      addExclusion(exclusions, exploitation, 'EXPLOITATION_INACTIVE')
      continue
    }

    const exploitationPeriodType = getExploitationPeriodType(exploitation, periodStart, periodEnd, {zoneId})

    if (!exploitationPeriodType) {
      addExclusion(exclusions, exploitation, 'NO_ZONE')
      continue
    }

    if (exploitationPeriodType !== normalizedPeriodType) {
      addExclusion(exclusions, exploitation, 'PERIOD_TYPE_MISMATCH', {
        expectedPeriodType: exploitationPeriodType
      })
      continue
    }

    const hasDeclared = declaredPointIds.has(exploitation.pointPrelevementId)

    if (normalizedNotificationType === 'followup' && hasDeclared) {
      addExclusion(exclusions, exploitation, 'ALREADY_DECLARED')
      continue
    }

    const zones = getPointZones(exploitation, {zoneId})
      .map(zone => serializeZone(zone, periodStart, periodEnd))
    const point = serializePoint(exploitation)

    const expectedRow = {
      exploitationId: exploitation.id,
      declarantUserId: exploitation.declarantUserId,
      pointPrelevementId: exploitation.pointPrelevementId,
      hasDeclared,
      zones,
      point,
      invalidEmailCount: 0
    }

    expectedRows.push(expectedRow)

    const context = {
      zones,
      points: [point],
      inclusionReason: normalizedNotificationType === 'followup'
        ? 'Déclaration attendue non trouvée'
        : 'Déclaration attendue sur la période'
    }

    const {declarant} = exploitation

    if (declarant?.declarantRole === 'PRELEVEUR') {
      if (canReceiveDeclarationNotifications(declarant)) {
        const invalidEmails = addRecipient(recipientsByEmail, {
          declarantUserId: declarant.userId,
          role: 'PRELEVEUR',
          declarant,
          user: declarant.user,
          sigle: declarant.sigle,
          socialReason: declarant.socialReason,
          phoneNumber: declarant.phoneNumber
        }, context)

        expectedRow.invalidEmailCount += addInvalidEmailExclusions(exclusions, exploitation, {
          declarant,
          role: 'PRELEVEUR'
        }, invalidEmails)
      } else {
        addExclusion(exclusions, exploitation, 'DECLARANT_EXCLUDED', {
          excludedDeclarant: declarant,
          recipientRole: 'PRELEVEUR'
        })
      }
    }

    for (const {collecteur} of exploitation.collecteurs ?? []) {
      if (collecteur?.declarantRole === 'COLLECTEUR') {
        if (canReceiveDeclarationNotifications(collecteur)) {
          const invalidEmails = addRecipient(recipientsByEmail, {
            declarantUserId: collecteur.userId,
            role: 'COLLECTEUR',
            declarant: collecteur,
            user: collecteur.user,
            sigle: collecteur.sigle,
            socialReason: collecteur.socialReason,
            phoneNumber: collecteur.phoneNumber
          }, context)

          expectedRow.invalidEmailCount += addInvalidEmailExclusions(exclusions, exploitation, {
            declarant: collecteur,
            role: 'COLLECTEUR'
          }, invalidEmails)
        } else {
          addExclusion(exclusions, exploitation, 'DECLARANT_EXCLUDED', {
            excludedDeclarant: collecteur,
            recipientRole: 'COLLECTEUR'
          })
        }
      }
    }
  }

  const recipients = [...recipientsByEmail.values()].map(recipient => {
    const zones = [...recipient.zones.values()]
    const points = [...recipient.points.values()]
    const templateParams = recipientTemplateParams({
      recipient,
      zones,
      points,
      periodType: normalizedPeriodType,
      periodKey: normalizedPeriodKey,
      deadlineLabel: buildDeadlineLabel(normalizedNotificationType, normalizedPeriodType, scheduledFor)
    })

    return {
      ...recipient,
      zones,
      points,
      templateParams,
      name: buildDisplayName(recipient)
    }
  })

  for (const row of expectedRows) {
    const hasRecipient = recipients.some(recipient =>
      recipient.points.some(point => point.id === row.pointPrelevementId)
    )

    if (!hasRecipient && row.invalidEmailCount === 0) {
      exclusions.push({
        reason: 'NO_EMAIL',
        ...getExclusionReasonContent('NO_EMAIL'),
        declarantUserId: row.declarantUserId,
        pointPrelevementId: row.pointPrelevementId,
        pointName: row.point.name
      })
    }
  }

  return {
    notificationType: normalizedNotificationType,
    periodType: normalizedPeriodType,
    periodKey: normalizedPeriodKey,
    periodLabel: getDeclarationPeriodLabel(normalizedPeriodType, normalizedPeriodKey),
    periodStart,
    periodEnd,
    recipients: recipients.sort((a, b) => a.email.localeCompare(b.email, 'fr')),
    exclusions,
    summary: {
      expectedExploitations: expectedRows.length,
      recipients: recipients.length,
      exclusions: exclusions.length
    }
  }
}

function getBrevoTemplateId(notificationType, periodType) {
  const envKey = `BREVO_TEMPLATE_DECLARATION_${notificationType.toUpperCase()}_${periodType.toUpperCase()}`
  const value = process.env[envKey]
  const templateId = Number.parseInt(value || '', 10)

  return Number.isInteger(templateId) && templateId > 0 ? templateId : null
}

async function assertDeclarationNotificationEnabled({notificationType, periodType, client}) {
  const enabled = await isDeclarationNotificationEnabled({
    notificationType,
    periodType,
    client
  })

  if (!enabled) {
    const label = getDeclarationNotificationSettingLabel(notificationType, periodType)
    throw createHttpError(409, `Les ${label} sont désactivés.`)
  }
}

async function getRunGuardError({preview, dbNotificationType, dbPeriodType, client = prisma}) {
  const maxRecipients = Number.parseInt(process.env.DECLARATION_NOTIFICATION_MAX_RECIPIENTS || '5000', 10)

  if (preview.recipients.length > maxRecipients) {
    return `Volume de destinataires anormal (${preview.recipients.length}, maximum ${maxRecipients})`
  }

  if (preview.recipients.length > 0) {
    return null
  }

  const previousRun = await client.declarationNotificationRun.findFirst({
    where: {
      notificationType: dbNotificationType,
      periodType: dbPeriodType,
      recipientCount: {gt: 0}
    },
    orderBy: {scheduledFor: 'desc'},
    select: {
      id: true,
      recipientCount: true
    }
  })

  return previousRun
    ? `Aucun destinataire calculé alors que l’envoi comparable précédent contenait ${previousRun.recipientCount} destinataire(s)`
    : null
}

export function getNotificationPeriodKeyForDate(notificationType, periodType, date = new Date()) {
  if (periodType === 'week') {
    return getPreviousDeclarationPeriodKey('week', date)
  }

  return notificationType === 'followup'
    ? getPreviousDeclarationPeriodKey('month', date)
    : getDeclarationPeriodKey('month', date)
}

function getTimeZoneDateParts(date, timeZone = NOTIFICATION_TIME_ZONE) {
  const values = new Map(new Intl.DateTimeFormat('fr-FR', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).map(part => [part.type, part.value]))

  return {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
    hour: Number(values.get('hour')),
    minute: Number(values.get('minute')),
    second: Number(values.get('second'))
  }
}

function getTimeZoneOffsetMs(date, timeZone = NOTIFICATION_TIME_ZONE) {
  const parts = getTimeZoneDateParts(date, timeZone)
  const utcTime = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)

  return utcTime - date.getTime()
}

function toUtcFromTimeZone(parts, timeZone = NOTIFICATION_TIME_ZONE) {
  const utcTime = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute ?? 0, 0, 0)
  const firstPass = new Date(utcTime - getTimeZoneOffsetMs(new Date(utcTime), timeZone))

  return new Date(utcTime - getTimeZoneOffsetMs(firstPass, timeZone))
}

function addLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days))

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  }
}

function getLocalWeekday(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
}

function getNextWeekdayAt({weekday, hour, minute = 0, from = new Date()}) {
  const localParts = getTimeZoneDateParts(from)
  const delta = (weekday - getLocalWeekday(localParts) + 7) % 7
  let dateParts = addLocalDays(localParts, delta)
  let result = toUtcFromTimeZone({
    ...dateParts,
    hour,
    minute
  })

  if (result <= from) {
    dateParts = addLocalDays(dateParts, 7)
    result = toUtcFromTimeZone({
      ...dateParts,
      hour,
      minute
    })
  }

  return result
}

function getNextMonthDayAt({day, hour, minute = 0, from = new Date()}) {
  const localParts = getTimeZoneDateParts(from)
  let result = toUtcFromTimeZone({
    year: localParts.year,
    month: localParts.month,
    day,
    hour,
    minute
  })

  if (result <= from) {
    const nextMonth = new Date(Date.UTC(localParts.year, localParts.month, 1))
    result = toUtcFromTimeZone({
      year: nextMonth.getUTCFullYear(),
      month: nextMonth.getUTCMonth() + 1,
      day,
      hour,
      minute
    })
  }

  return result
}

export function getScheduledFor({notificationType, periodType, from = new Date()} = {}) {
  if (periodType === 'week') {
    return getNextWeekdayAt({
      weekday: 1,
      hour: notificationType === 'followup' ? 17 : 9,
      from
    })
  }

  return getNextMonthDayAt({
    day: notificationType === 'followup' ? 5 : 28,
    hour: 9,
    from
  })
}

async function computeUpcomingDeclarationNotificationPreviews({from, client}) {
  const settings = await listDeclarationNotificationSettings({client})
  const settingsByKey = new Map(settings.map(setting => [
    `${setting.notificationType}:${setting.periodType}`,
    setting
  ]))

  return Promise.all(DECLARATION_NOTIFICATION_DEFINITIONS.map(async definition => {
    const scheduledFor = getScheduledFor({...definition, from})
    const periodKey = getNotificationPeriodKeyForDate(definition.notificationType, definition.periodType, scheduledFor)
    const preview = await computeDeclarationNotificationRecipients({
      ...definition,
      periodKey,
      scheduledFor,
      client
    })

    return {
      ...definition,
      periodKey,
      periodLabel: preview.periodLabel,
      scheduledFor,
      enabled: settingsByKey.get(`${definition.notificationType}:${definition.periodType}`)?.enabled ?? true,
      summary: preview.summary
    }
  }))
}

export function clearUpcomingDeclarationNotificationPreviewsCache() {
  upcomingPreviewsCache.clear()
}

export async function listUpcomingDeclarationNotificationPreviews({from, client = prisma} = {}) {
  const shouldUseCache = client === prisma && !from
  const referenceDate = from ?? new Date()

  if (!shouldUseCache) {
    return computeUpcomingDeclarationNotificationPreviews({
      client,
      from: referenceDate
    })
  }

  return upcomingPreviewsCache.get(() =>
    computeUpcomingDeclarationNotificationPreviews({
      client,
      from: referenceDate
    }))
}

export function serializeRun(run) {
  return {
    id: run.id,
    notificationType: fromDbNotificationType(run.notificationType),
    periodType: fromDbPeriodType(run.periodType),
    periodKey: run.periodKey,
    scheduledFor: run.scheduledFor,
    status: run.status,
    statusLabel: RUN_STATUS_LABELS.get(run.status) ?? run.status,
    brevoTemplateId: run.brevoTemplateId,
    recipientCount: run.recipientCount,
    sentCount: run.sentCount,
    failedCount: run.failedCount,
    error: run.error,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt
  }
}

export function serializeRecipient(recipient) {
  return {
    id: recipient.id,
    email: recipient.email,
    declarantUserId: recipient.declarantUserId,
    recipientRole: recipient.recipientRole,
    firstName: recipient.firstName,
    lastName: recipient.lastName,
    socialReason: recipient.socialReason,
    phoneNumber: recipient.phoneNumber,
    zones: recipient.zones,
    points: recipient.points,
    templateParams: recipient.templateParams,
    inclusionReason: recipient.inclusionReason,
    status: recipient.status,
    statusLabel: RECIPIENT_STATUS_LABELS.get(recipient.status) ?? recipient.status,
    brevoMessageId: recipient.brevoMessageId,
    error: recipient.error,
    sentAt: recipient.sentAt,
    createdAt: recipient.createdAt,
    updatedAt: recipient.updatedAt
  }
}

export async function buildDeclarationNotificationEmailPreview({
  notificationType,
  periodType,
  periodKey,
  email,
  scheduledFor = new Date(),
  runId,
  recipientId,
  client = prisma,
  apiKey,
  fetchImplementation
}) {
  let templateId
  let recipient
  let params
  let previewNotificationType
  let previewPeriodType
  let previewPeriodKey
  let previewScheduledFor

  if (runId || recipientId) {
    if (!runId || !recipientId) {
      throw createHttpError(400, 'Envoi et destinataire requis pour cet aperçu.')
    }

    const storedRecipient = await client.declarationNotificationRecipient.findFirst({
      where: {
        id: recipientId,
        runId
      },
      include: {
        run: true
      }
    })

    if (!storedRecipient) {
      throw createHttpError(404, 'Destinataire introuvable pour cet envoi.')
    }

    templateId = storedRecipient.run.brevoTemplateId
    previewNotificationType = fromDbNotificationType(storedRecipient.run.notificationType)
    previewPeriodType = fromDbPeriodType(storedRecipient.run.periodType)
    previewPeriodKey = storedRecipient.run.periodKey
    previewScheduledFor = storedRecipient.run.scheduledFor
    recipient = {
      email: storedRecipient.email,
      name: buildDisplayName(storedRecipient)
    }
    params = storedRecipient.templateParams
  } else {
    const normalizedEmail = normalizeEmail(email)
    const normalizedPeriodType = parseDeclarationPeriodType(periodType)
    const preview = await computeDeclarationNotificationRecipients({
      notificationType,
      periodType: normalizedPeriodType,
      periodKey,
      scheduledFor,
      client
    })
    const computedRecipient = preview.recipients.find(item => item.email === normalizedEmail)

    if (!computedRecipient) {
      throw createHttpError(404, 'Destinataire introuvable dans cet aperçu.')
    }

    templateId = getBrevoTemplateId(notificationType, normalizedPeriodType)
    previewNotificationType = preview.notificationType
    previewPeriodType = preview.periodType
    previewPeriodKey = preview.periodKey
    previewScheduledFor = scheduledFor
    recipient = {
      email: computedRecipient.email,
      name: computedRecipient.name
    }
    params = computedRecipient.templateParams
  }

  if (!templateId) {
    throw createHttpError(400, 'Template Brevo manquant pour cet aperçu.')
  }

  const templatePreview = await buildBrevoTemplatePreview({
    templateId,
    params,
    recipient,
    apiKey,
    fetchImplementation
  })

  return {
    ...templatePreview,
    notificationType: previewNotificationType,
    periodType: previewPeriodType,
    periodKey: previewPeriodKey,
    scheduledFor: previewScheduledFor
  }
}

async function sendBrevoTemplateEmail({email, name, templateId, params}) {
  if (!process.env.BREVO_API_KEY) {
    throw new Error('BREVO_API_KEY manquant')
  }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      templateId,
      to: [
        {
          email,
          ...(name ? {name} : {})
        }
      ],
      params
    })
  })

  let data = {}
  try {
    data = await response.json()
  } catch {}

  if (!response.ok) {
    throw new Error(data.message || `Brevo a répondu ${response.status}`)
  }

  return data.messageId ?? null
}

async function updateRunCounters(runId, client = prisma) {
  const grouped = await client.declarationNotificationRecipient.groupBy({
    by: ['status'],
    where: {runId},
    _count: {_all: true}
  })
  const countByStatus = new Map(grouped.map(item => [item.status, item._count._all]))
  const failedCount = countByStatus.get('FAILED') ?? 0
  const pendingCount = countByStatus.get('PENDING') ?? 0
  const sentCount = countByStatus.get('SENT') ?? 0
  const status = failedCount > 0
    ? (sentCount > 0 ? 'PARTIAL_FAILURE' : 'FAILED')
    : (pendingCount > 0 ? 'SENDING' : 'SENT')

  return client.declarationNotificationRun.update({
    where: {id: runId},
    data: {
      status,
      sentCount,
      failedCount,
      completedAt: pendingCount === 0 ? new Date() : null
    }
  })
}

export async function createDeclarationNotificationRun({
  notificationType,
  periodType,
  periodKey,
  scheduledFor = new Date(),
  client = prisma
}) {
  const dbNotificationType = toDbNotificationType(notificationType)
  const normalizedPeriodType = parseDeclarationPeriodType(periodType)
  const dbPeriodType = toDbPeriodType(normalizedPeriodType)
  const normalizedPeriodKey = parseDeclarationPeriodKey(periodKey, normalizedPeriodType)

  if (!normalizedPeriodKey) {
    throw createHttpError(400, 'Période invalide.')
  }

  await assertDeclarationNotificationEnabled({
    notificationType,
    periodType: normalizedPeriodType,
    client
  })

  const templateId = getBrevoTemplateId(notificationType, normalizedPeriodType)
  const preview = await computeDeclarationNotificationRecipients({
    notificationType,
    periodType: normalizedPeriodType,
    periodKey: normalizedPeriodKey,
    scheduledFor,
    client
  })
  const guardError = await getRunGuardError({
    preview,
    dbNotificationType,
    dbPeriodType,
    client
  })

  const status = templateId && process.env.BREVO_API_KEY && !guardError ? 'SCHEDULED' : 'BLOCKED'
  const error = guardError
    ?? (templateId
      ? (process.env.BREVO_API_KEY ? null : 'BREVO_API_KEY manquant')
      : `Template Brevo manquant pour ${notificationType}/${normalizedPeriodType}`)

  return client.$transaction(async tx => {
    const run = await tx.declarationNotificationRun.upsert({
      where: {
        notificationType_periodType_periodKey: {
          notificationType: dbNotificationType,
          periodType: dbPeriodType,
          periodKey: normalizedPeriodKey
        }
      },
      update: {},
      create: {
        notificationType: dbNotificationType,
        periodType: dbPeriodType,
        periodKey: normalizedPeriodKey,
        scheduledFor,
        status,
        brevoTemplateId: templateId,
        recipientCount: preview.recipients.length,
        metadata: {
          periodLabel: preview.periodLabel,
          exclusions: preview.exclusions,
          summary: preview.summary
        },
        error
      }
    })

    const existingRecipients = await tx.declarationNotificationRecipient.count({
      where: {runId: run.id}
    })

    if (existingRecipients === 0 && preview.recipients.length > 0) {
      await tx.declarationNotificationRecipient.createMany({
        data: preview.recipients.map(recipient => ({
          runId: run.id,
          email: recipient.email,
          declarantUserId: recipient.declarantUserId,
          recipientRole: recipient.recipientRole,
          firstName: recipient.firstName,
          lastName: recipient.lastName,
          socialReason: recipient.socialReason,
          phoneNumber: recipient.phoneNumber,
          zones: recipient.zones,
          points: recipient.points,
          templateParams: recipient.templateParams,
          inclusionReason: recipient.inclusionReason
        })),
        skipDuplicates: true
      })
    }

    return tx.declarationNotificationRun.findUnique({
      where: {id: run.id},
      include: {recipients: true}
    })
  })
}

export async function sendDeclarationNotificationRun(runId, {onlyFailures = false, client = prisma} = {}) {
  const run = await client.declarationNotificationRun.findUnique({
    where: {id: runId},
    include: {
      recipients: {
        where: {
          status: onlyFailures ? 'FAILED' : 'PENDING'
        },
        orderBy: {email: 'asc'}
      }
    }
  })

  if (!run) {
    throw createHttpError(404, 'Envoi introuvable.')
  }

  await assertDeclarationNotificationEnabled({
    notificationType: fromDbNotificationType(run.notificationType),
    periodType: fromDbPeriodType(run.periodType),
    client
  })

  if (run.status === 'BLOCKED') {
    throw createHttpError(400, 'Cet envoi est bloqué.')
  }

  if (!run.brevoTemplateId) {
    throw createHttpError(400, 'Template Brevo manquant.')
  }

  await client.declarationNotificationRun.update({
    where: {id: run.id},
    data: {
      status: 'SENDING',
      startedAt: run.startedAt ?? new Date()
    }
  })

  for (const recipient of run.recipients) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const messageId = await sendBrevoTemplateEmail({
        email: recipient.email,
        name: buildDisplayName(recipient),
        templateId: run.brevoTemplateId,
        params: recipient.templateParams
      })

      // eslint-disable-next-line no-await-in-loop
      await client.declarationNotificationRecipient.update({
        where: {id: recipient.id},
        data: {
          status: 'SENT',
          brevoMessageId: messageId,
          error: null,
          sentAt: new Date()
        }
      })
    } catch (error) {
      // eslint-disable-next-line no-await-in-loop
      await client.declarationNotificationRecipient.update({
        where: {id: recipient.id},
        data: {
          status: 'FAILED',
          error: error.message || String(error)
        }
      })
    }
  }

  return updateRunCounters(run.id, client)
}

export async function sendDeclarationNotificationNow({
  notificationType,
  periodType,
  periodKey,
  scheduledFor = new Date(),
  client = prisma
}) {
  const run = await createDeclarationNotificationRun({
    notificationType,
    periodType,
    periodKey,
    scheduledFor,
    client
  })

  if (run.status === 'BLOCKED') {
    return run
  }

  return sendDeclarationNotificationRun(run.id, {client})
}

export async function processScheduledDeclarationNotification({
  notificationType,
  periodType,
  date = new Date(),
  client = prisma
}) {
  const enabled = await isDeclarationNotificationEnabled({
    notificationType,
    periodType,
    client
  })

  if (!enabled) {
    return {
      skipped: true,
      reason: 'NOTIFICATION_DISABLED',
      notificationType,
      periodType
    }
  }

  const periodKey = getNotificationPeriodKeyForDate(notificationType, periodType, date)
  const run = await createDeclarationNotificationRun({
    notificationType,
    periodType,
    periodKey,
    scheduledFor: date,
    client
  })

  if (run.status === 'BLOCKED') {
    return run
  }

  return sendDeclarationNotificationRun(run.id, {client})
}

export async function listDeclarationNotificationRuns({status = null, limit = 50, client = prisma} = {}) {
  const runs = await client.declarationNotificationRun.findMany({
    where: status ? {status} : {},
    orderBy: {scheduledFor: 'desc'},
    take: limit
  })

  return runs.map(serializeRun)
}

export async function getDeclarationNotificationRun(runId, {client = prisma} = {}) {
  const run = await client.declarationNotificationRun.findUnique({
    where: {id: runId},
    include: {
      recipients: {
        orderBy: {email: 'asc'}
      }
    }
  })

  if (!run) {
    throw createHttpError(404, 'Envoi introuvable.')
  }

  return {
    ...serializeRun(run),
    metadata: run.metadata,
    recipients: run.recipients.map(serializeRecipient)
  }
}

export async function buildMissingDeclarationsWorkbook({
  periodType,
  periodKey,
  zoneId = null,
  client = prisma
}) {
  const preview = await computeDeclarationNotificationRecipients({
    notificationType: 'followup',
    periodType,
    periodKey,
    zoneId,
    client
  })
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Non déclarants')

  sheet.columns = [
    {header: 'Raison sociale', key: 'socialReason', width: 28},
    {header: 'Nom', key: 'lastName', width: 20},
    {header: 'Prénom', key: 'firstName', width: 20},
    {header: 'Mail', key: 'email', width: 32},
    {header: 'Téléphone', key: 'phoneNumber', width: 18},
    {header: 'Zones', key: 'zones', width: 32},
    {header: 'Points concernés', key: 'points', width: 36},
    {header: 'Usage', key: 'usage', width: 24},
    {header: 'Usages secondaires', key: 'secondaryUsages', width: 36},
    {header: 'Ressource', key: 'resourceName', width: 24},
    {header: 'Période attendue', key: 'period', width: 22},
    {header: 'Type', key: 'type', width: 20}
  ]

  const fallback = 'Non renseigné'

  for (const recipient of preview.recipients) {
    sheet.addRow({
      socialReason: recipient.socialReason || fallback,
      lastName: recipient.lastName || fallback,
      firstName: recipient.firstName || fallback,
      email: recipient.email || fallback,
      phoneNumber: recipient.phoneNumber || fallback,
      zones: recipient.zones.map(zone => zone.name).join(', ') || fallback,
      points: recipient.points.map(point => point.name).join(', ') || fallback,
      usage: [...new Set(recipient.points.map(point => point.usage?.name).filter(Boolean))].join(', ') || fallback,
      secondaryUsages: [...new Set(recipient.points
        .flatMap(point => point.secondaryUsages ?? [])
        .map(usage => usage.name)
        .filter(Boolean))].join(', ') || fallback,
      resourceName: [...new Set(recipient.points.map(point => point.resourceName).filter(Boolean))].join(', ') || fallback,
      period: preview.periodLabel,
      type: recipient.recipientRole === 'COLLECTEUR' ? 'Collecteur' : 'Préleveur déclarant'
    })
  }

  sheet.getRow(1).font = {bold: true}
  sheet.views = [{state: 'frozen', ySplit: 1}]

  return {
    workbook,
    preview
  }
}
