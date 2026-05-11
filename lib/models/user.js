import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {normalizeEmail} from '../util/email.js'
import {randomUUID} from 'node:crypto'

const userInclude = {
  declarant: true,
  instructor: true,
  emailAliases: {
    orderBy: {createdAt: 'asc'}
  }
}

export async function getUserByEmail(email) {
  const normalized = normalizeEmail(email)

  const user = await prisma.user.findUnique({
    where: {email: normalized},
    include: userInclude
  })

  if (user) {
    return user
  }

  const alias = await prisma.userEmailAlias.findUnique({
    where: {email: normalized},
    include: {
      user: {
        include: userInclude
      }
    }
  })

  return alias?.user ?? null
}

export async function getUserById(userId) {
  return prisma.user.findUnique({
    where: {id: userId},
    include: userInclude
  })
}

export async function insertUser(user) {
  const email = normalizeEmail(user.email)

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

  const {email, role, id, createdAt, updatedAt, ...allowedChanges} = changes

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

export async function updateLastLoginAt(userId) {
  return updateUserById(userId, {lastLoginAt: new Date()})
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
