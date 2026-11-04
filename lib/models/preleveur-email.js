import {randomUUID} from 'node:crypto'
import createHttpError from 'http-errors'
import {normalizeEmail} from '../util/email.js'

export function normalizePreleveurEmail(value) {
  const email = normalizeEmail(value, {required: false})
  if (email?.endsWith('@import.local')) throw createHttpError(400, 'Une adresse technique d’import ne peut pas être une adresse principale.')
  return email
}

// Authentication must use only the explicit principal, never a contact fallback.
export function getPreleveurPrincipalEmail(value) {
  const record = value?.declarant ?? value
  return record?.email && !record.email.toLowerCase().endsWith('@import.local') ? record.email : null
}

export function getPreleveurDisplayEmail(value) {
  const record = value?.declarant ?? value
  return getPreleveurPrincipalEmail(value)
    ?? record?.contactEmails?.find(contact => contact.isPrimary && !contact.email.toLowerCase().endsWith('@import.local'))?.email
    ?? null
}

export async function lockPreleveurEmail(tx, email) {
  if (email) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`preleveur-primary-email:${email}`}, 0))::text`
}

export async function isLegacyLoginEmailAvailable(tx, email, now = new Date()) {
  if (!email) return false
  const user = await tx.user.findFirst({where: {email}, select: {id: true}})
  const alias = await tx.userEmailAlias.findUnique({where: {email}, select: {id: true}})
  const verification = await tx.userEmailVerification.findFirst({where: {email, status: {in: ['PENDING', 'SEND_FAILED']}, expiresAt: {gt: now}}, select: {id: true}})
  return !user && !alias && !verification
}

// Caller owns the transaction and audit event. Preserve every former contact
// and source ID; changing the business principal never changes legacy login.
export async function setPreleveurEmail(tx, {userId, email}) {
  const normalized = normalizePreleveurEmail(email)
  await tx.$queryRaw`SELECT "userId" FROM "Declarant" WHERE "userId" = ${userId}::uuid FOR UPDATE`
  const before = await tx.declarant.findUnique({where: {userId}, select: {userId: true, email: true}})
  if (!before) throw createHttpError(404, 'Préleveur introuvable.')
  if (before.email !== normalized) await tx.declarant.update({where: {userId}, data: {email: normalized}})
  await tx.declarantContactEmail.updateMany({where: {declarantUserId: userId, isPrimary: true,
    ...(normalized ? {email: {not: normalized}} : {})}, data: {isPrimary: false}})
  if (normalized) {
    const target = await tx.declarantContactEmail.findUnique({
      where: {declarantUserId_email: {declarantUserId: userId, email: normalized}}, select: {id: true, isPrimary: true}
    })
    if (!target) await tx.declarantContactEmail.create({data: {id: randomUUID(), declarantUserId: userId, email: normalized, isPrimary: true}})
    else if (!target.isPrimary) await tx.declarantContactEmail.update({where: {id: target.id}, data: {isPrimary: true}})
  }
  return {previousEmail: before.email, email: normalized}
}
