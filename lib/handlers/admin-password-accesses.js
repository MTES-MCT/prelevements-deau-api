import createHttpError from 'http-errors'
import Joi from 'joi'

import {
  setAuditSubject,
  setAuditTarget
} from '../audit/context.js'
import {readPasswordActivationFrontUrl} from '../config/auth.js'
import {
  issuePasswordActivation,
  listPasswordAccesses,
  revokePasswordAccess
} from '../models/password-access.js'

const listQuerySchema = Joi.object({
  search: Joi.string().trim().max(200).allow(''),
  limit: Joi.number().integer().min(1).max(100).default(50)
})

const createSchema = Joi.object({
  userId: Joi.string().guid({version: 'uuidv4'}).required()
})

const userIdSchema = Joi.string().guid({version: 'uuidv4'}).required()
const SELF_PASSWORD_ACCESS_MESSAGE = 'Action interdite.'

function validate(schema, value, message) {
  const result = schema.validate(value, {
    abortEarly: false,
    convert: true,
    stripUnknown: true
  })

  if (result.error) {
    throw createHttpError(400, message)
  }

  return result.value
}

function ensureDifferentUser(actorUserId, targetUserId) {
  if (actorUserId === targetUserId) {
    throw createHttpError(403, SELF_PASSWORD_ACCESS_MESSAGE)
  }
}

function serializePasswordAccess(user, now = new Date()) {
  const credential = user.passwordCredential
  const activation = user.passwordActivation
  const activationExpired = activation && new Date(activation.expiresAt) <= now

  let status = 'NONE'
  if (credential) {
    status = 'ACTIVE'
  } else if (activationExpired) {
    status = 'EXPIRED'
  } else if (activation) {
    status = 'PENDING'
  }

  return {
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role
    },
    status,
    passwordSetAt: credential?.updatedAt ?? null,
    activationCreatedAt: activation?.createdAt ?? null,
    activationExpiresAt: activation?.expiresAt ?? null
  }
}

function serializeIssuedAccess(result) {
  return serializePasswordAccess({
    ...result.user,
    passwordCredential: null,
    passwordActivation: result.activation
  })
}

export async function listPasswordAccessesHandler(req, res) {
  const query = validate(listQuerySchema, req.query, 'Paramètres de recherche invalides.')
  const users = await listPasswordAccesses(query)

  res.status(200).send({
    items: users.map(user => serializePasswordAccess(user))
  })
}

export async function issuePasswordActivationHandler(req, res) {
  const {userId} = validate(createSchema, req.body, 'userId invalide.')
  ensureDifferentUser(req.user.id, userId)
  const result = await issuePasswordActivation(userId, {
    createdByUserId: req.user.id
  })

  if (!result) {
    throw createHttpError(404, 'Utilisateur introuvable.')
  }

  setAuditSubject(req, result.user)
  setAuditTarget(req, {id: result.user.id, type: 'USER'})
  const frontUrl = readPasswordActivationFrontUrl()

  res.status(201).send({
    success: true,
    reset: result.reset,
    sessionsRevoked: result.sessionsRevoked,
    access: serializeIssuedAccess(result),
    activationUrl: `${frontUrl}/activation-mot-de-passe#token=${encodeURIComponent(result.token)}`,
    expiresAt: result.activation.expiresAt
  })
}

export async function revokePasswordAccessHandler(req, res) {
  const userId = validate(userIdSchema, req.params.userId, 'userId invalide.')
  ensureDifferentUser(req.user.id, userId)
  const result = await revokePasswordAccess(userId)

  if (!result) {
    throw createHttpError(404, 'Utilisateur introuvable.')
  }

  setAuditSubject(req, result.user)
  setAuditTarget(req, {id: result.user.id, type: 'USER'})

  res.status(200).send({
    success: true,
    revoked: result.revoked,
    sessionsRevoked: result.sessionsRevoked
  })
}
