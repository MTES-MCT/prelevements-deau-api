import process from 'node:process'
import createHttpError from 'http-errors'
import {getUserByEmail} from '../models/user.js'
import {createAuthToken, getAuthTokenByToken, deleteAuthToken} from '../models/auth-token.js'
import {createSessionToken, deleteSessionToken} from '../models/session-token.js'
import {sendEmail} from '../util/email.js'
import {renderMagicLinkEmail} from '../util/email-templates.js'

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
  const apiUrl = prefixUrl || FRONT_URL
  const html = renderMagicLinkEmail(user, authToken.token, apiUrl)
  await sendEmail(user.email, 'Connexion à Partageons l\'eau', html)

  res.status(200).send({
    success: true,
    message: 'Un email de connexion a été envoyé'
  })
}

async function processAuthTokenVerification(token) {
  if (!token) {
    throw createHttpError(400, 'Le token est requis')
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

  // Supprimer le token d'authentification (usage unique)
  await deleteAuthToken(token)

  // Créer une session
  const session = await createSessionToken(user._id, user.roles)

  return session.token
}

export async function verifyAuthToken(req, res) {
  const {token} = req.body

  const sessionToken = await processAuthTokenVerification(token)

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
