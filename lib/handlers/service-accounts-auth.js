import createHttpError from 'http-errors'
import {authenticateServiceAccountCredential} from '../models/service-account-credential.js'
import {
  createServiceAccountAccessToken,
  createServiceAccountImpersonationToken
} from '../models/service-account-token.js'
import {
  listActiveDeclarantsForServiceAccount,
  canServiceAccountImpersonateDeclarant
} from '../models/service-account-declarant.js'
import {getPointsPrelevementByDeclarant} from '../models/point-prelevement.js'
import {getExploitationsWithConnectorByDeclarantId} from '../models/exploitation.js'

export async function createServiceAccountAccessTokenHandler(req, res) {
  const {clientId, clientSecret} = req.body

  if (!clientId || !clientSecret) {
    throw createHttpError(400, 'clientId et clientSecret sont requis')
  }

  const credential = await authenticateServiceAccountCredential(clientId, clientSecret)

  if (!credential) {
    throw createHttpError(401, 'Identifiants invalides')
  }

  const accessToken = await createServiceAccountAccessToken(
    credential.serviceAccountId,
    credential.id
  )

  res.status(200).send({
    success: true,
    tokenType: 'Bearer',
    accessToken: accessToken.token,
    expiresAt: accessToken.expiresAt,
    serviceAccount: {
      id: credential.serviceAccount.id,
      name: credential.serviceAccount.name
    }
  })
}

export async function listManagedDeclarantsForServiceAccountHandler(req, res) {
  if (!req.serviceAccount?.id) {
    throw createHttpError(401, 'Compte de service non authentifié')
  }

  const links = await listActiveDeclarantsForServiceAccount(req.serviceAccount.id)

  res.status(200).send({
    success: true,
    data: links.map(link => ({
      declarantUserId: link.declarant.userId
    }))
  })
}

export async function createDeclarantImpersonationTokenHandler(req, res) {
  if (!req.serviceAccount?.id) {
    throw createHttpError(401, 'Compte de service non authentifié')
  }

  const {declarantUserId} = req.params

  if (!declarantUserId) {
    throw createHttpError(400, 'declarantUserId requis')
  }

  const allowed = await canServiceAccountImpersonateDeclarant(
    req.serviceAccount.id,
    declarantUserId
  )

  if (!allowed) {
    throw createHttpError(403, 'Ce compte de service ne peut pas agir pour ce déclarant')
  }

  const token = await createServiceAccountImpersonationToken(
    req.serviceAccount.id,
    declarantUserId
  )

  res.status(200).send({
    success: true,
    tokenType: 'Bearer',
    accessToken: token.token,
    expiresAt: token.expiresAt,
    declarantUserId
  })
}

export async function getDeclarantContextHandler(req, res) {
  if (!req.serviceAccount?.id) {
    throw createHttpError(401, 'Compte de service non authentifié')
  }

  const {declarantUserId} = req.params

  if (!declarantUserId) {
    throw createHttpError(400, 'declarantUserId requis')
  }

  const allowed = await canServiceAccountImpersonateDeclarant(
    req.serviceAccount.id,
    declarantUserId
  )

  if (!allowed) {
    throw createHttpError(403, 'Ce compte de service ne peut pas agir pour ce déclarant')
  }

  const exploitations = await getExploitationsWithConnectorByDeclarantId(declarantUserId)

  res.status(200).send({
    success: true,
    exploitations: exploitations.map(exploitation => ({
      point: {
        id: exploitation.pointPrelevement.id,
        name: exploitation.pointPrelevement.name
      },
      mostRecentAvailableDate: exploitation.mostRecentAvailableDate,
      connector: {
        type: exploitation.connectorType,
        parameters: exploitation.connectorParameters
      }
    }))
  })
}
