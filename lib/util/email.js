import process from 'node:process'
import nodemailer from 'nodemailer'
import createHttpError from 'http-errors'
import * as Sentry from '@sentry/node'

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASSWORD,
  SMTP_FROM,
  SMTP_IGNORE_TLS,
  MAIL_SUBJECT_PREFIX = ''
} = process.env

// Validation simple d'email avec support du caractère +
const EMAIL_REGEX = /^[\w.%+-]+@[a-z\d.-]+\.[a-z]{2,}$/i
const MAX_EMAIL_LENGTH = 320

export function normalizeEmail(email, {required = true} = {}) {
  if (email === null || email === undefined || email === '') {
    if (required) {
      throw createHttpError(400, 'Email invalide')
    }

    return null
  }

  if (typeof email !== 'string') {
    throw createHttpError(400, 'Email invalide')
  }

  const normalized = email.toLowerCase().trim()

  if (!normalized) {
    if (required) {
      throw createHttpError(400, 'Email invalide')
    }

    return null
  }

  if (normalized.length > MAX_EMAIL_LENGTH || !EMAIL_REGEX.test(normalized)) {
    throw createHttpError(400, 'Format d\'email invalide')
  }

  return normalized
}

export function validateEmailConfig() {
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_FROM) {
    throw new Error('Configuration SMTP incomplète. Variables requises: SMTP_HOST, SMTP_PORT, SMTP_FROM')
  }
}

export function prefixEmailSubject(subject, prefix = MAIL_SUBJECT_PREFIX) {
  return `${prefix}${subject}`
}

export function getTransporter() {
  validateEmailConfig()

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number.parseInt(SMTP_PORT, 10),
    secure: Number.parseInt(SMTP_PORT, 10) === 465,
    ignoreTLS: SMTP_IGNORE_TLS === 'true',
    ...(SMTP_USER && SMTP_PASSWORD
      ? {
        auth: {
          user: SMTP_USER,
          pass: SMTP_PASSWORD
        }
      }
      : {}
    )
  })
}

export async function sendEmail(to, subject, html) {
  const recipient = normalizeEmail(to)
  const transport = getTransporter()
  const fromHeader = SMTP_FROM || 'noreply@localhost'
  try {
    return await transport.sendMail({
      from: fromHeader,
      to: recipient,
      subject: prefixEmailSubject(subject),
      html
    })
  } catch (error) {
    Sentry.captureException(error)
    console.error('Erreur lors de l\'envoi d\'email:', error)
    throw createHttpError(500, 'Impossible d\'envoyer l\'email')
  }
}
