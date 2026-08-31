import {randomUUID} from 'node:crypto'

import {Prisma} from '@prisma/client'
import createHttpError from 'http-errors'

import {prisma} from '../../db/prisma.js'
import {normalizeEmail} from '../util/email.js'

const userInclude = {
  declarant: true,
  instructor: true,
  emailAliases: {
    orderBy: {createdAt: 'asc'}
  }
}

const authUserSelect = {
  id: true,
  email: true,
  role: true,
  authVersion: true
}

export async function getAuthUserByEmail(email, {client = prisma} = {}) {
  const normalized = normalizeEmail(email)

  const user = await client.user.findFirst({
    where: {
      email: normalized,
      deletedAt: null
    },
    select: authUserSelect
  })

  if (user) {
    return user
  }

  const alias = await client.userEmailAlias.findFirst({
    where: {
      email: normalized,
      user: {deletedAt: null}
    },
    select: {
      user: {
        select: authUserSelect
      }
    }
  })

  return alias?.user ?? null
}

export async function getUserByEmail(email, {client = prisma} = {}) {
  const normalized = normalizeEmail(email)

  const user = await client.user.findFirst({
    where: {
      email: normalized,
      deletedAt: null
    },
    include: userInclude
  })

  if (user) {
    return user
  }

  const alias = await client.userEmailAlias.findFirst({
    where: {
      email: normalized,
      user: {deletedAt: null}
    },
    include: {
      user: {
        include: userInclude
      }
    }
  })

  return alias?.user ?? null
}

export async function getUserById(userId, {client = prisma} = {}) {
  return client.user.findUnique({
    where: {id: userId},
    include: userInclude
  })
}

export async function lockActiveUser(userId, {client = prisma} = {}) {
  const users = await client.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "User"
    WHERE "id" = ${userId}::uuid
      AND "deletedAt" IS NULL
    FOR UPDATE
  `)

  return users.length === 1
}

export async function insertUser(user) {
  const email = normalizeEmail(user.email, {required: false})
  const role = user.role ?? 'DECLARANT'

  try {
    return await prisma.user.create({
      data: {
        id: randomUUID(),
        email,
        role,
        firstName: user.firstName ?? null,
        lastName: user.lastName ?? null
      }
    })
  } catch (error) {
    if (error?.code === 'P2002') {
      throw createHttpError(400, 'Cet email est déjà utilisé')
    }

    throw error
  }
}

export async function updateUserById(userId, changes) {
  if (!changes || typeof changes !== 'object') {
    throw createHttpError(400, 'Les modifications doivent être un objet.')
  }

  const {
    email,
    role,
    id,
    authVersion,
    createdAt,
    updatedAt,
    ...allowedChanges
  } = changes

  try {
    return await prisma.user.update({
      where: {id: userId},
      data: {
        ...allowedChanges
      }
    })
  } catch (error) {
    if (error?.code === 'P2025') {
      throw createHttpError(404, 'Utilisateur introuvable.')
    }

    throw error
  }
}

export async function updateLastLoginAt(userId, {client = prisma, now = new Date()} = {}) {
  return client.user.update({
    where: {id: userId},
    data: {lastLoginAt: now}
  })
}

export async function deleteUser(userId) {
  // Suppression physique
  try {
    return await prisma.user.delete({
      where: {id: userId}
    })
  } catch (error) {
    if (error?.code === 'P2025') {
      throw createHttpError(404, 'Utilisateur introuvable')
    }

    throw error
  }
}
