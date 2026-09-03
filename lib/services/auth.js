import {getSessionByToken} from '../models/session-token.js'
import {getUserById} from '../models/user.js'
import {getServiceAccountTokenByToken} from '../models/service-account-token.js'

function isUnavailableUser(user) {
  return !user || Boolean(user.deletedAt)
}

function hasCurrentAuthVersion(sessionAuthVersion, user) {
  return Number.isInteger(sessionAuthVersion)
    && sessionAuthVersion >= 0
    && Number.isInteger(user.authVersion)
    && user.authVersion >= 0
    && sessionAuthVersion === user.authVersion
}

function isInvalidSessionUser(user, sessionAuthVersion) {
  return isUnavailableUser(user)
    || !hasCurrentAuthVersion(sessionAuthVersion, user)
}

function hasInvalidImpersonationActor(session, actor) {
  return Boolean(session.impersonatedByUserId)
    && isInvalidSessionUser(actor, session.impersonatedByAuthVersion)
}

export async function authenticateByToken(token, {
  getSessionByToken: findSessionByToken = getSessionByToken,
  getUserById: findUserById = getUserById,
  getServiceAccountTokenByToken: findServiceAccountTokenByToken = getServiceAccountTokenByToken
} = {}) {
  const session = await findSessionByToken(token)

  if (session) {
    const user = await findUserById(session.userId)

    if (isInvalidSessionUser(user, session.authVersion)) {
      return null
    }

    const actor = session.impersonatedByUserId
      ? await findUserById(session.impersonatedByUserId)
      : null

    if (hasInvalidImpersonationActor(session, actor)) {
      return null
    }

    const auth = {
      type: 'USER_SESSION',
      user,
      role: session.role,
      expiresAt: session.expiresAt
    }

    if (actor) {
      const actorPayload = {
        id: actor.id,
        email: actor.email,
        firstName: actor.firstName,
        lastName: actor.lastName,
        role: session.impersonatedByRole ?? actor.role
      }

      auth.actor = {
        type: 'USER',
        ...actorPayload
      }
      auth.impersonation = {
        actor: actorPayload,
        startedAt: session.createdAt
      }
    }

    return auth
  }

  const serviceAccountToken = await findServiceAccountTokenByToken(token)

  if (!serviceAccountToken) {
    return null
  }

  if (
    !serviceAccountToken.serviceAccount
    || !serviceAccountToken.serviceAccount.isActive
    || serviceAccountToken.serviceAccount.deletedAt
  ) {
    return null
  }

  if (serviceAccountToken.type === 'ACCESS') {
    return {
      type: 'SERVICE_ACCOUNT_ACCESS',
      role: 'SERVICE_ACCOUNT',
      user: {
        id: serviceAccountToken.serviceAccount.id,
        name: serviceAccountToken.serviceAccount.name
      },
      serviceAccount: serviceAccountToken.serviceAccount
    }
  }

  if (serviceAccountToken.type === 'IMPERSONATION') {
    const declarantUser = serviceAccountToken.declarant?.user

    if (isUnavailableUser(declarantUser)) {
      return null
    }

    return {
      type: 'SERVICE_ACCOUNT_IMPERSONATION',
      role: 'DECLARANT',
      user: declarantUser,
      serviceAccount: serviceAccountToken.serviceAccount,
      actor: {
        type: 'SERVICE_ACCOUNT',
        id: serviceAccountToken.serviceAccount.id,
        name: serviceAccountToken.serviceAccount.name
      }
    }
  }

  return null
}
