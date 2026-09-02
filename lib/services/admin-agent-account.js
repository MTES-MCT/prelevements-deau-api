import createHttpError from 'http-errors'
import Joi from 'joi'
import prismaPkg from '@prisma/client'

import {prisma} from '../../db/prisma.js'
import {ZONE_AGENT_MANAGEMENT_PERMISSIONS} from '../constants/zone-permissions.js'
import {activeWindowWhere} from '../models/point-prelevement.js'
import {normalizeEmail} from '../util/email.js'
import {validateUserProfileChanges} from '../validation/user-profile-validation.js'
import {serializeAdminAgentDetail} from './admin-agents.js'

const {Prisma} = prismaPkg

const agentUserIdSchema = Joi.string().guid({version: 'uuidv4'}).required()
const ACTIVE_EMAIL_VERIFICATION_STATUSES = ['PENDING', 'SEND_FAILED']
const DEFAULT_SERIALIZATION_RETRIES = 2

const AGENT_ACCOUNT_INCLUDE = {
  instructor: {
    include: {
      instructorZones: {
        include: {
          permissions: true,
          zone: {
            select: {
              id: true,
              type: true,
              code: true,
              name: true
            }
          }
        },
        orderBy: [
          {startDate: 'desc'},
          {createdAt: 'desc'}
        ]
      }
    }
  }
}

export const ADMIN_AGENT_ACCOUNT_NOTIFICATION_TYPES = Object.freeze({
  DEACTIVATED: 'DEACTIVATED',
  EMAIL_CHANGED: 'EMAIL_CHANGED',
  RESTORED: 'RESTORED'
})

function serviceError(status, message, code, additions = {}) {
  const error = createHttpError(status, message)
  error.data = {code, ...additions}
  return error
}

function validateAgentUserId(agentUserId) {
  const {error, value} = agentUserIdSchema.validate(agentUserId)

  if (error) {
    throw serviceError(400, 'Identifiant d’agent invalide.', 'INVALID_AGENT_ID')
  }

  return value
}

function normalizeStoredEmail(email) {
  return email ? String(email).trim().toLowerCase() : null
}

function normalizeRequiredExpectedDate(value) {
  if (value === undefined || value === null || value === '') {
    throw serviceError(
      400,
      'La version attendue de l’agent est obligatoire.',
      'EXPECTED_UPDATED_AT_REQUIRED'
    )
  }

  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    throw serviceError(
      400,
      'La version attendue de l’agent est invalide.',
      'INVALID_EXPECTED_UPDATED_AT'
    )
  }

  return date
}

function assertExpectedUpdatedAt(agent, expectedUpdatedAt) {
  if (new Date(agent.updatedAt).getTime() !== expectedUpdatedAt.getTime()) {
    throw serviceError(
      412,
      'Cet agent a été modifié. Rechargez sa fiche puis réessayez.',
      'AGENT_STALE',
      {currentUpdatedAt: agent.updatedAt}
    )
  }
}

function assertExpectedEmail(agent, expectedCurrentEmail) {
  if (normalizeStoredEmail(agent.email) !== expectedCurrentEmail) {
    throw serviceError(
      412,
      'L’adresse email de cet agent a été modifiée. Rechargez sa fiche puis réessayez.',
      'AGENT_EMAIL_STALE',
      {currentEmail: agent.email}
    )
  }
}

function isSerializationConflict(error) {
  return error?.code === 'P2034'
    || error?.code === '40001'
    || error?.meta?.code === '40001'
    || error?.cause?.code === '40001'
}

function isEmailIdentityConflict(error) {
  const message = [
    error?.message,
    error?.meta?.database_error,
    error?.cause?.message
  ].filter(Boolean).join(' ')

  return error?.code === 'P2002'
    || error?.code === 'P2004'
    || error?.code === '23505'
    || message.includes('User_email_not_alias')
    || message.includes('User_email_reserved')
    || message.includes('UserEmailAlias_email_not_primary')
    || message.includes('UserEmailAlias_email_reserved')
    || message.includes('UserEmailVerification_active_email_key')
    || message.includes('UserEmailIdentity_compatible_claims_check')
}

