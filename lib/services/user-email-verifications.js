import process from 'node:process'

import createHttpError from 'http-errors'

import {prisma} from '../../db/prisma.js'
import {
  cancelEmailVerification,
  consumeEmailVerification,
  EMAIL_VERIFICATION_PURPOSES,
  issueEmailVerification,
  listEmailVerifications,
  recordEmailVerificationDelivery,
  resendEmailVerification,
  serializeUserEmailVerification
} from '../models/user-email-verification.js'
import {
  renderEmailVerificationEmail,
  renderEmailVerificationRequestedAlertEmail,
  renderPrimaryEmailChangedAlertEmail
} from '../util/email-templates.js'
import {sendEmail} from '../util/email.js'

const DEFAULT_FRONT_URL = process.env.FRONT_URL
  || process.env.FRONTEND_URL
  || 'http://localhost:3000'

export function buildEmailVerificationUrl(token, frontUrl = DEFAULT_FRONT_URL) {
  const url = new URL('/validation-email', frontUrl)
  url.hash = `token=${encodeURIComponent(token)}`
  return url.toString()
}

async function sendBestEffort(send, recipient, subject, html) {
  try {
    await send(recipient, subject, html)
  } catch {
    // Les alertes secondaires ne doivent pas annuler une demande ou une
    // confirmation déjà persistée. sendEmail journalise et remonte l'erreur.
  }
}

async function sendRequestedSecurityAlerts(issue, {
  send,
  renderRequestedAlert
}) {
  if (issue.securityNotificationRecipients.length === 0) {
    return
  }

  try {
    const html = await renderRequestedAlert({
      user: issue.user,
      email: issue.verification.email,
      purpose: issue.verification.purpose,
      expiresAt: issue.verification.expiresAt
    })

    await Promise.all(issue.securityNotificationRecipients.map(recipient =>
      sendBestEffort(
        send,
        recipient,
        'Partageons l’Eau - Demande de modification de vos adresses de connexion',
        html
      )))
  } catch {
    // Une erreur de rendu d'une alerte secondaire ne remet pas la demande en cause.
  }
}

async function deliverEmailVerification(issue, {
  client,
  frontUrl,
  now,
  send,
  renderVerification,
  recordDelivery
}) {
  let delivered = false

  try {
    const html = await renderVerification({
      user: issue.user,
      email: issue.verification.email,
      purpose: issue.verification.purpose,
      confirmationUrl: buildEmailVerificationUrl(issue.token, frontUrl),
      expiresAt: issue.verification.expiresAt
    })

    await send(
      issue.verification.email,
      'Partageons l’Eau - Confirmez votre adresse email',
      html
    )
    delivered = true
  } catch {
    delivered = false
  }

  return recordDelivery(
    issue.verification.id,
    issue.tokenHash,
    delivered,
    {client, now}
  )
}

async function requestUserEmailVerification(userId, purpose, email, {
  allowImpersonatedSession = false,
  client = prisma,
  now = new Date(),
  sessionToken = null,
  frontUrl = DEFAULT_FRONT_URL,
  issue = issueEmailVerification,
  recordDelivery = recordEmailVerificationDelivery,
  send = sendEmail,
  renderVerification = renderEmailVerificationEmail,
  renderRequestedAlert = renderEmailVerificationRequestedAlertEmail
} = {}) {
  const issued = await issue(userId, purpose, email, {
    allowImpersonatedSession,
    client,
    now,
    sessionToken
  })

  const [verification] = await Promise.all([
    deliverEmailVerification(issued, {
      client,
      frontUrl,
      now,
      send,
      renderVerification,
      recordDelivery
    }),
    sendRequestedSecurityAlerts(issued, {
      send,
      renderRequestedAlert
    })
  ])

  return serializeUserEmailVerification(verification ?? issued.verification, {now})
}

export async function listUserEmailVerifications(userId, {
  client = prisma,
  now = new Date(),
  list = listEmailVerifications
} = {}) {
  const verifications = await list(userId, {client, now})
  return verifications.map(verification =>
    serializeUserEmailVerification(verification, {now}))
}

export async function requestPrimaryEmailChange(userId, email, options = {}) {
  return requestUserEmailVerification(
    userId,
    EMAIL_VERIFICATION_PURPOSES.PRIMARY_CHANGE,
    email,
    options
  )
}

export async function requestEmailAliasAddition(userId, email, options = {}) {
  return requestUserEmailVerification(
    userId,
    EMAIL_VERIFICATION_PURPOSES.ALIAS_ADD,
    email,
    options
  )
}

export async function resendUserEmailVerification(userId, verificationId, {
  allowImpersonatedSession = false,
  client = prisma,
  now = new Date(),
  sessionToken = null,
  frontUrl = DEFAULT_FRONT_URL,
  resend = resendEmailVerification,
  issue = issueEmailVerification,
  recordDelivery = recordEmailVerificationDelivery,
  send = sendEmail,
  renderVerification = renderEmailVerificationEmail,
  renderRequestedAlert = renderEmailVerificationRequestedAlertEmail
} = {}) {
  const result = await resend(userId, verificationId, {
    allowImpersonatedSession,
    client,
    now,
    sessionToken
  })

  if (result.outcome === 'COOLDOWN') {
    const error = createHttpError(429, 'Un nouvel envoi sera possible dans quelques instants.')
    error.retryAfterSeconds = result.retryAfterSeconds
    throw error
  }

  if (result.outcome === 'EXPIRED') {
    return requestUserEmailVerification(
      userId,
      result.verification.purpose,
      result.verification.email,
      {
        allowImpersonatedSession,
        client,
        now,
        sessionToken,
        frontUrl,
        issue,
        recordDelivery,
        send,
        renderVerification,
        renderRequestedAlert
      }
    )
  }

  if (result.outcome !== 'ISSUED') {
    return serializeUserEmailVerification(result.verification, {now})
  }

  const verification = await deliverEmailVerification(result, {
    client,
    frontUrl,
    now,
    send,
    renderVerification,
    recordDelivery
  })

  return serializeUserEmailVerification(verification ?? result.verification, {now})
}

export async function cancelUserEmailVerification(userId, verificationId, {
  allowImpersonatedSession = false,
  client = prisma,
  now = new Date(),
  sessionToken = null,
  cancel = cancelEmailVerification
} = {}) {
  const verification = await cancel(userId, verificationId, {
    allowImpersonatedSession,
    client,
    now,
    sessionToken
  })
  return serializeUserEmailVerification(verification, {now})
}

export async function confirmUserEmailVerification(token, {
  client = prisma,
  now = new Date(),
  consume = consumeEmailVerification,
  send = sendEmail,
  renderChangedAlert = renderPrimaryEmailChangedAlertEmail
} = {}) {
  const result = await consume(token, {client, now})

  if (result.outcome === 'VERIFIED'
    && result.purpose === EMAIL_VERIFICATION_PURPOSES.PRIMARY_CHANGE
    && result.securityNotificationRecipients.length > 0) {
    try {
      const html = await renderChangedAlert({
        user: result.user,
        previousEmail: result.previousEmail,
        newEmail: result.email
      })

      await Promise.all(result.securityNotificationRecipients.map(recipient =>
        sendBestEffort(
          send,
          recipient,
          'Partageons l’Eau - Votre adresse de connexion a changé',
          html
        )))
    } catch {
      // La nouvelle adresse est déjà validée : cette alerte reste secondaire.
    }
  }

  return {
    ...result,
    ...(result.verification
      ? {verification: serializeUserEmailVerification(result.verification, {now})}
      : {})
  }
}
