import {getTokenEntry} from '../models/token.js'
import {getTerritoire} from '../models/territoire.js'
import {getSessionByToken} from '../models/session-token.js'
import {getUserById} from '../models/user.js'

async function getTerritoireAndRoleByToken(token) {
  const entry = await getTokenEntry(token)

  if (!entry) {
    return null
  }

  const territoire = await getTerritoire(entry.territoire)

  if (!territoire) {
    return null
  }

  return {
    territoire,
    role: entry.role || 'reader'
  }
}

export async function authenticateByToken(token) {
  // Essayer d'abord avec un session token
  const session = await getSessionByToken(token)

  if (session) {
    const user = await getUserById(session.userId)

    if (!user) {
      return null
    }

    const territoire = await getTerritoire(session.territoire)

    if (!territoire) {
      return null
    }

    return {
      user,
      territoire,
      userRole: session.role,
      isAdmin: session.role === 'editor'
    }
  }

  // Fallback sur les tokens legacy
  const result = await getTerritoireAndRoleByToken(token)

  if (!result) {
    return null
  }

  return {
    user: null,
    territoire: result.territoire,
    userRole: result.role,
    isAdmin: result.role === 'editor'
  }
}
