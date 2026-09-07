import {createHash, randomBytes, randomUUID} from 'node:crypto'

import {Prisma} from '@prisma/client'
import createHttpError from 'http-errors'

import {prisma} from '../../db/prisma.js'
import {normalizeEmail} from '../util/email.js'
import {MAX_DECLARANT_CONTACT_EMAILS} from './declarant-contact-email.js'
import {requireActiveUserSession} from './session-token.js'

export const EMAIL_VERIFICATION_TTL_SECONDS = 24 * 60 * 60
export const EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS = 60

export const EMAIL_VERIFICATION_PURPOSES = Object.freeze({
  PRIMARY_CHANGE: 'PRIMARY_CHANGE',
  ALIAS_ADD: 'ALIAS_ADD'
})

export const EMAIL_VERIFICATION_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  SEND_FAILED: 'SEND_FAILED',
  EXPIRED: 'EXPIRED',
  VERIFIED: 'VERIFIED',
  CANCELLED: 'CANCELLED',
  SUPERSEDED: 'SUPERSEDED',
  CONFLICT: 'CONFLICT'
})

const ACTIVE_STATUSES = [
  EMAIL_VERIFICATION_STATUSES.PENDING,
  EMAIL_VERIFICATION_STATUSES.SEND_FAILED
]

const PURPOSE_VALUES = new Set(Object.values(EMAIL_VERIFICATION_PURPOSES))

function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(status)
}

function isExpired(verification, now) {
  return isActiveStatus(verification.status)
    && new Date(verification.expiresAt) <= now
}

function normalizeStoredEmail(email) {
  return email ? String(email).trim().toLowerCase() : null
}

function normalizeVerificationEmail(email) {
  if (typeof email === 'string' && email.length > 320) {
    throw createHttpError(400, 'Adresse email trop longue.')
  }

  const normalized = normalizeEmail(email)
  if (normalized.length > 320) {
    throw createHttpError(400, 'Adresse email trop longue.')
  }

  return normalized
}

function validatePurpose(purpose) {
  if (!PURPOSE_VALUES.has(purpose)) {
    throw createHttpError(400, 'Finalité de validation email invalide.')
  }

  return purpose
}

function getSessionTokensWhere(userId) {
  return {
    OR: [
      {userId},
      {impersonatedByUserId: userId}
    ]
  }
}

function isConstraintConflict(error) {
  const message = [
    error?.message,
    error?.meta?.database_error,
    error?.cause?.message
  ].filter(Boolean).join(' ')

  return error?.code === 'P2002'
    || error?.code === '23505'
    || message.includes('UserEmailVerification_active_email_key')
    || message.includes('UserEmailVerification_email_not_primary')
    || message.includes('UserEmailVerification_email_not_alias')
    || message.includes('UserEmailAlias_email_not_primary')
    || message.includes('UserEmailAlias_email_reserved')
    || message.includes('User_email_not_alias')
    || message.includes('User_email_reserved')
    || message.includes('UserEmailIdentity_compatible_claims_check')
}

function isSerializationConflict(error) {
  return error?.code === 'P2034'
    || error?.code === '40001'
    || error?.meta?.code === '40001'
    || error?.cause?.code === '40001'
}

function terminalData(status, now) {
  const data = {status}

  if (status !== EMAIL_VERIFICATION_STATUSES.VERIFIED) {
    data.tokenHash = null
  }

  if (status === EMAIL_VERIFICATION_STATUSES.VERIFIED) {
    data.verifiedAt = now
  }

  if (status === EMAIL_VERIFICATION_STATUSES.CANCELLED) {
    data.cancelledAt = now
  }

  return data
}

function buildVerificationOutcome(outcome, verification, additions = {}) {
  return {
    outcome,
    verification,
    userId: verification.userId,
    purpose: verification.purpose,
    email: verification.email,
    ...additions
  }
}

