import {
  renderPasswordActivatedAlertEmail,
  renderPasswordChangedAlertEmail,
  renderPasswordResetAlertEmail
} from '../util/email-templates.js'
import {sendEmail} from '../util/email.js'

export const PASSWORD_SECURITY_NOTIFICATION_TYPES = Object.freeze({
  ACTIVATED: 'ACTIVATED',
  CHANGED: 'CHANGED',
  RESET: 'RESET'
})

const NOTIFICATIONS = Object.freeze({
  [PASSWORD_SECURITY_NOTIFICATION_TYPES.ACTIVATED]: {
    render: renderPasswordActivatedAlertEmail,
    subject: 'Partageons l’Eau - Votre mot de passe a été défini'
  },
  [PASSWORD_SECURITY_NOTIFICATION_TYPES.CHANGED]: {
    render: renderPasswordChangedAlertEmail,
    subject: 'Partageons l’Eau - Votre mot de passe a été modifié'
  },
  [PASSWORD_SECURITY_NOTIFICATION_TYPES.RESET]: {
    render: renderPasswordResetAlertEmail,
    subject: 'Partageons l’Eau - Votre accès par mot de passe a été réinitialisé'
  }
})

export async function sendPasswordSecurityNotification(user, type, {
  render,
  send = sendEmail
} = {}) {
  const notification = NOTIFICATIONS[type]
  if (!notification || !user?.email) {
    return false
  }

  try {
    const html = await (render ?? notification.render)(user)
    await send(user.email, notification.subject, html)
    return true
  } catch {
    // Une mutation de mot de passe déjà persistée ne doit pas être annulée
    // si son alerte de sécurité ne peut pas être rendue ou envoyée.
    return false
  }
}