async function runSerializable(operation, {
  client,
  retries = DEFAULT_SERIALIZATION_RETRIES
}) {
  try {
    return await client.$transaction(operation, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    })
  } catch (error) {
    if (!isSerializationConflict(error)) {
      throw error
    }

    if (retries > 0) {
      return runSerializable(operation, {
        client,
        retries: retries - 1
      })
    }

    throw serviceError(
      503,
      'Le compte agent a été modifié simultanément. Veuillez réessayer.',
      'AGENT_CONCURRENT_UPDATE'
    )
  }
}

async function lockAgentIdentity(client, agentUserId) {
  const rows = await client.$queryRaw(Prisma.sql`
    SELECT agent_user."id"
    FROM "User" AS agent_user
    INNER JOIN "Instructor" AS instructor
      ON instructor."userId" = agent_user."id"
    WHERE agent_user."id" = ${agentUserId}::uuid
      AND agent_user."role" = 'INSTRUCTOR'::"UserRole"
    FOR UPDATE OF agent_user, instructor
  `)

  return rows.length === 1
}

async function lockAgentAssignments(client, agentUserId) {
  await client.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "InstructorZone"
    WHERE "instructorUserId" = ${agentUserId}::uuid
    ORDER BY "zoneId"
    FOR UPDATE
  `)
}

async function findAgent(client, agentUserId, {state = 'ANY'} = {}) {
  return client.user.findFirst({
    where: {
      id: agentUserId,
      role: 'INSTRUCTOR',
      instructor: {isNot: null},
      ...(state === 'ACTIVE' ? {deletedAt: null} : {}),
      ...(state === 'DEACTIVATED' ? {deletedAt: {not: null}} : {})
    },
    include: AGENT_ACCOUNT_INCLUDE
  })
}

async function getLockedAgent(client, agentUserId, {state = 'ANY'} = {}) {
  if (!await lockAgentIdentity(client, agentUserId)) {
    throw serviceError(404, 'Cet agent est introuvable.', 'AGENT_NOT_FOUND')
  }

  const agent = await findAgent(client, agentUserId, {state})

  if (agent) {
    return agent
  }

  const existing = await findAgent(client, agentUserId)

  if (!existing) {
    throw serviceError(404, 'Cet agent est introuvable.', 'AGENT_NOT_FOUND')
  }

  if (state === 'ACTIVE') {
    throw serviceError(409, 'Cet agent est déjà désactivé.', 'AGENT_ALREADY_DEACTIVATED')
  }

  if (state === 'DEACTIVATED') {
    throw serviceError(409, 'Cet agent est déjà actif.', 'AGENT_ALREADY_ACTIVE')
  }

  return existing
}

function normalizedMutationCount(result) {
  return Number.isInteger(result?.count) ? result.count : 0
}

async function invalidateLoginArtifacts(client, agentUserId, {
  cancelEmailVerifications = false,
  deleteAliases = false,
  deletePasswordCredential = false,
  now = new Date()
} = {}) {
  let emailVerifications = {count: 0}
  let aliases = {count: 0}

  if (cancelEmailVerifications) {
    emailVerifications = await client.userEmailVerification.updateMany({
      where: {
        userId: agentUserId,
        status: {in: ACTIVE_EMAIL_VERIFICATION_STATUSES}
      },
      data: {
        status: 'CANCELLED',
        tokenHash: null,
        cancelledAt: now
      }
    })
  }

  if (deleteAliases) {
    aliases = await client.userEmailAlias.deleteMany({
      where: {userId: agentUserId}
    })
  }

  const [authTokens, passwordActivations, sessions, passwordCredentials] = await Promise.all([
    client.authToken.deleteMany({where: {userId: agentUserId}}),
    client.passwordActivation.deleteMany({where: {userId: agentUserId}}),
    client.sessionToken.deleteMany({
      where: {
        OR: [
          {userId: agentUserId},
          {impersonatedByUserId: agentUserId}
        ]
      }
    }),
    deletePasswordCredential
      ? client.passwordCredential.deleteMany({where: {userId: agentUserId}})
      : Promise.resolve({count: 0})
  ])

  return {
    aliases: normalizedMutationCount(aliases),
    authTokens: normalizedMutationCount(authTokens),
    emailVerifications: normalizedMutationCount(emailVerifications),
    passwordActivations: normalizedMutationCount(passwordActivations),
    passwordCredentials: normalizedMutationCount(passwordCredentials),
    sessions: normalizedMutationCount(sessions)
  }
}

function uniqueRecipients(...emails) {
  return [...new Set(emails.map(normalizeStoredEmail).filter(Boolean))]
}

function getToday(now) {
  return new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`)
}

