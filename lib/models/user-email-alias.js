import {randomUUID} from 'node:crypto'
import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {normalizeEmail} from '../util/email.js'

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
  const message = String(error?.message ?? '')

  return error?.code === 'P2002'
    || message.includes('UserEmailAlias_email_not_primary')
    || message.includes('User_email_not_alias')
}

async function ensureActiveUser(userId, {client = prisma, lock = false} = {}) {
  let user

  if (lock) {
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
      const user = await ensureActiveUser(userId, {client: tx, lock: true})
      const normalizedEmail = normalizeEmail(email)

      if (normalizedEmail === user.email) {
        throw createHttpError(409, 'Un email alternatif ne peut pas être identique à l’email primaire.')
      }

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

export async function deleteUserEmailAlias(userId, emailAliasId) {
  const alias = await prisma.userEmailAlias.findFirst({
    where: {
      id: emailAliasId,
      userId
    },
    select: {id: true}
  })

  if (!alias) {
    throw createHttpError(404, 'Email alternatif introuvable.')
  }

  return prisma.userEmailAlias.delete({
    where: {id: emailAliasId}
  })
}
