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
import {
  PASSWORD_SECURITY_NOTIFICATION_TYPES,
  sendPasswordSecurityNotification
} from '../services/password-security-notifications.js'

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

export async function handlePasswordLogin(req, res, {
  authenticate = authenticateWithPassword
} = {}) {
  const {email, password} = req.body
  clearPasswordFields(req.body, 'password')

  const result = await authenticate(email, password)
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

export function passwordLoginHandler(req, res) {
  return handlePasswordLogin(req, res)
}

export async function handlePasswordActivation(req, res, {
  activate = activatePassword,
  notify = sendPasswordSecurityNotification
} = {}) {
  const {token, password} = req.body
  clearPasswordFields(req.body, 'password', 'token')

  const result = await activate(token, password)
  if (!result) {
    throw createHttpError(401, 'Lien d’activation invalide ou expiré.')
  }

  setAuditSubject(req, result.user)
  await notify(
    result.user,
    PASSWORD_SECURITY_NOTIFICATION_TYPES.ACTIVATED
  )
  sendSession(res, result.session)
}

export function activatePasswordHandler(req, res) {
  return handlePasswordActivation(req, res)
}

export async function handlePasswordChange(req, res, {
  change = changePassword,
  notify = sendPasswordSecurityNotification
} = {}) {
  const {currentPassword, newPassword} = req.body
  clearPasswordFields(req.body, 'currentPassword', 'newPassword')

  const session = await change(req.user, currentPassword, newPassword, {
    sessionToken: req.authToken
  })
  if (!session) {
    throw createHttpError(401, INVALID_CREDENTIALS_MESSAGE)
  }

  setAuditSubject(req, req.user)
  await notify(
    req.user,
    PASSWORD_SECURITY_NOTIFICATION_TYPES.CHANGED
  )
  sendSession(res, session)
}

export function changePasswordHandler(req, res) {
  return handlePasswordChange(req, res)
}
