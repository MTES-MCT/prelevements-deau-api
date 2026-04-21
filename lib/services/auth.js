import {getSessionByToken} from '../models/session-token.js'
import {getUserById} from '../models/user.js'
import {getServiceAccountTokenByToken} from '../models/service-account-token.js'

export async function authenticateByToken(token) {
  const session = await getSessionByToken(token)

  if (session) {
    const user = await getUserById(session.userId)

    if (!user) {
      return null
    }

    return {
      type: 'USER_SESSION',
      user,
      role: session.role
    }
  }

  const serviceAccountToken = await getServiceAccountTokenByToken(token)

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

    if (!declarantUser) {
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
