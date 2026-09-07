import {getActivePermissionCodesForUser} from '../services/zone-permissions.js'
import {serializeUserProfile} from '../services/user-profile.js'
import {listUserEmailVerifications} from '../services/user-email-verifications.js'

export function createGetInfoHandler({
  getEmailVerifications = listUserEmailVerifications,
  getPermissions = getActivePermissionCodesForUser
} = {}) {
  return async (req, res) => {
    const {auth, user, userRole: role} = req

    const response = {
      role,
      ...(auth?.type === 'USER_SESSION' && auth.expiresAt
        ? {expiresAt: auth.expiresAt}
        : {})
    }

    if (!user) {
      return res.send(response)
    }

    const baseUser = serializeUserProfile(user, role)
    baseUser.emailVerifications = await getEmailVerifications(user.id)

    response.user = baseUser

    if (role === 'INSTRUCTOR' || role === 'ADMIN') {
      response.permissions = await getPermissions(user)
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
}

export const getInfoHandler = createGetInfoHandler()
