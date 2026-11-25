import process from 'node:process'
import {createSmtpTransport, normalizeEmail, prefixEmailSubject} from './email.js'

function relayCredentials(env, sharedRelay) {
  // Only send shared credentials to their own relay. A capture relay can use no authentication.
  if (env.DECLARATION_RECEIPT_SMTP_USER !== undefined || env.DECLARATION_RECEIPT_SMTP_PASSWORD !== undefined) {
    return {user: env.DECLARATION_RECEIPT_SMTP_USER, password: env.DECLARATION_RECEIPT_SMTP_PASSWORD}
  }
  return sharedRelay ? {user: env.SMTP_USER, password: env.SMTP_PASSWORD} : {}
}

export function getDeclarationReceiptMailConfig(env = process.env) {
  const host = env.DECLARATION_RECEIPT_SMTP_HOST?.trim()
  if (!host) return null

  const sharedRelay = host.toLowerCase() === env.SMTP_HOST?.trim().toLowerCase()
  const {user, password} = relayCredentials(env, sharedRelay)
  const port = Number(env.DECLARATION_RECEIPT_SMTP_PORT || env.SMTP_PORT)
  const frontUrl = env.FRONT_URL || env.FRONTEND_URL
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !env.SMTP_FROM || Boolean(user) !== Boolean(password)
    || !URL.canParse(frontUrl) || !['http:', 'https:'].includes(new URL(frontUrl).protocol)) {
    throw new Error('Configuration du mail récapitulatif incomplète. Vérifiez le relais SMTP, son port, son authentification, SMTP_FROM et FRONT_URL.')
  }
  return {
    frontUrl,
    from: env.SMTP_FROM,
    subjectPrefix: env.DECLARATION_RECEIPT_SUBJECT_PREFIX ?? env.MAIL_SUBJECT_PREFIX ?? '',
    smtp: {host, port, user, password, ignoreTls: sharedRelay && env.SMTP_IGNORE_TLS === 'true'}
  }
}

export function sendDeclarationReceiptEmail(receipt, {subject, html}, config) {
  const transport = createSmtpTransport({
    ...config.smtp,
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000
  })
  return transport.sendMail({
    from: config.from,
    to: normalizeEmail(receipt.recipientEmail),
    subject: prefixEmailSubject(subject, config.subjectPrefix),
    html,
    messageId: `<declaration-${receipt.id}@partageonsleau.beta.gouv.fr>`
  })
}

export function classifyReceiptSmtpError(error) {
  if (error?.responseCode >= 500 && error.responseCode < 600) return 'SMTP_REJECTED'
  if (error?.responseCode >= 400 && error.responseCode < 500) return 'SMTP_RETRY'
  if (['CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT'].includes(error?.timeoutType)) return 'SMTP_RETRY'
  const connectionCodes = ['ECONNREFUSED', 'EDNS', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH']
  if ([error?.code, error?.originalCode, error?.errno, error?.cause?.code].some(code => connectionCodes.includes(code))) return 'SMTP_RETRY'
  // A broken connection may have lost the final acknowledgement after SMTP accepted the DATA.
  return 'SMTP_UNKNOWN'
}