async function notifyBestEffort(notify, payload, warning) {
  if (typeof notify !== 'function') {
    return []
  }

  try {
    return await notify(payload) === false ? [warning] : []
  } catch {
    return [warning]
  }
}

export function serializeAdminAgentAccount(agent, {now = new Date()} = {}) {
  if (!agent?.instructor || agent.role !== 'INSTRUCTOR') {
    return null
  }

  return serializeAdminAgentDetail(agent, {now})
}

function selectProfileChanges(value) {
  const userChanges = {}
  const instructorChanges = {}

  for (const field of ['firstName', 'lastName']) {
    if (Object.hasOwn(value, field)) {
      userChanges[field] = value[field]
    }
  }

  for (const field of ['phoneNumber', 'jobTitle']) {
    if (Object.hasOwn(value, field)) {
      instructorChanges[field] = value[field]
    }
  }

  return {userChanges, instructorChanges}
}

export async function updateAdminAgentProfile(agentUserId, body, {
  client = prisma,
  now = new Date(),
  serializationRetries = DEFAULT_SERIALIZATION_RETRIES
} = {}) {
  const id = validateAgentUserId(agentUserId)

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw serviceError(400, 'Les modifications doivent être un objet.', 'INVALID_AGENT_PROFILE')
  }

  const expectedUpdatedAt = normalizeRequiredExpectedDate(body.expectedUpdatedAt)
  const {expectedUpdatedAt: _expectedUpdatedAt, ...changes} = body

  const updated = await runSerializable(async transaction => {
    const agent = await getLockedAgent(transaction, id, {state: 'ACTIVE'})
    assertExpectedUpdatedAt(agent, expectedUpdatedAt)

    const value = validateUserProfileChanges(changes, agent)
    const {userChanges, instructorChanges} = selectProfileChanges(value)

    return transaction.user.update({
      where: {
        id,
        role: 'INSTRUCTOR',
        deletedAt: null,
        updatedAt: expectedUpdatedAt
      },
      data: {
        ...userChanges,
        ...(Object.keys(instructorChanges).length > 0
          ? {instructor: {update: {data: instructorChanges}}}
          : {})
      },
      include: AGENT_ACCOUNT_INCLUDE
    })
  }, {client, retries: serializationRetries})

  return {
    agent: serializeAdminAgentAccount(updated, {now}),
    warnings: []
  }
}

