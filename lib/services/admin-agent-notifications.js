import {
  renderAdminAgentDeactivatedAlertEmail,
  renderAdminAgentRestoredAlertEmail,
  renderPrimaryEmailChangedAlertEmail
} from '../util/email-templates.js'
import {sendEmail} from '../util/email.js'

const NOTIFICATIONS = Object.freeze({
  DEACTIVATED: {
    render: ({agent}) => renderAdminAgentDeactivatedAlertEmail(agent),
    subject: 'Partageons l’Eau - Votre compte agent a été désactivé'
  },
  EMAIL_CHANGED: {
    render: ({agent, previousEmail, newEmail}) => renderPrimaryEmailChangedAlertEmail({
      user: agent,
      previousEmail,
      newEmail
    }),
    subject: 'Partageons l’Eau - Votre adresse de connexion a changé'
  },
  RESTORED: {
    render: ({agent}) => renderAdminAgentRestoredAlertEmail(agent),
    subject: 'Partageons l’Eau - Votre compte agent a été réactivé'
  }
})

export async function sendAdminAgentAccountNotification(payload, {
  send = sendEmail
} = {}) {
  const notification = NOTIFICATIONS[payload?.type]
  const recipients = [...new Set((payload?.recipients ?? []).filter(Boolean))]

  if (!notification || recipients.length === 0) {
    return false
  }

  const html = await notification.render(payload)
  await Promise.all(recipients.map(recipient =>
    send(recipient, notification.subject, html)))

  return true
}
