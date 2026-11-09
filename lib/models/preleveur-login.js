import {prisma} from '../../db/prisma.js'
import {normalizeEmail} from '../util/email.js'
import {getAuthUserByEmail} from './user.js'

export function isPreleveurEmailIdentity(user, email) {
  return Boolean(email && user && !user.deletedAt && user.role === 'DECLARANT'
    && user.declarant?.declarantRole === 'PRELEVEUR'
    && user.declarant.email?.toLowerCase() === email.toLowerCase())
}

export function isDetachedPreleveurCanonical(user) {
  return user?.role === 'DECLARANT' && user.declarant?.declarantRole === 'PRELEVEUR'
    && !isPreleveurEmailIdentity(user, user.email)
}

export async function listPreleveurEmailProfiles(email, {client = prisma} = {}) {
  const normalized = normalizeEmail(email)
  if (normalized.endsWith('@import.local')) return []
  return client.user.findMany({where: {role: 'DECLARANT', deletedAt: null,
    declarant: {declarantRole: 'PRELEVEUR', email: normalized}},
  select: {id: true, email: true, role: true, authVersion: true, firstName: true, lastName: true,
    declarant: {select: {declarantRole: true, email: true, socialReason: true, siret: true, city: true}}},
  orderBy: {id: 'asc'}})
}

export async function resolveMagicLinkUser(email, {client = prisma} = {}) {
  const normalized = normalizeEmail(email)
  const legacy = await getAuthUserByEmail(normalized, {client})
  // A privileged account or a legacy alias authenticates that account only.
  // Neither may acquire another person's profile through a matching contact.
  if (legacy && (legacy.role !== 'DECLARANT'
    || legacy.declarant?.declarantRole !== 'PRELEVEUR'
    || legacy.email?.toLowerCase() !== normalized)) return legacy
  const profiles = await listPreleveurEmailProfiles(normalized, {client})
  if (!profiles.length) return null
  const user = profiles.find(profile => profile.id === legacy?.id) ?? profiles[0]
  return {...user, loginEmail: normalized}
}

export async function preleveurSessionOptions(user, email, {client = prisma} = {}) {
  if (!isPreleveurEmailIdentity(user, email)) return {}
  const profiles = await listPreleveurEmailProfiles(email, {client})
  if (!profiles.some(profile => profile.id === user.id)) return {}
  return {loginEmail: normalizeEmail(email), profileUserId: user.id, profileAuthVersion: user.authVersion,
    profileSelectionRequired: profiles.length > 1}
}

export function publicPreleveurProfile(user) {
  return {id: user.id, firstName: user.firstName, lastName: user.lastName,
    socialReason: user.declarant.socialReason, siret: user.declarant.siret, city: user.declarant.city}
}