export async function replaceAdminAgentEmail(agentUserId, body, {
  client = prisma,
  notify,
  now = new Date(),
  serializationRetries = DEFAULT_SERIALIZATION_RETRIES
} = {}) {
  const id = validateAgentUserId(agentUserId)

  if (!body || typeof body !== 'object' || Array.isArray(body)
    || !Object.hasOwn(body, 'expectedCurrentEmail')) {
    throw serviceError(
      400,
      'L’adresse actuelle attendue est obligatoire.',
      'EXPECTED_CURRENT_EMAIL_REQUIRED'
    )
  }

  const email = normalizeEmail(body.email)
  const expectedCurrentEmail = normalizeEmail(body.expectedCurrentEmail, {required: false})

  let result
  try {
    result = await runSerializable(async transaction => {
      const agent = await getLockedAgent(transaction, id)
      assertExpectedEmail(agent, expectedCurrentEmail)

      const previousEmail = agent.email
      if (normalizeStoredEmail(previousEmail) === email) {
        return {
          agent,
          changed: false,
          invalidated: {
            authTokens: 0,
            passwordActivations: 0,
            sessions: 0
          },
          previousEmail
        }
      }

      await transaction.userEmailVerification.updateMany({
        where: {
          userId: id,
          status: {in: ACTIVE_EMAIL_VERIFICATION_STATUSES}
        },
        data: {
          status: 'SUPERSEDED',
          tokenHash: null
        }
      })

      await transaction.userEmailAlias.deleteMany({
        where: {
          userId: id,
          email
        }
      })

      const invalidated = await invalidateLoginArtifacts(transaction, id)
      const updated = await transaction.user.update({
        where: {
          id,
          role: 'INSTRUCTOR',
          email: previousEmail
        },
        data: {email},
        include: AGENT_ACCOUNT_INCLUDE
      })

      return {
        agent: updated,
        changed: true,
        invalidated: {
          authTokens: invalidated.authTokens,
          passwordActivations: invalidated.passwordActivations,
          sessions: invalidated.sessions
        },
        previousEmail
      }
    }, {client, retries: serializationRetries})
  } catch (error) {
    if (isEmailIdentityConflict(error)) {
      throw serviceError(
        409,
        'Cette adresse email est déjà utilisée ou réservée.',
        'AGENT_EMAIL_CONFLICT'
      )
    }

    throw error
  }

  const agent = serializeAdminAgentAccount(result.agent, {now})
  const warnings = result.changed
    ? await notifyBestEffort(notify, {
      type: ADMIN_AGENT_ACCOUNT_NOTIFICATION_TYPES.EMAIL_CHANGED,
      agent,
      previousEmail: result.previousEmail,
      newEmail: agent.email,
      recipients: uniqueRecipients(result.previousEmail, agent.email)
    }, 'AGENT_EMAIL_NOTIFICATION_FAILED')
    : []

  return {
    agent,
    changed: result.changed,
    invalidated: result.invalidated,
    previousEmail: result.previousEmail,
    warnings
  }
}

function isActiveManagerRight(right, now) {
  const permissions = new Set((right.permissions ?? []).map(item => item.permission))
  const today = getToday(now)
  const startDate = right.startDate ? new Date(right.startDate) : null
  const endDate = right.endDate ? new Date(right.endDate) : null

  return Boolean(startDate && startDate <= today && (!endDate || endDate >= today))
    && ZONE_AGENT_MANAGEMENT_PERMISSIONS.every(permission => permissions.has(permission))
}

