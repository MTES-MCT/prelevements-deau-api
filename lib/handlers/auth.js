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
  const {email} = req.body

  if (!email) {
    throw createHttpError(400, 'L\'email est requis')
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
  const html = renderMagicLinkEmail(user, authToken.token, API_URL)
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

  // Vérifier le token d'authentification
  const authToken = await getAuthTokenByToken(token)

  if (!authToken) {
    return res.redirect(`${FRONT_URL}/auth/error?reason=expired`)
  }

  // Récupérer l'utilisateur
  const user = await getUserByEmail(authToken.email)

  if (!user) {
    return res.redirect(`${FRONT_URL}/auth/error?reason=user_not_found`)
  }

  // Vérifier que le territoire demandé existe dans les rôles de l'utilisateur
  const userRole = user.roles.find(r => r.territoire === territoireCode)

  if (!userRole) {
    return res.redirect(`${FRONT_URL}/auth/error?reason=invalid_territoire`)
  }

  // Vérifier que le territoire existe
  const territoire = await getTerritoire(territoireCode)

  if (!territoire) {
    return res.redirect(`${FRONT_URL}/auth/error?reason=territoire_not_found`)
  }

  // Supprimer le token d'authentification (usage unique)
  await deleteAuthToken(token)

  // Créer une session
  const session = await createSessionToken(user._id, territoireCode, userRole.role)

  // Rediriger vers le front avec le session token
  res.redirect(`${FRONT_URL}?token=${session.token}`)
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