function getSecurityNotificationRecipients(user) {
  const primaryEmail = normalizeStoredEmail(user.email)
  if (primaryEmail) {
    return [primaryEmail]
  }

  return [...new Set((user.emailAliases ?? [])
    .map(alias => normalizeStoredEmail(alias.email))
    .filter(Boolean))]
}

async function getActiveUser(userId, client) {
  return client.user.findFirst({
    where: {
      id: userId,
      deletedAt: null
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      emailAliases: {
        select: {
          id: true,
          email: true,
          createdAt: true
        },
        orderBy: {createdAt: 'asc'}
      }
    }
  })
}

async function findEmailConflict(client, {
  email,
  purpose,
  userId,
  verificationId
}) {
  const [primaryOwner, aliasOwner, activeVerification] = await Promise.all([
    client.user.findFirst({
      where: {
        email,
        deletedAt: null
      },
      select: {id: true}
    }),
    client.userEmailAlias.findUnique({
      where: {email},
      select: {id: true, userId: true}
    }),
    client.userEmailVerification.findFirst({
      where: {
        email,
        status: {in: ACTIVE_STATUSES},
        ...(verificationId ? {id: {not: verificationId}} : {})
      },
      select: {id: true, userId: true, purpose: true}
    })
  ])

  if (primaryOwner) {
    return 'PRIMARY_EMAIL'
  }

  if (aliasOwner
    && !(purpose === EMAIL_VERIFICATION_PURPOSES.PRIMARY_CHANGE
      && aliasOwner.userId === userId)) {
    return 'EMAIL_ALIAS'
  }

  if (activeVerification) {
    return 'ACTIVE_VERIFICATION'
  }

  return null
}

async function expireDueEmailVerifications(client, now, where = {}) {
  return client.userEmailVerification.updateMany({
    where: {
      ...where,
      status: {in: ACTIVE_STATUSES},
      expiresAt: {lte: now}
    },
    data: terminalData(EMAIL_VERIFICATION_STATUSES.EXPIRED, now)
  })
}

export function generateUserEmailVerificationToken() {
  return randomBytes(32).toString('base64url')
}

export function hashUserEmailVerificationToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex')
}

export function serializeUserEmailVerification(verification, {
  now = new Date()
} = {}) {
  if (!verification) {
    return null
  }

  const status = isExpired(verification, now)
    ? EMAIL_VERIFICATION_STATUSES.EXPIRED
    : verification.status
  const nextResendAt = isActiveStatus(status)
    ? new Date(
      new Date(verification.lastAttemptedAt).getTime()
        + (EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS * 1000)
    )
    : null

  return {
    id: verification.id,
    purpose: verification.purpose,
    email: verification.email,
    status,
    createdAt: verification.createdAt,
    sentAt: verification.sentAt ?? null,
    expiresAt: verification.expiresAt,
    verifiedAt: verification.verifiedAt ?? null,
    cancelledAt: verification.cancelledAt ?? null,
    nextResendAt,
    canResend: status === EMAIL_VERIFICATION_STATUSES.EXPIRED
      || Boolean(nextResendAt && nextResendAt <= now)
  }
}