async function lockManagementZones(client, zoneIds, index = 0) {
  if (index >= zoneIds.length) {
    return
  }

  await client.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtext(${zoneIds[index]})::bigint)
  `)

  return lockManagementZones(client, zoneIds, index + 1)
}

async function getLastManagedZones(client, agent, now) {
  const managerRights = (agent.instructor?.instructorZones ?? [])
    .filter(right => isActiveManagerRight(right, now))

  if (managerRights.length === 0) {
    return []
  }

  const today = getToday(now)
  const {
    AND: activeWindowConditions = [],
    ...activeWindowFilters
  } = activeWindowWhere(today, {
    startNullable: false,
    endNullable: true
  })

  const counts = await Promise.all(managerRights.map(async right => ({
    right,
    count: await client.instructorZone.count({
      where: {
        zoneId: right.zoneId,
        instructorUserId: {not: agent.id},
        ...activeWindowFilters,
        instructor: {
          user: {deletedAt: null}
        },
        AND: [
          ...activeWindowConditions,
          ...ZONE_AGENT_MANAGEMENT_PERMISSIONS.map(permission => ({
            permissions: {some: {permission}}
          }))
        ]
      }
    })
  })))

  return counts
    .filter(({count}) => count === 0)
    .map(({right}) => right.zone)
}

export async function deactivateAdminAgent(agentUserId, body, {
  client = prisma,
  notify,
  now = new Date(),
  serializationRetries = DEFAULT_SERIALIZATION_RETRIES
} = {}) {
  const id = validateAgentUserId(agentUserId)

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw serviceError(
      400,
      'La désactivation doit être un objet.',
      'INVALID_AGENT_DEACTIVATION'
    )
  }

  const expectedUpdatedAt = normalizeRequiredExpectedDate(body.expectedUpdatedAt)

  const result = await runSerializable(async transaction => {
    const agent = await getLockedAgent(transaction, id, {state: 'ACTIVE'})
    assertExpectedUpdatedAt(agent, expectedUpdatedAt)

    const zoneIds = [...new Set(
      (agent.instructor?.instructorZones ?? []).map(right => right.zoneId)
    )].sort()

    await lockManagementZones(transaction, zoneIds)
    await lockAgentAssignments(transaction, id)

    const currentAgent = await findAgent(transaction, id, {state: 'ACTIVE'})
    if (!currentAgent) {
      throw serviceError(409, 'Cet agent a été modifié.', 'AGENT_STALE')
    }

    assertExpectedUpdatedAt(currentAgent, expectedUpdatedAt)
    const lastManagedZones = await getLastManagedZones(transaction, currentAgent, now)

    if (lastManagedZones.length > 0) {
      throw serviceError(
        409,
        'Cet agent est le dernier gestionnaire actif d’au moins une zone.',
        'LAST_ACTIVE_ZONE_MANAGER',
        {
          zones: lastManagedZones.map(zone => ({
            id: zone.id,
            code: zone.code,
            name: zone.name,
            type: zone.type
          }))
        }
      )
    }

    const invalidated = await invalidateLoginArtifacts(transaction, id, {
      cancelEmailVerifications: true,
      deleteAliases: true,
      deletePasswordCredential: true,
      now
    })

    const updated = await transaction.user.update({
      where: {
        id,
        role: 'INSTRUCTOR',
        deletedAt: null,
        updatedAt: expectedUpdatedAt
      },
      data: {
        authVersion: {increment: 1},
        deletedAt: now
      },
      include: AGENT_ACCOUNT_INCLUDE
    })

    return {agent: updated, invalidated}
  }, {client, retries: serializationRetries})

  const agent = serializeAdminAgentAccount(result.agent, {now})
  const warnings = await notifyBestEffort(notify, {
    type: ADMIN_AGENT_ACCOUNT_NOTIFICATION_TYPES.DEACTIVATED,
    agent,
    recipients: uniqueRecipients(agent.email)
  }, 'AGENT_DEACTIVATION_NOTIFICATION_FAILED')

  return {
    agent,
    invalidated: result.invalidated,
    warnings
  }
}

export async function restoreAdminAgent(agentUserId, body, {
  client = prisma,
  notify,
  now = new Date(),
  serializationRetries = DEFAULT_SERIALIZATION_RETRIES
} = {}) {
  const id = validateAgentUserId(agentUserId)

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw serviceError(400, 'La restauration doit être un objet.', 'INVALID_AGENT_RESTORE')
  }

  const expectedUpdatedAt = normalizeRequiredExpectedDate(body.expectedUpdatedAt)

  const result = await runSerializable(async transaction => {
    const agent = await getLockedAgent(transaction, id, {state: 'DEACTIVATED'})
    assertExpectedUpdatedAt(agent, expectedUpdatedAt)

    if (!agent.email) {
      throw serviceError(
        409,
        'Renseignez une adresse email avant de restaurer cet agent.',
        'AGENT_EMAIL_REQUIRED'
      )
    }

    const invalidated = await invalidateLoginArtifacts(transaction, id, {
      cancelEmailVerifications: true,
      deleteAliases: true,
      deletePasswordCredential: true,
      now
    })

    const updated = await transaction.user.update({
      where: {
        id,
        role: 'INSTRUCTOR',
        deletedAt: {not: null},
        updatedAt: expectedUpdatedAt
      },
      data: {
        authVersion: {increment: 1},
        deletedAt: null
      },
      include: AGENT_ACCOUNT_INCLUDE
    })

    return {agent: updated, invalidated}
  }, {client, retries: serializationRetries})

  const agent = serializeAdminAgentAccount(result.agent, {now})
  const warnings = await notifyBestEffort(notify, {
    type: ADMIN_AGENT_ACCOUNT_NOTIFICATION_TYPES.RESTORED,
    agent,
    recipients: uniqueRecipients(agent.email)
  }, 'AGENT_RESTORATION_NOTIFICATION_FAILED')

  return {
    agent,
    invalidated: result.invalidated,
    warnings
  }
}
