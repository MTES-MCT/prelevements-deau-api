import createHttpError from 'http-errors'

import {prisma} from '../../db/prisma.js'
import {serializeUserEmailVerification} from '../models/user-email-verification.js'
import {requireActiveUserSession} from '../models/session-token.js'
import {lockActiveUser} from '../models/user.js'
import {validateUserProfileChanges} from '../validation/user-profile-validation.js'

const USER_PROFILE_INCLUDE = {
  declarant: true,
  instructor: true,
  emailAliases: {
    orderBy: {createdAt: 'asc'}
  },
  emailVerifications: {
    distinct: ['purpose'],
    orderBy: {createdAt: 'desc'}
  }
}

const COMMON_FIELDS = new Set(['firstName', 'lastName'])
const DECLARANT_FIELDS = new Set([
  'civility',
  'phoneNumber',
  'jobTitle',
  'socialReason',
  'addressLine1',
  'addressLine2',
  'poBox',
  'postalCode',
  'city'
])
const INSTRUCTOR_FIELDS = new Set(['phoneNumber', 'jobTitle'])

function selectChanges(changes, fields) {
  return Object.fromEntries(
    Object.entries(changes).filter(([field]) => fields.has(field))
  )
}

function serializeEmailAliases(emailAliases = []) {
  return emailAliases.map(alias => ({
    id: alias.id,
    email: alias.email,
    createdAt: alias.createdAt,
    updatedAt: alias.updatedAt
  }))
}

export function serializeUserProfile(user, role = user?.role) {
  if (!user) {
    return null
  }

  const profile = {
    id: user.id,
    email: user.email,
    emailAliases: serializeEmailAliases(user.emailAliases),
    emailVerifications: (user.emailVerifications ?? [])
      .map(verification => serializeUserEmailVerification(verification)),
    lastName: user.lastName,
    firstName: user.firstName,
    lastLoginAt: user.lastLoginAt
  }

  if (role === 'DECLARANT' && user.declarant) {
    Object.assign(profile, {
      declarantType: user.declarant.declarantType,
      declarantRole: user.declarant.declarantRole,
      preleveurType: user.declarant.preleveurType,
      socialReason: user.declarant.socialReason,
      civility: user.declarant.civility,
      addressLine1: user.declarant.addressLine1,
      addressLine2: user.declarant.addressLine2,
      poBox: user.declarant.poBox,
      postalCode: user.declarant.postalCode,
      city: user.declarant.city,
      phoneNumber: user.declarant.phoneNumber,
      jobTitle: user.declarant.jobTitle
    })
  }

  if (role === 'INSTRUCTOR' && user.instructor) {
    Object.assign(profile, {
      phoneNumber: user.instructor.phoneNumber,
      jobTitle: user.instructor.jobTitle
    })
  }

  return profile
}

function assertRoleProfile(user) {
  if (user.role === 'DECLARANT' && !user.declarant) {
    throw createHttpError(409, 'Le profil déclarant de ce compte est introuvable.')
  }

  if (user.role === 'INSTRUCTOR' && !user.instructor) {
    throw createHttpError(409, 'Le profil agent de ce compte est introuvable.')
  }
}

export async function updateCurrentUserProfile(userId, changes, {
  allowImpersonatedSession = false,
  client = prisma,
  lockUser = lockActiveUser,
  sessionToken = null,
  validateSession = requireActiveUserSession
} = {}) {
  return client.$transaction(async transaction => {
    if (sessionToken) {
      if (!await lockUser(userId, {client: transaction})) {
        throw createHttpError(404, 'Utilisateur introuvable.')
      }

      await validateSession(userId, sessionToken, {
        allowImpersonated: allowImpersonatedSession,
        client: transaction
      })
    }

    const currentUser = await transaction.user.findFirst({
      where: {
        id: userId,
        deletedAt: null
      },
      include: USER_PROFILE_INCLUDE
    })

    if (!currentUser) {
      throw createHttpError(404, 'Utilisateur introuvable.')
    }

    assertRoleProfile(currentUser)

    const value = validateUserProfileChanges(changes, currentUser)
    const userChanges = selectChanges(value, COMMON_FIELDS)
    const declarantChanges = currentUser.role === 'DECLARANT'
      ? selectChanges(value, DECLARANT_FIELDS)
      : {}
    const instructorChanges = currentUser.role === 'INSTRUCTOR'
      ? selectChanges(value, INSTRUCTOR_FIELDS)
      : {}
    const data = {
      ...userChanges,
      ...(Object.keys(declarantChanges).length > 0
        ? {declarant: {update: {data: declarantChanges}}}
        : {}),
      ...(Object.keys(instructorChanges).length > 0
        ? {instructor: {update: {data: instructorChanges}}}
        : {})
    }

    try {
      return await transaction.user.update({
        where: {
          id: userId,
          deletedAt: null
        },
        data,
        include: USER_PROFILE_INCLUDE
      })
    } catch (error) {
      if (error?.code === 'P2025') {
        throw createHttpError(404, 'Utilisateur introuvable.')
      }

      throw error
    }
  })
}
