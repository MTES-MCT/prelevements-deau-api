import {randomUUID} from 'node:crypto'

import {Prisma} from '@prisma/client'
import createHttpError from 'http-errors'

import {prisma} from '../../db/prisma.js'
import {normalizeEmail} from '../util/email.js'

export const MAX_DECLARANT_CONTACT_EMAILS = 20

export function normalizeDeclarantContactEmails(contactEmails) {
  if (!Array.isArray(contactEmails)) {
    throw createHttpError(400, 'Les emails de contact doivent être fournis dans un tableau.')
  }

  if (contactEmails.length > MAX_DECLARANT_CONTACT_EMAILS) {
    throw createHttpError(400, `Un déclarant ne peut pas avoir plus de ${MAX_DECLARANT_CONTACT_EMAILS} emails de contact.`)
  }

  const normalized = []
  const seen = new Set()
  let primaryCount = 0

  for (const contact of contactEmails) {
    if (!contact || typeof contact !== 'object' || Array.isArray(contact)) {
      throw createHttpError(400, 'Chaque email de contact doit être un objet.')
    }

    const email = normalizeEmail(contact.email)
    const isPrimary = contact.isPrimary === true

    if (email.endsWith('@import.local')) {
      throw createHttpError(400, 'Une adresse technique d’import ne peut pas être un email de contact.')
    }

    if (contact.isPrimary !== undefined && typeof contact.isPrimary !== 'boolean') {
      throw createHttpError(400, 'Le statut principal d’un email de contact doit être un booléen.')
    }

    if (seen.has(email)) {
      throw createHttpError(409, 'Un email de contact est présent plusieurs fois.')
    }

    if (isPrimary && ++primaryCount > 1) {
      throw createHttpError(400, 'Un seul email de contact peut être principal.')
    }

    seen.add(email)
    normalized.push({email, isPrimary})
  }

  return normalized
}

function publicSelect() {
  return {
    id: true,
    email: true,
    isPrimary: true
  }
}

function orderBy() {
  return [
    {isPrimary: 'desc'},
    {email: 'asc'}
  ]
}

async function ensureActiveDeclarant(declarantUserId, {client, lock = false}) {
  if (lock) {
    const rows = await client.$queryRaw(Prisma.sql`
      SELECT declarant."userId"
      FROM "Declarant" declarant
      JOIN "User" user_account ON user_account.id = declarant."userId"
      WHERE declarant."userId" = ${declarantUserId}::uuid
        AND user_account."deletedAt" IS NULL
      FOR UPDATE OF declarant
    `)

    if (rows.length > 0) {
      return rows[0]
    }
  } else {
    const declarant = await client.declarant.findFirst({
      where: {
        userId: declarantUserId,
        user: {deletedAt: null}
      },
      select: {userId: true}
    })

    if (declarant) {
      return declarant
    }
  }

  throw createHttpError(404, 'Déclarant introuvable.')
}

export async function listDeclarantContactEmails(declarantUserId, {
  client = prisma
} = {}) {
  await ensureActiveDeclarant(declarantUserId, {client})

  return client.declarantContactEmail.findMany({
    where: {declarantUserId},
    select: publicSelect(),
    orderBy: orderBy()
  })
}

export async function replaceDeclarantContactEmails(declarantUserId, contactEmails, {
  client = prisma
} = {}) {
  const normalized = normalizeDeclarantContactEmails(contactEmails)

  try {
    return await client.$transaction(async tx => {
      await ensureActiveDeclarant(declarantUserId, {client: tx, lock: true})

      const existing = await tx.declarantContactEmail.findMany({
        where: {declarantUserId},
        select: {
          id: true,
          email: true,
          isPrimary: true,
          sourceId: true
        }
      })
      const desiredByEmail = new Map(normalized.map(contact => [contact.email, contact]))
      const existingByEmail = new Map(existing.map(contact => [
        String(contact.email).trim().toLowerCase(),
        contact
      ]))
      const desiredPrimary = normalized.find(contact => contact.isPrimary)
      const existingPrimary = existing.find(contact => contact.isPrimary)

      if (existingPrimary
        && String(existingPrimary.email).trim().toLowerCase() !== desiredPrimary?.email) {
        await tx.declarantContactEmail.update({
          where: {id: existingPrimary.id},
          data: {isPrimary: false}
        })
      }

      const removedIds = existing
        .filter(contact => !desiredByEmail.has(String(contact.email).trim().toLowerCase()))
        .map(contact => contact.id)

      if (removedIds.length > 0) {
        await tx.declarantContactEmail.deleteMany({
          where: {id: {in: removedIds}}
        })
      }

      if (desiredPrimary) {
        const primaryContact = existingByEmail.get(desiredPrimary.email)

        if (primaryContact && !primaryContact.isPrimary) {
          await tx.declarantContactEmail.update({
            where: {id: primaryContact.id},
            data: {isPrimary: true}
          })
        }
      }

      const newContacts = normalized.filter(contact => !existingByEmail.has(contact.email))

      if (newContacts.length > 0) {
        await tx.declarantContactEmail.createMany({
          data: newContacts.map(contact => ({
            id: randomUUID(),
            declarantUserId,
            ...contact
          }))
        })
      }

      return tx.declarantContactEmail.findMany({
        where: {declarantUserId},
        select: publicSelect(),
        orderBy: orderBy()
      })
    }, {isolationLevel: Prisma.TransactionIsolationLevel.Serializable})
  } catch (error) {
    if (error?.code === 'P2002') {
      throw createHttpError(409, 'Les emails de contact ont été modifiés simultanément ou contiennent un doublon.')
    }

    if (error?.code === 'P2034'
      || error?.code === '40001'
      || error?.meta?.code === '40001'
      || error?.cause?.code === '40001') {
      throw createHttpError(409, 'Les emails de contact ont été modifiés simultanément. Rechargez-les puis réessayez.')
    }

    throw error
  }
}
