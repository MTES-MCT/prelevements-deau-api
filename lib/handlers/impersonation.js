import createHttpError from 'http-errors'
import {getUserById} from '../models/user.js'
import {createSessionToken, deleteSessionToken} from '../models/session-token.js'

function serializeUser(user, role = user?.role) {
  if (!user) {
    return null
  }

  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role
  }
}

export async function startAdminImpersonationHandler(req, res) {
  const {userId} = req.body

  if (req.auth?.impersonation) {
    throw createHttpError(400, 'Arrêtez l’impersonation en cours avant d’en démarrer une nouvelle.')
  }

  if (!userId) {
    throw createHttpError(400, 'userId est requis.')
  }

  if (userId === req.user.id) {
    throw createHttpError(400, 'Vous ne pouvez pas prendre la place de votre propre compte.')
  }

  const targetUser = await getUserById(userId)

  if (!targetUser || targetUser.deletedAt) {
    throw createHttpError(404, 'Utilisateur introuvable.')
  }

  const session = await createSessionToken(
    targetUser.id,
    targetUser.role,
    undefined,
    {
      impersonatedByUserId: req.user.id,
      impersonatedByRole: req.userRole
    }
  )

  res.status(201).send({
    success: true,
    token: session.token,
    expiresAt: session.expiresAt,
    impersonation: {
      active: true,
      startedAt: session.createdAt,
      actor: serializeUser(req.user, req.userRole),
      target: serializeUser(targetUser, targetUser.role)
    }
  })
}

export async function stopAdminImpersonationHandler(req, res) {
  const impersonation = req.auth?.impersonation

  if (!impersonation?.actor?.id) {
    throw createHttpError(400, 'Aucune impersonation active.')
  }

  const actorUser = await getUserById(impersonation.actor.id)

  if (!actorUser || actorUser.deletedAt) {
    throw createHttpError(404, 'Utilisateur initial introuvable.')
  }

  const session = await createSessionToken(
    actorUser.id,
    impersonation.actor.role ?? actorUser.role
  )

  if (req.authToken) {
    await deleteSessionToken(req.authToken)
  }

  res.status(200).send({
    success: true,
    token: session.token,
    expiresAt: session.expiresAt,
    user: serializeUser(actorUser, session.role)
  })
}
