import {randomUUID} from 'node:crypto'
import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {normalizeEmail} from '../util/email.js'
import {requireActiveUserSession} from './session-token.js'

export function normalizeEmailAliases(emailAliases = [], primaryEmail) {
  if (!Array.isArray(emailAliases)) {
    throw createHttpError(400, 'Les emails alternatifs doivent être fournis dans un tableau.')
  }

  const normalizedPrimaryEmail = primaryEmail ? normalizeEmail(primaryEmail) : null
  const seen = new Set()
  const normalizedAliases = []

  for (const email of emailAliases) {
    const normalized = normalizeEmail(email)

    if (normalizedPrimaryEmail && normalized === normalizedPrimaryEmail) {
      throw createHttpError(409, 'Un email alternatif ne peut pas être identique à l’email primaire.')
    }

    if (seen.has(normalized)) {
      throw createHttpError(409, 'Un email alternatif est présent plusieurs fois.')
    }

    seen.add(normalized)
    normalizedAliases.push(normalized)
  }

  return normalizedAliases
}

export function buildUserEmailAliasCreateManyData(userId, emailAliases) {
  return emailAliases.map(email => ({
    id: randomUUID(),
    userId,
    email
  }))
}

export function isEmailAliasConflictError(error) {
  const message = [
    error?.message,
    error?.meta?.database_error,
    error?.cause?.message
  ].filter(Boolean).join(' ')

  return error?.code === 'P2002'
    || message.includes('UserEmailAlias_email_not_primary')
    || message.includes('UserEmailAlias_email_reserved')
    || message.includes('User_email_not_alias')
    || message.includes('User_email_reserved')
    || message.includes('UserEmailIdentity_compatible_claims_check')
}

async function ensureActiveUser(userId, {client = prisma, lock = false} = {}) {
  let user

  if (lock === 'update') {
    const users = await client.$queryRaw`
      SELECT "id", "email"
      FROM "User"
      WHERE "id" = ${userId}::uuid
        AND "deletedAt" IS NULL
      FOR UPDATE
    `
    user = users[0]
  } else if (lock) {
    const users = await client.$queryRaw`
      SELECT "id", "email"
      FROM "User"
      WHERE "id" = ${userId}::uuid
        AND "deletedAt" IS NULL
      FOR SHARE
    `
    user = users[0]
  } else {
    user = await client.user.findFirst({
      where: {id: userId, deletedAt: null},
      select: {
        id: true,
        email: true
      }
    })
  }

  if (!user) {
    throw createHttpError(404, 'Utilisateur introuvable.')
  }

  return user
}

export async function listUserEmailAliases(userId) {
  await ensureActiveUser(userId)

  return prisma.userEmailAlias.findMany({
    where: {userId},
    orderBy: {createdAt: 'asc'}
  })
}

export async function createUserEmailAlias(userId, email, {client = prisma} = {}) {
  try {
    return await client.$transaction(async tx => {
      const user = await ensureActiveUser(userId, {client: tx, lock: 'update'})
      const normalizedEmail = normalizeEmail(email)

      if (normalizedEmail === user.email) {
        throw createHttpError(409, 'Un email alternatif ne peut pas être identique à l’email primaire.')
      }

      await tx.userEmailVerification.updateMany({
        where: {
          userId,
          email: normalizedEmail,
          status: {in: ['PENDING', 'SEND_FAILED']}
        },
        data: {
          status: 'SUPERSEDED',
          tokenHash: null
        }
      })

      return tx.userEmailAlias.create({
        data: {
          id: randomUUID(),
          userId,
          email: normalizedEmail
        }
      })
    })
  } catch (error) {
    if (isEmailAliasConflictError(error)) {
      throw createHttpError(409, 'Cet email est déjà utilisé.')
    }

    throw error
  }
}

async function deleteOwnedEmailAlias(client, userId, emailAliasId) {
  const alias = await client.userEmailAlias.findFirst({
    where: {
      id: emailAliasId,
      userId
    },
    select: {
      id: true,
      email: true
    }
  })

  if (!alias) {
    throw createHttpError(404, 'Email alternatif introuvable.')
  }

  await client.userEmailVerification.updateMany({
    where: {
      userId,
      email: alias.email,
      status: {in: ['PENDING', 'SEND_FAILED']}
    },
    data: {
      status: 'SUPERSEDED',
      tokenHash: null
    }
  })

  return client.userEmailAlias.delete({
    where: {id: emailAliasId}
  })
}

export async function deleteUserEmailAlias(
  userId,
  emailAliasId,
  {
    allowImpersonatedSession = false,
    client = prisma,
    requireRemainingLogin = false,
    sessionToken = null,
    validateSession = requireActiveUserSession
  } = {}
) {
  return client.$transaction(async transaction => {
    const user = await ensureActiveUser(userId, {
      client: transaction,
      lock: 'update'
    })

    if (sessionToken) {
      await validateSession(userId, sessionToken, {
        allowImpersonated: allowImpersonatedSession,
        client: transaction
      })
    }

    if (requireRemainingLogin && !user.email) {
      const aliasCount = await transaction.userEmailAlias.count({
        where: {userId}
      })

      if (aliasCount <= 1) {
        throw createHttpError(
          409,
          'Vous devez conserver au moins une adresse permettant de vous connecter.'
        )
      }
    }

    const alias = await deleteOwnedEmailAlias(
      transaction,
      userId,
      emailAliasId
    )

    await transaction.authToken.deleteMany({where: {userId}})

    return alias
  })
}
