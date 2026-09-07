import process from 'node:process'
import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {getUserById, lockActiveUser, updateLastLoginAt} from '../models/user.js'
import {getAuthTokenByToken, issueAuthTokenForLoginEmail} from '../models/auth-token.js'
import {createSessionToken, deleteSessionToken} from '../models/session-token.js'
import {normalizeEmail, sendEmail} from '../util/email.js'
import {renderMagicLinkEmail} from '../util/email-templates.js'
import {
  addUnknownLoginAuditMetadata,
  setAuditSubject
} from '../audit/context.js'

const FRONT_URL = process.env.FRONT_URL || 'http://localhost:3000'

export async function requestAuth(req, res) {
  const {email, prefixUrl} = req.body

  if (!email) {
    throw createHttpError(400, 'L\'email est requis')
  }

  // Valider prefixUrl s'il est fourni
  if (prefixUrl && !prefixUrl.startsWith('http://localhost:')) {
    throw createHttpError(400, 'Le prefixUrl doit commencer par "http://localhost:"')
  }

  const normalizedEmail = normalizeEmail(email)
  const issued = await issueAuthTokenForLoginEmail(normalizedEmail)

  if (!issued) {
    addUnknownLoginAuditMetadata(req, normalizedEmail)
    // Message générique pour éviter l'énumération d'emails
    return res.status(200).send({
      success: true,
      message: 'Si ce compte existe et dispose des droits nécessaires, un email de connexion a été envoyé'
    })
  }

  const {authToken, user} = issued
  setAuditSubject(req, user)

  // Envoyer l'email avec les liens magic link
  const apiUrl = prefixUrl || FRONT_URL
  const html = await renderMagicLinkEmail(user, authToken.token, apiUrl)
  await sendEmail(normalizedEmail, 'Connexion à Partageons l\'eau', html)

  res.status(200).send({
    success: true,
    message: 'Un email de connexion a été envoyé'
  })
}

export async function processAuthTokenVerification(token, req, {
  client = prisma,
  getAuthTokenByToken: findAuthTokenByToken = getAuthTokenByToken,
  getUserById: findUserById = getUserById,
  lockUser = lockActiveUser,
  createSessionToken: createUserSession = createSessionToken,
  updateLastLoginAt: updateUserLastLoginAt = updateLastLoginAt
} = {}) {
  if (!token) {
    throw createHttpError(400, 'Le token est requis')
  }

  // Vérifier le token d'authentification
  const authToken = await findAuthTokenByToken(token, {client})

  if (!authToken) {
    throw createHttpError(401, 'Token invalide ou expiré')
  }

  const authenticated = await client.$transaction(async transaction => {
    if (!await lockUser(authToken.userId, {client: transaction})) {
      return null
    }

    const currentAuthToken = await findAuthTokenByToken(token, {
      client: transaction
    })
    if (!currentAuthToken || currentAuthToken.userId !== authToken.userId) {
      return null
    }

    const user = await findUserById(authToken.userId, {client: transaction})
    if (!user || user.deletedAt) {
      return null
    }

    const session = await createUserSession(user.id, user.role, undefined, {
      authVersion: user.authVersion,
      client: transaction
    })
    await updateUserLastLoginAt(user.id, {client: transaction})

    return {session, user}
  })

  if (!authenticated) {
    throw createHttpError(401, 'Utilisateur non trouvé')
  }

  setAuditSubject(req, authenticated.user)

  return authenticated.session
}

export async function verifyAuthToken(req, res) {
  const {token} = req.body

  const session = await processAuthTokenVerification(token, req)

  res.status(200).send({
    success: true,
    token: session.token,
    expiresAt: session.expiresAt
  })
}

export async function logout(req, res) {
  const authHeader = req.get('Authorization')

  if (!authHeader) {
    throw createHttpError(401, 'Non authentifié')
  }

  const parts = authHeader.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    throw createHttpError(401, 'Format d\'authentification invalide')
  }

  const token = parts[1]

  await deleteSessionToken(token)

  res.status(200).send({
    success: true,
    message: 'Déconnexion réussie'
  })
}
