import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {getUserById, lockActiveUser} from '../models/user.js'
import {
  createSessionToken,
  deleteSessionToken,
  requireActiveUserSession
} from '../models/session-token.js'
import {setAuditSubject} from '../audit/context.js'

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

async function lockActiveUserQueue(transaction, userIds, locked) {
  const [userId, ...remainingUserIds] = userIds
  if (!userId) {
    return locked
  }

  const active = await lockActiveUser(userId, {client: transaction})
  locked.set(userId, active)
  return lockActiveUserQueue(transaction, remainingUserIds, locked)
}

function lockActiveUsers(transaction, userIds) {
  return lockActiveUserQueue(
    transaction,
    [...new Set(userIds)].sort(),
    new Map()
  )
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

  const {actorUser, session, targetUser} = await prisma.$transaction(async transaction => {
    const locked = await lockActiveUsers(transaction, [req.user.id, userId])
    if (!locked.get(req.user.id)) {
      throw createHttpError(401, 'Votre session n’est plus valide.')
    }

    if (!locked.get(userId)) {
      throw createHttpError(404, 'Utilisateur introuvable.')
    }

    await requireActiveUserSession(req.user.id, req.authToken, {
      client: transaction
    })

    const [currentActor, currentTarget] = await Promise.all([
      getUserById(req.user.id, {client: transaction}),
      getUserById(userId, {client: transaction})
    ])
    if (!currentActor || currentActor.deletedAt) {
      throw createHttpError(401, 'Votre session n’est plus valide.')
    }

    if (!currentTarget || currentTarget.deletedAt) {
      throw createHttpError(404, 'Utilisateur introuvable.')
    }

    const createdSession = await createSessionToken(
      currentTarget.id,
      currentTarget.role,
      undefined,
      {
        client: transaction,
        authVersion: currentTarget.authVersion,
        impersonatedByUserId: currentActor.id,
        impersonatedByRole: req.userRole,
        impersonatedByAuthVersion: currentActor.authVersion
      }
    )

    return {
      actorUser: currentActor,
      session: createdSession,
      targetUser: currentTarget
    }
  })

  setAuditSubject(req, targetUser)

  res.status(201).send({
    success: true,
    token: session.token,
    expiresAt: session.expiresAt,
    impersonation: {
      active: true,
      startedAt: session.createdAt,
      actor: serializeUser(actorUser, req.userRole),
      target: serializeUser(targetUser, targetUser.role)
    }
  })
}

export async function stopAdminImpersonationHandler(req, res) {
  const impersonation = req.auth?.impersonation

  if (!impersonation?.actor?.id) {
    throw createHttpError(400, 'Aucune impersonation active.')
  }

  const {actorUser, session} = await prisma.$transaction(async transaction => {
    const locked = await lockActiveUsers(transaction, [
      req.user.id,
      impersonation.actor.id
    ])
    if (!locked.get(req.user.id) || !locked.get(impersonation.actor.id)) {
      throw createHttpError(401, 'Votre session n’est plus valide.')
    }

    await requireActiveUserSession(req.user.id, req.authToken, {
      allowImpersonated: true,
      client: transaction,
      expectedImpersonatedByUserId: impersonation.actor.id
    })

    const currentActor = await getUserById(impersonation.actor.id, {
      client: transaction
    })
    if (!currentActor || currentActor.deletedAt) {
      throw createHttpError(404, 'Utilisateur initial introuvable.')
    }

    const createdSession = await createSessionToken(
      currentActor.id,
      impersonation.actor.role ?? currentActor.role,
      undefined,
      {
        authVersion: currentActor.authVersion,
        client: transaction
      }
    )

    await deleteSessionToken(req.authToken, {client: transaction})

    return {actorUser: currentActor, session: createdSession}
  })

  res.status(200).send({
    success: true,
    token: session.token,
    expiresAt: session.expiresAt,
    user: serializeUser(actorUser, session.role)
  })
}
