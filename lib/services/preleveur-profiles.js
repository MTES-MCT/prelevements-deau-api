import Joi from 'joi'
import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {getSessionByToken, createSessionToken} from '../models/session-token.js'
import {listPreleveurEmailProfiles, publicPreleveurProfile} from '../models/preleveur-login.js'
import {isDatabaseWriteConflict} from '../util/database-write-conflict.js'

async function scopedSession(token, client) {
  const session = await getSessionByToken(token, {client})
  if (!session) throw createHttpError(401, 'Votre session n’est plus valide. Reconnectez-vous.')
  if (!session.loginEmail || session.impersonatedByUserId || session.role !== 'DECLARANT') {
    throw createHttpError(403, 'Cette session ne permet pas de changer de préleveur.')
  }
  return session
}

export async function listAuthenticatedPreleveurs(token, {client = prisma} = {}) {
  const session = await scopedSession(token, client)
  const profiles = await listPreleveurEmailProfiles(session.loginEmail, {client})
  return {preleveurs: profiles.map(publicPreleveurProfile),
    currentPreleveurId: session.profileSelectionRequired ? null : session.profileUserId,
    selectionRequired: session.profileSelectionRequired}
}

export async function selectAuthenticatedPreleveur(token, payload, {client = prisma} = {}) {
  const validation = Joi.object({preleveurId: Joi.string().uuid().required()}).unknown(false).validate(payload)
  if (validation.error) throw createHttpError(400, 'Choisissez un préleveur valide.')
  const {preleveurId} = validation.value
  try {
    return await client.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "SessionToken" WHERE token = ${token} FOR UPDATE`
      const session = await scopedSession(token, tx)
      // Lock only identities that this verified address is currently entitled
      // to select; never disclose or lock arbitrary foreign accounts.
      let profiles = await listPreleveurEmailProfiles(session.loginEmail, {client: tx})
      if (!profiles.some(profile => profile.id === preleveurId)) throw createHttpError(403, 'Cette fiche n’est pas accessible avec votre adresse email.')
      await tx.$queryRaw`
        SELECT u.id FROM "User" u JOIN "Declarant" d ON d."userId" = u.id
        WHERE u.id IN (${session.userId}::uuid, ${preleveurId}::uuid)
        ORDER BY u.id FOR SHARE OF u, d
      `
      await scopedSession(token, tx)
      profiles = await listPreleveurEmailProfiles(session.loginEmail, {client: tx})
      const profile = profiles.find(item => item.id === preleveurId)
      if (!profile) throw createHttpError(403, 'Cette fiche n’est plus accessible avec votre adresse email.')
      const replacement = await createSessionToken(session.userId, 'DECLARANT', undefined, {
        client: tx, authVersion: session.authVersion, loginEmail: session.loginEmail,
        profileUserId: profile.id, profileAuthVersion: profile.authVersion,
        profileSelectionRequired: false, expiresAt: session.expiresAt
      })
      const removed = await tx.sessionToken.deleteMany({where: {id: session.id, token}})
      if (removed.count !== 1) throw createHttpError(409, 'La session a changé. Reconnectez-vous.')
      return {success: true, token: replacement.token, expiresAt: replacement.expiresAt}
    }, {isolationLevel: 'Serializable', maxWait: 5000, timeout: 15000})
  } catch (error) {
    if (isDatabaseWriteConflict(error)) throw createHttpError(409, 'Les accès ont changé. Rechargez la liste avant de réessayer.')
    throw error
  }
}
