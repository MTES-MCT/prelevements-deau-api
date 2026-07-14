import {
  getActivePermissionCodesForUser,
  getActiveZoneAssignmentsForUser
} from '../services/zone-permissions.js'

export async function getInfoHandler(req, res) {
  const {auth, user, userRole: role} = req

  const response = {role}

  if (!user) {
    return res.send(response)
  }

  const emailAliases = (user.emailAliases ?? []).map(alias => ({
    id: alias.id,
    email: alias.email,
    createdAt: alias.createdAt,
    updatedAt: alias.updatedAt
  }))

  const baseUser = {
    id: user.id,
    email: user.email,
    emailAliases,
    lastName: user.lastName,
    firstName: user.firstName,
    lastLoginAt: user.lastLoginAt
  }

  if (role === 'DECLARANT' && user.declarant) {
    Object.assign(baseUser, {
      declarantType: user.declarant.declarantType,
      declarantRole: user.declarant.declarantRole,
      socialReason: user.declarant.socialReason,
      civility: user.declarant.civility,
      addressLine1: user.declarant.addressLine1,
      addressLine2: user.declarant.addressLine2,
      poBox: user.declarant.poBox,
      postalCode: user.declarant.postalCode,
      city: user.declarant.city,
      phoneNumber: user.declarant.phoneNumber
    })
  }

  response.user = baseUser

  if (role === 'INSTRUCTOR' || role === 'ADMIN') {
    const [permissions, zoneAssignments] = await Promise.all([
      getActivePermissionCodesForUser(user),
      getActiveZoneAssignmentsForUser(user)
    ])

    response.permissions = permissions
    response.zoneAssignments = zoneAssignments
  }

  if (auth?.impersonation) {
    response.impersonation = {
      active: true,
      startedAt: auth.impersonation.startedAt,
      actor: auth.impersonation.actor,
      target: {
        id: baseUser.id,
        email: baseUser.email,
        firstName: baseUser.firstName,
        lastName: baseUser.lastName,
        role
      }
    }
  }

  res.send(response)
}
