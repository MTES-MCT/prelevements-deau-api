import {setAuditSubjectId} from '../audit/context.js'
import {
  cancelUserEmailVerification,
  confirmUserEmailVerification,
  requestPrimaryEmailChange,
  resendUserEmailVerification
} from '../services/user-email-verifications.js'

const CONFIRMATION_STATUS_CODES = Object.freeze({
  VERIFIED: 200,
  EXPIRED: 410,
  CONFLICT: 409,
  INVALID: 400
})

export async function requestPrimaryEmailChangeHandler(req, res) {
  const verification = await requestPrimaryEmailChange(
    req.user.id,
    req.body?.email,
    {
      allowImpersonatedSession: true,
      sessionToken: req.authToken
    }
  )

  res.status(202).send(verification)
}

export async function resendMyEmailVerificationHandler(req, res) {
  const verification = await resendUserEmailVerification(
    req.user.id,
    req.params.verificationId,
    {
      allowImpersonatedSession: true,
      sessionToken: req.authToken
    }
  )

  res.status(200).send(verification)
}

export async function cancelMyEmailVerificationHandler(req, res) {
  const verification = await cancelUserEmailVerification(
    req.user.id,
    req.params.verificationId,
    {
      allowImpersonatedSession: true,
      sessionToken: req.authToken
    }
  )

  res.status(200).send(verification)
}

export function serializeEmailVerificationConfirmation(result) {
  return {
    outcome: result.outcome,
    ...(result.verification ? {verification: result.verification} : {}),
    ...(result.purpose ? {purpose: result.purpose} : {}),
    ...(result.email ? {email: result.email} : {}),
    ...(result.outcome === 'VERIFIED'
      ? {requiresReauthentication: result.purpose === 'PRIMARY_CHANGE'}
      : {})
  }
}

export async function confirmEmailVerificationHandler(req, res) {
  const token = req.body?.token

  if (req.body) {
    delete req.body.token
  }

  const result = typeof token === 'string' && token.length <= 512
    ? await confirmUserEmailVerification(token)
    : {outcome: 'INVALID'}

  if (result.userId) {
    setAuditSubjectId(req, result.userId)
  }

  const statusCode = CONFIRMATION_STATUS_CODES[result.outcome]
    ?? CONFIRMATION_STATUS_CODES.INVALID

  res.status(statusCode).send(serializeEmailVerificationConfirmation(result))
}