export async function lockUserForEmailVerification(userId, {
  client = prisma
} = {}) {
  const rows = await client.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "User"
    WHERE "id" = ${userId}::uuid
    FOR UPDATE
  `)

  return rows.length === 1
}

export async function listEmailVerifications(userId, {
  client = prisma,
  now = new Date()
} = {}) {
  await expireDueEmailVerifications(client, now, {userId})

  const verifications = await Promise.all(
    Object.values(EMAIL_VERIFICATION_PURPOSES).map(purpose =>
      client.userEmailVerification.findFirst({
        where: {userId, purpose},
        orderBy: {createdAt: 'desc'}
      }))
  )

  return verifications
    .filter(Boolean)
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
}

export async function issueEmailVerification(userId, purpose, rawEmail, {
  allowImpersonatedSession = false,
  client = prisma,
  lockUser = lockUserForEmailVerification,
  now = new Date(),
  sessionToken = null,
  validateSession = requireActiveUserSession,
  ttlSeconds = EMAIL_VERIFICATION_TTL_SECONDS,
  cooldownSeconds = EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS
} = {}) {
  const normalizedPurpose = validatePurpose(purpose)
  const email = normalizeVerificationEmail(rawEmail)
  const token = generateUserEmailVerificationToken()
  const tokenHash = hashUserEmailVerificationToken(token)
  const expiresAt = new Date(now.getTime() + (ttlSeconds * 1000))

  try {
    return await client.$transaction(async transaction => {
      if (!await lockUser(userId, {client: transaction})) {
        throw createHttpError(404, 'Utilisateur introuvable.')
      }

      if (sessionToken) {
        await validateSession(userId, sessionToken, {
          allowImpersonated: allowImpersonatedSession,
          client: transaction,
          now
        })
      }

      const user = await getActiveUser(userId, transaction)
      if (!user) {
        throw createHttpError(404, 'Utilisateur introuvable.')
      }

      await expireDueEmailVerifications(transaction, now, {
        OR: [
          {userId},
          {email}
        ]
      })

      const existing = await transaction.userEmailVerification.findFirst({
        where: {
          userId,
          purpose: normalizedPurpose,
          status: {in: ACTIVE_STATUSES}
        },
        orderBy: {createdAt: 'desc'},
        select: {
          id: true,
          status: true,
          email: true,
          lastAttemptedAt: true
        }
      })

      if (existing && normalizeStoredEmail(existing.email) === email) {
        const nextAttemptAt = new Date(
          new Date(existing.lastAttemptedAt).getTime() + (cooldownSeconds * 1000)
        )

        if (nextAttemptAt > now) {
          const error = createHttpError(
            429,
            'Un nouvel envoi sera possible dans quelques instants.'
          )
          error.retryAfterSeconds = Math.ceil(
            (nextAttemptAt.getTime() - now.getTime()) / 1000
          )
          throw error
        }
      }

      const conflict = await findEmailConflict(transaction, {
        email,
        purpose: normalizedPurpose,
        userId,
        verificationId: existing?.id
      })

      if (conflict) {
        throw createHttpError(409, 'Cette adresse email est déjà utilisée ou réservée.')
      }

      if (existing) {
        await transaction.userEmailVerification.update({
          where: {id: existing.id},
          data: terminalData(EMAIL_VERIFICATION_STATUSES.SUPERSEDED, now)
        })
      }

      const verification = await transaction.userEmailVerification.create({
        data: {
          id: randomUUID(),
          userId,
          purpose: normalizedPurpose,
          status: EMAIL_VERIFICATION_STATUSES.PENDING,
          email,
          primaryEmailSnapshot: user.email,
          tokenHash,
          createdAt: now,
          lastAttemptedAt: now,
          sentAt: null,
          expiresAt,
          verifiedAt: null,
          cancelledAt: null
        }
      })

      return {
        verification,
        user,
        token,
        tokenHash,
        superseded: Boolean(existing && isActiveStatus(existing.status)),
        securityNotificationRecipients: getSecurityNotificationRecipients(user)
      }
    }, {isolationLevel: Prisma.TransactionIsolationLevel.Serializable})
  } catch (error) {
    if (isConstraintConflict(error) || isSerializationConflict(error)) {
      throw createHttpError(409, 'Cette adresse email est déjà utilisée ou réservée.')
    }

    throw error
  }
}

export async function resendEmailVerification(userId, verificationId, {
  allowImpersonatedSession = false,
  client = prisma,
  lockUser = lockUserForEmailVerification,
  now = new Date(),
  sessionToken = null,
  validateSession = requireActiveUserSession,
  ttlSeconds = EMAIL_VERIFICATION_TTL_SECONDS,
  cooldownSeconds = EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS
} = {}) {
  const token = generateUserEmailVerificationToken()
  const tokenHash = hashUserEmailVerificationToken(token)

  try {
    return await client.$transaction(async transaction => {
      if (!await lockUser(userId, {client: transaction})) {
        throw createHttpError(404, 'Utilisateur introuvable.')
      }

      if (sessionToken) {
        await validateSession(userId, sessionToken, {
          allowImpersonated: allowImpersonatedSession,
          client: transaction,
          now
        })
      }

      const user = await getActiveUser(userId, transaction)
      if (!user) {
        throw createHttpError(404, 'Utilisateur introuvable.')
      }

      const verification = await transaction.userEmailVerification.findFirst({
        where: {
          id: verificationId,
          userId
        }
      })

      if (!verification) {
        throw createHttpError(404, 'Demande de validation email introuvable.')
      }

      if (verification.status === EMAIL_VERIFICATION_STATUSES.EXPIRED) {
        return buildVerificationOutcome('EXPIRED', verification)
      }

      if (isExpired(verification, now)) {
        const expired = await transaction.userEmailVerification.update({
          where: {id: verification.id},
          data: terminalData(EMAIL_VERIFICATION_STATUSES.EXPIRED, now)
        })

        return buildVerificationOutcome('EXPIRED', expired)
      }

      if (!isActiveStatus(verification.status)) {
        return {outcome: 'NOT_ACTIVE', verification}
      }

      if (verification.purpose === EMAIL_VERIFICATION_PURPOSES.PRIMARY_CHANGE
        && normalizeStoredEmail(user.email)
        !== normalizeStoredEmail(verification.primaryEmailSnapshot)) {
        const conflictVerification = await transaction.userEmailVerification.update({
          where: {id: verification.id},
          data: terminalData(EMAIL_VERIFICATION_STATUSES.CONFLICT, now)
        })

        return buildVerificationOutcome('CONFLICT', conflictVerification)
      }

      const nextAttemptAt = new Date(
        new Date(verification.lastAttemptedAt).getTime() + (cooldownSeconds * 1000)
      )
      if (nextAttemptAt > now) {
        return {
          outcome: 'COOLDOWN',
          verification,
          retryAfterSeconds: Math.ceil((nextAttemptAt.getTime() - now.getTime()) / 1000)
        }
      }

      await expireDueEmailVerifications(transaction, now, {
        email: verification.email
      })

      const conflict = await findEmailConflict(transaction, {
        email: verification.email,
        purpose: verification.purpose,
        userId,
        verificationId: verification.id
      })

      if (conflict) {
        const conflictVerification = await transaction.userEmailVerification.update({
          where: {id: verification.id},
          data: terminalData(EMAIL_VERIFICATION_STATUSES.CONFLICT, now)
        })

        return buildVerificationOutcome('CONFLICT', conflictVerification)
      }

      const updated = await transaction.userEmailVerification.update({
        where: {id: verification.id},
        data: {
          status: EMAIL_VERIFICATION_STATUSES.PENDING,
          tokenHash,
          lastAttemptedAt: now,
          sentAt: null,
          expiresAt: new Date(now.getTime() + (ttlSeconds * 1000)),
          verifiedAt: null,
          cancelledAt: null
        }
      })

      return {
        outcome: 'ISSUED',
        verification: updated,
        user,
        token,
        tokenHash
      }
    }, {isolationLevel: Prisma.TransactionIsolationLevel.Serializable})
  } catch (error) {
    if (isConstraintConflict(error) || isSerializationConflict(error)) {
      throw createHttpError(409, 'Cette adresse email est déjà utilisée ou réservée.')
    }

    throw error
  }
}

export async function recordEmailVerificationDelivery(
  verificationId,
  tokenHash,
  delivered,
  {
    client = prisma,
    now = new Date()
  } = {}
) {
  await client.userEmailVerification.updateMany({
    where: {
      id: verificationId,
      tokenHash,
      status: EMAIL_VERIFICATION_STATUSES.PENDING
    },
    data: delivered
      ? {
        status: EMAIL_VERIFICATION_STATUSES.PENDING,
        sentAt: now
      }
      : {
        status: EMAIL_VERIFICATION_STATUSES.SEND_FAILED
      }
  })

  return client.userEmailVerification.findUnique({
    where: {id: verificationId}
  })
}

export async function cancelEmailVerification(userId, verificationId, {
  allowImpersonatedSession = false,
  client = prisma,
  lockUser = lockUserForEmailVerification,
  now = new Date(),
  sessionToken = null,
  validateSession = requireActiveUserSession
} = {}) {
  return client.$transaction(async transaction => {
    if (!await lockUser(userId, {client: transaction})) {
      throw createHttpError(404, 'Utilisateur introuvable.')
    }

    if (sessionToken) {
      await validateSession(userId, sessionToken, {
        allowImpersonated: allowImpersonatedSession,
        client: transaction,
        now
      })
    }

    const verification = await transaction.userEmailVerification.findFirst({
      where: {
        id: verificationId,
        userId
      }
    })

    if (!verification) {
      throw createHttpError(404, 'Demande de validation email introuvable.')
    }

    if (isExpired(verification, now)) {
      return transaction.userEmailVerification.update({
        where: {id: verification.id},
        data: terminalData(EMAIL_VERIFICATION_STATUSES.EXPIRED, now)
      })
    }

    if (!isActiveStatus(verification.status)) {
      throw createHttpError(409, 'Cette demande de validation email n’est plus active.')
    }

    return transaction.userEmailVerification.update({
      where: {id: verification.id},
      data: terminalData(EMAIL_VERIFICATION_STATUSES.CANCELLED, now)
    })
  })
}

export async function synchronizeDeclarantPrimaryContactEmail(client, {
  userId,
  previousEmail,
  newEmail
}) {
  const declarant = await client.declarant.findUnique({
    where: {userId},
    select: {userId: true}
  })

  if (!declarant) {
    return
  }

  const normalizedPreviousEmail = normalizeStoredEmail(previousEmail)
  const normalizedNewEmail = normalizeStoredEmail(newEmail)
  const contacts = await client.declarantContactEmail.findMany({
    where: {declarantUserId: userId},
    select: {
      id: true,
      email: true,
      isPrimary: true,
      createdAt: true
    }
  })

  const targetContact = contacts.find(contact =>
    normalizeStoredEmail(contact.email) === normalizedNewEmail)
  const previousContact = contacts.find(contact =>
    normalizeStoredEmail(contact.email) === normalizedPreviousEmail)
  const formerPrimary = contacts.find(contact => contact.isPrimary)

  await client.declarantContactEmail.updateMany({
    where: {
      declarantUserId: userId,
      isPrimary: true
    },
    data: {isPrimary: false}
  })

  if (previousContact && previousContact.id !== targetContact?.id) {
    await client.declarantContactEmail.delete({
      where: {id: previousContact.id}
    })
  }

  if (targetContact) {
    await client.declarantContactEmail.update({
      where: {id: targetContact.id},
      data: {isPrimary: true}
    })
    return
  }

  const remainingContacts = contacts.filter(contact =>
    contact.id !== previousContact?.id)

  if (!normalizedNewEmail) {
    const nextPrimary = remainingContacts.find(contact =>
      contact.id === formerPrimary?.id) ?? [...remainingContacts]
      .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt))[0]

    if (nextPrimary) {
      await client.declarantContactEmail.update({
        where: {id: nextPrimary.id},
        data: {isPrimary: true}
      })
    }

    return
  }

  if (remainingContacts.length >= MAX_DECLARANT_CONTACT_EMAILS) {
    const contactsToReplaceCount = remainingContacts.length
      - MAX_DECLARANT_CONTACT_EMAILS + 1
    const contactsToReplace = [...remainingContacts]
      .sort((left, right) => {
        if (left.id === formerPrimary?.id) {
          return -1
        }

        if (right.id === formerPrimary?.id) {
          return 1
        }

        return new Date(left.createdAt) - new Date(right.createdAt)
      })
      .slice(0, contactsToReplaceCount)

    await client.declarantContactEmail.deleteMany({
      where: {
        id: {in: contactsToReplace.map(contact => contact.id)}
      }
    })
  }

  await client.declarantContactEmail.create({
    data: {
      id: randomUUID(),
      declarantUserId: userId,
      email: normalizedNewEmail,
      isPrimary: true
    }
  })
}

async function markVerificationConflictByTokenHash(client, tokenHash, now) {
  const candidate = await client.userEmailVerification.findUnique({
    where: {tokenHash},
    select: {id: true}
  })

  if (!candidate) {
    return null
  }

  const update = await client.userEmailVerification.updateMany({
    where: {
      id: candidate.id,
      tokenHash,
      status: {in: ACTIVE_STATUSES}
    },
    data: terminalData(EMAIL_VERIFICATION_STATUSES.CONFLICT, now)
  })

  if (update.count === 0) {
    return null
  }

  return client.userEmailVerification.findUnique({
    where: {id: candidate.id}
  })
}

export async function consumeEmailVerification(rawToken, {
  client = prisma,
  lockUser = lockUserForEmailVerification,
  now = new Date(),
  serializationRetries = 2
} = {}) {
  if (typeof rawToken !== 'string' || rawToken.length < 32 || rawToken.length > 512) {
    return {outcome: 'INVALID'}
  }

  const tokenHash = hashUserEmailVerificationToken(rawToken)

  try {
    return await client.$transaction(async transaction => {
      const candidate = await transaction.userEmailVerification.findUnique({
        where: {tokenHash},
        select: {id: true, userId: true}
      })

      if (!candidate
        || !await lockUser(candidate.userId, {client: transaction})) {
        return {outcome: 'INVALID'}
      }

      const verification = await transaction.userEmailVerification.findUnique({
        where: {tokenHash}
      })

      if (!verification) {
        return {outcome: 'INVALID'}
      }

      if (verification.status === EMAIL_VERIFICATION_STATUSES.VERIFIED) {
        if (new Date(verification.expiresAt) <= now) {
          return {outcome: 'INVALID'}
        }

        const currentUser = await getActiveUser(verification.userId, transaction)
        const stillVerified = verification.purpose
          === EMAIL_VERIFICATION_PURPOSES.PRIMARY_CHANGE
          ? normalizeStoredEmail(currentUser?.email)
          === normalizeStoredEmail(verification.email)
          : currentUser?.emailAliases.some(alias =>
            normalizeStoredEmail(alias.email)
            === normalizeStoredEmail(verification.email))

        if (!stillVerified) {
          return {outcome: 'INVALID'}
        }

        return buildVerificationOutcome('VERIFIED', verification, {
          replayed: true,
          authTokensRevoked: 0,
          passwordActivationsRevoked: 0,
          sessionsRevoked: 0,
          securityNotificationRecipients: []
        })
      }

      if (isExpired(verification, now)) {
        const expired = await transaction.userEmailVerification.update({
          where: {id: verification.id},
          data: terminalData(EMAIL_VERIFICATION_STATUSES.EXPIRED, now)
        })

        return buildVerificationOutcome('EXPIRED', expired)
      }

      if (!isActiveStatus(verification.status)) {
        return {outcome: 'INVALID'}
      }

      const user = await getActiveUser(verification.userId, transaction)
      if (!user) {
        const conflictVerification = await transaction.userEmailVerification.update({
          where: {id: verification.id},
          data: terminalData(EMAIL_VERIFICATION_STATUSES.CONFLICT, now)
        })
        return buildVerificationOutcome('CONFLICT', conflictVerification)
      }

      if (verification.purpose === EMAIL_VERIFICATION_PURPOSES.PRIMARY_CHANGE
        && normalizeStoredEmail(user.email)
        !== normalizeStoredEmail(verification.primaryEmailSnapshot)) {
        const conflictVerification = await transaction.userEmailVerification.update({
          where: {id: verification.id},
          data: terminalData(EMAIL_VERIFICATION_STATUSES.CONFLICT, now)
        })
        return buildVerificationOutcome('CONFLICT', conflictVerification)
      }

      await expireDueEmailVerifications(transaction, now, {
        email: verification.email,
        id: {not: verification.id}
      })

      const conflict = await findEmailConflict(transaction, {
        email: verification.email,
        purpose: verification.purpose,
        userId: verification.userId,
        verificationId: verification.id
      })

      if (conflict) {
        const conflictVerification = await transaction.userEmailVerification.update({
          where: {id: verification.id},
          data: terminalData(EMAIL_VERIFICATION_STATUSES.CONFLICT, now)
        })
        return buildVerificationOutcome('CONFLICT', conflictVerification)
      }

      const verified = await transaction.userEmailVerification.update({
        where: {id: verification.id},
        data: terminalData(EMAIL_VERIFICATION_STATUSES.VERIFIED, now)
      })

      if (verification.purpose === EMAIL_VERIFICATION_PURPOSES.ALIAS_ADD) {
        const existingAlias = user.emailAliases.find(alias =>
          normalizeStoredEmail(alias.email) === normalizeStoredEmail(verification.email))

        if (!existingAlias) {
          await transaction.userEmailAlias.create({
            data: {
              id: randomUUID(),
              userId: verification.userId,
              email: verification.email
            }
          })
        }

        return {
          outcome: 'VERIFIED',
          verification: verified,
          user,
          userId: verification.userId,
          purpose: verification.purpose,
          email: verification.email,
          authTokensRevoked: 0,
          passwordActivationsRevoked: 0,
          sessionsRevoked: 0,
          securityNotificationRecipients: []
        }
      }

      await transaction.userEmailVerification.updateMany({
        where: {
          userId: verification.userId,
          id: {not: verification.id},
          status: {in: ACTIVE_STATUSES}
        },
        data: terminalData(EMAIL_VERIFICATION_STATUSES.SUPERSEDED, now)
      })

      const previousEmail = user.email
      const targetAlias = user.emailAliases.find(alias =>
        normalizeStoredEmail(alias.email) === normalizeStoredEmail(verification.email))

      if (targetAlias) {
        await transaction.userEmailAlias.delete({
          where: {id: targetAlias.id}
        })
      }

      await transaction.user.update({
        where: {id: verification.userId},
        data: {email: verification.email}
      })

      await synchronizeDeclarantPrimaryContactEmail(transaction, {
        userId: verification.userId,
        previousEmail,
        newEmail: verification.email
      })

      const [authTokens, passwordActivations, sessions] = await Promise.all([
        transaction.authToken.deleteMany({
          where: {userId: verification.userId}
        }),
        transaction.passwordActivation.deleteMany({
          where: {userId: verification.userId}
        }),
        transaction.sessionToken.deleteMany({
          where: getSessionTokensWhere(verification.userId)
        })
      ])

      return {
        outcome: 'VERIFIED',
        verification: verified,
        user,
        userId: verification.userId,
        purpose: verification.purpose,
        email: verification.email,
        previousEmail,
        authTokensRevoked: authTokens.count,
        passwordActivationsRevoked: passwordActivations.count,
        sessionsRevoked: sessions.count,
        securityNotificationRecipients: getSecurityNotificationRecipients(user)
      }
    }, {isolationLevel: Prisma.TransactionIsolationLevel.Serializable})
  } catch (error) {
    if (isSerializationConflict(error)) {
      if (serializationRetries > 0) {
        return consumeEmailVerification(rawToken, {
          client,
          lockUser,
          now,
          serializationRetries: serializationRetries - 1
        })
      }

      throw createHttpError(
        503,
        'La validation est temporairement indisponible. Veuillez réessayer.'
      )
    }

    if (!isConstraintConflict(error)) {
      throw error
    }

    const verification = await markVerificationConflictByTokenHash(
      client,
      tokenHash,
      now
    )

    return verification
      ? buildVerificationOutcome('CONFLICT', verification)
      : {outcome: 'INVALID'}
  }
}
