import process from 'node:process'
import createHttpError from 'http-errors'
import {getUserByEmail} from '../models/user.js'
import {createAuthToken, getAuthTokenByToken, deleteAuthToken} from '../models/auth-token.js'
import {createSessionToken, deleteSessionToken} from '../models/session-token.js'
import {getTerritoire} from '../models/territoire.js'
import {sendEmail} from '../util/email.js'
import {renderMagicLinkEmail} from '../util/email-templates.js'

const API_URL = process.env.API_URL || 'http://localhost:5000'
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

  const user = await getUserByEmail(email)

  if (!user || user.roles.length === 0) {
    // Message générique pour éviter l'énumération d'emails
    return res.status(200).send({
      success: true,
      message: 'Si ce compte existe et dispose des droits nécessaires, un email de connexion a été envoyé'
    })
  }

  // Créer un token d'authentification
  const authToken = await createAuthToken(user.email)

  // Envoyer l'email avec les liens magic link
  const apiUrl = prefixUrl || API_URL
  const html = renderMagicLinkEmail(user, authToken.token, apiUrl)
  await sendEmail(user.email, 'Connexion à Prélèvements d\'eau', html)

  res.status(200).send({
    success: true,
    message: 'Un email de connexion a été envoyé'
  })
}

export async function verifyAuth(req, res) {
  const {token} = req.params
  const {territoire: territoireCode} = req.query

  if (!token) {
    return res.redirect(`${FRONT_URL}/auth/error?reason=missing_token`)
  }

  if (!territoireCode) {
    return res.redirect(`${FRONT_URL}/auth/error?reason=missing_territoire`)
  }

  try {
    const sessionToken = await processAuthTokenVerification(token, territoireCode)
    res.redirect(`${FRONT_URL}?token=${sessionToken}`)
  } catch (error) {
    // Mapper les erreurs vers les raisons de redirection
    let reason = 'unknown'
    switch (error.status) {
      case 401: {
        reason = error.message.includes('expiré') ? 'expired' : 'user_not_found'
        break
      }

      case 403: {
        reason = 'invalid_territoire'
        break
      }

      case 404: {
        reason = 'territoire_not_found'
        break
      }
      // No default
    }

    return res.redirect(`${FRONT_URL}/auth/error?reason=${reason}`)
  }
}

async function processAuthTokenVerification(token, territoireCode) {
  if (!token) {
    throw createHttpError(400, 'Le token est requis')
  }

  if (!territoireCode) {
    throw createHttpError(400, 'Le territoire est requis')
  }

  // Vérifier le token d'authentification
  const authToken = await getAuthTokenByToken(token)

  if (!authToken) {
    throw createHttpError(401, 'Token invalide ou expiré')
  }

  // Récupérer l'utilisateur
  const user = await getUserByEmail(authToken.email)

  if (!user) {
    throw createHttpError(401, 'Utilisateur non trouvé')
  }

  // Vérifier que le territoire demandé existe dans les rôles de l'utilisateur
  const userRole = user.roles.find(r => r.territoire === territoireCode)

  if (!userRole) {
    throw createHttpError(403, 'Territoire non autorisé pour cet utilisateur')
  }

  // Vérifier que le territoire existe
  const territoire = await getTerritoire(territoireCode)

  if (!territoire) {
    throw createHttpError(404, 'Territoire non trouvé')
  }

  // Créer une session
  const session = await createSessionToken(user._id, territoireCode, userRole.role)

  return session.token
}

export async function verifyAuthToken(req, res) {
  const {token, territoire: territoireCode} = req.body

  const sessionToken = await processAuthTokenVerification(token, territoireCode)

  res.status(200).send({
    success: true,
    token: sessionToken
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
