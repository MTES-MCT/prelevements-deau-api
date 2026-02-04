import {getSessionByToken} from '../models/session-token.js'
import {getUserById} from '../models/user.js'

export async function authenticateByToken(token) {
  const session = await getSessionByToken(token)

  if (!session) {
    return null
  }

  const user = await getUserById(session.userId)

  if (!user) {
    return null
  }

  return {
    user,
    role: session.role
  }
}
