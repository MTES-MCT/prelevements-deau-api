import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {normalizeEmail} from '../util/email.js'
import {randomUUID} from "node:crypto";

export async function getUserByEmail(email) {
  const normalized = normalizeEmail(email)

  return prisma.user.findUnique({
    where: {email: normalized},
    include: {
      declarant: true,
      instructor: true,
    }
  })
}

export async function getUserById(userId) {
  return prisma.user.findUnique({
    where: {id: userId},
    include: {
      declarant: true,
      instructor: true,
    }
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

export async function deleteUser(userId) {
  // suppression physique
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
