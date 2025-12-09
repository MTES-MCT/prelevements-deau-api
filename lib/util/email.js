import process from 'node:process'
import nodemailer from 'nodemailer'
import createHttpError from 'http-errors'

const {SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM, NODE_ENV} = process.env

// Validation simple d'email avec support du caractère +
const EMAIL_REGEX = /^[\w.%+-]+@[a-z\d.-]+\.[a-z]{2,}$/i

const isDevelopment = NODE_ENV === 'development' || !NODE_ENV

export function normalizeEmail(email) {
  if (!email || typeof email !== 'string') {
    throw createHttpError(400, 'Email invalide')
  }

  const normalized = email.toLowerCase().trim()

  if (!EMAIL_REGEX.test(normalized)) {
    throw createHttpError(400, 'Format d\'email invalide')
  }

  return normalized
}

export function validateEmailConfig() {
  // En développement, la configuration SMTP n'est pas obligatoire
  if (isDevelopment) {
    return
  }

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASSWORD || !SMTP_FROM) {
    throw new Error('Configuration SMTP incomplète. Variables requises: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM')
  }
}

let transporter

export function getTransporter() {
  if (!transporter) {
    validateEmailConfig()

    // En développement, utiliser le transport console
    if (isDevelopment) {
      transporter = nodemailer.createTransport({
        streamTransport: true,
        newline: 'unix',
        buffer: true
      })
    } else {
      transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: Number.parseInt(SMTP_PORT, 10),
        secure: Number.parseInt(SMTP_PORT, 10) === 465,
        auth: {
          user: SMTP_USER,
          pass: SMTP_PASSWORD
        }
      })
    }
  }

  return transporter
}

export async function sendEmail(to, subject, html) {
  const transport = getTransporter()

  try {
    const info = await transport.sendMail({
      from: SMTP_FROM || 'noreply@localhost',
      to,
      subject,
      html
    })

    // En développement, afficher l'email dans la console
    if (isDevelopment && info.message) {
      console.log('\n📧 Email envoyé (mode développement):')
      console.log('To:', to)
      console.log('Subject:', subject)
      console.log('Message:', info.message.toString())
      console.log('---\n')
    }

    return info
  } catch (error) {
    console.error('Erreur lors de l\'envoi d\'email:', error)
    throw createHttpError(500, 'Impossible d\'envoyer l\'email')
  }
}

