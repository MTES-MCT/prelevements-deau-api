import process from 'node:process'

import {
  markAccountCreationMailSent,
  markZoneAttachmentMailSent
} from '../models/user-notifications.js'
import {
  renderAccountCreationEmail,
  renderZoneAttachmentEmail
} from '../util/email-templates.js'
import {sendEmail} from '../util/email.js'

const FRONT_URL = process.env.FRONT_URL || process.env.FRONTEND_URL || 'http://localhost:3000'

function unwrapUser(person) {
  return person?.user ?? person
}

function getZoneLabel(zone) {
  return [zone?.name, zone?.code ? `(${zone.code})` : null].filter(Boolean).join(' ')
}

export async function sendAccountCreationNotification(person, {role} = {}) {
  const user = unwrapUser(person)
  const html = renderAccountCreationEmail(user, FRONT_URL)

  await sendEmail(user.email, 'Partageons l’Eau - Votre compte est disponible', html)

  return markAccountCreationMailSent(user.id, {role})
}

export async function sendZoneAttachmentNotification({instructor, zone}) {
  const user = unwrapUser(instructor)
  const html = renderZoneAttachmentEmail(user, zone, FRONT_URL)
  const zoneLabel = getZoneLabel(zone)

  await sendEmail(
    user.email,
    `Partageons l’Eau - Accès à la zone ${zoneLabel}`,
    html
  )

  return markZoneAttachmentMailSent({
    instructorUserId: user.id,
    zoneId: zone.id
  })
}
