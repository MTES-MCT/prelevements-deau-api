import createHttpError from 'http-errors'

import {
  addUnknownLoginAuditMetadata,
  setAuditSubject
} from '../audit/context.js'
import {readAuthMethods} from '../config/auth.js'
import {
  activatePassword,
  authenticateWithPassword,
  changePassword
} from '../services/password-auth.js'

const INVALID_CREDENTIALS_MESSAGE = 'Identifiants invalides.'

function clearPasswordFields(body, ...fields) {
  for (const field of fields) {
    delete body[field]
  }
}

function sendSession(res, session) {
  return res.status(200).send({
    success: true,
    token: session.token,
    expiresAt: session.expiresAt
  })
}

export function getAuthConfigHandler(req, res, methods = readAuthMethods()) {
  res.status(200).send({methods})
}

export async function passwordLoginHandler(req, res) {
  const {email, password} = req.body
  clearPasswordFields(req.body, 'password')

  const result = await authenticateWithPassword(email, password)
  if (!result?.session) {
    if (result?.user) {
      setAuditSubject(req, result.user)
    } else {
      addUnknownLoginAuditMetadata(req, email)
    }

    throw createHttpError(401, INVALID_CREDENTIALS_MESSAGE)
  }

  setAuditSubject(req, result.user)
  sendSession(res, result.session)
}

export async function activatePasswordHandler(req, res) {
  const {token, password} = req.body
  clearPasswordFields(req.body, 'password', 'token')

  const result = await activatePassword(token, password)
  if (!result) {
    throw createHttpError(401, 'Lien d’activation invalide ou expiré.')
  }

  setAuditSubject(req, result.user)
  sendSession(res, result.session)
}

export async function changePasswordHandler(req, res) {
  const {currentPassword, newPassword} = req.body
  clearPasswordFields(req.body, 'currentPassword', 'newPassword')

  const session = await changePassword(req.user, currentPassword, newPassword)
  if (!session) {
    throw createHttpError(401, INVALID_CREDENTIALS_MESSAGE)
  }

  setAuditSubject(req, req.user)
  sendSession(res, session)
}
