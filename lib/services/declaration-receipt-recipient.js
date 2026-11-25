import {getEditableQuickDeclaration} from '../handlers/quick-correction.js'
import {isPreleveurEmailIdentity} from '../models/preleveur-login.js'
import {getPreleveurPrincipalEmail} from '../models/preleveur-email.js'
import {normalizeEmail} from '../util/email.js'

const accountFields = {
  id: true, role: true, deletedAt: true, firstName: true, lastName: true, email: true,
  declarant: {select: {declarantRole: true, email: true, socialReason: true}}
}

export function receiptAccount(client, id) {
  return id ? client.user.findUnique({where: {id}, select: accountFields}) : null
}

export function receiptName(account) {
  return [account?.firstName, account?.lastName].filter(Boolean).join(' ').trim() || null
}

function personalAddress(value) {
  try {
    const email = normalizeEmail(value, {required: false})
    return email?.endsWith('@import.local') ? null : email
  } catch {
    // An invalid address on an old account must not prevent a declaration.
    return null
  }
}

function accountAddresses(account) {
  const primary = personalAddress(account?.email)
  const profile = account?.declarant?.declarantRole === 'PRELEVEUR'
    ? personalAddress(getPreleveurPrincipalEmail(account))
    : null
  return {primary, profile}
}

function historicalAddress(account) {
  const {primary, profile} = accountAddresses(account)
  if (primary && profile && primary !== profile) return null
  return primary ?? profile
}

function matchesDepositor(account, profile, email) {
  if (!email || !account || !profile || account.deletedAt || profile.deletedAt
    || account.role !== 'DECLARANT' || profile.role !== 'DECLARANT') return false
  if (account.id !== profile.id) {
    return isPreleveurEmailIdentity(account, email) && isPreleveurEmailIdentity(profile, email)
  }
  const addresses = accountAddresses(account)
  return email === addresses.primary || email === addresses.profile
}

async function creationRecipient(client, req, profile) {
  if (req.auth?.preleveurProfiles && !req.auth.impersonation && req.authActor) {
    const account = req.authActor.id === profile?.id ? profile : await receiptAccount(client, req.authActor.id)
    return {account, email: personalAddress(req.authActor.email)}
  }
  const {primary, profile: profileAddress} = accountAddresses(profile)
  return {account: profile, email: req.auth?.impersonation ? profileAddress ?? primary : primary ?? profileAddress}
}

async function correctionRecipient(client, declarationId, profile) {
  // Older declarations may have no receipt. Only use their recorded submitter.
  const original = await client.declarationReceipt.findFirst({where: {declarationId},
    orderBy: {revision: 'asc'}, select: {recipientUserId: true, recipientEmail: true}})
  const account = original && original.recipientUserId !== profile?.id ? await receiptAccount(client, original.recipientUserId) : profile
  let email = personalAddress(original?.recipientEmail)
  if (!matchesDepositor(account, profile, email) && account?.id === profile?.id) email = historicalAddress(account)
  return {account, email}
}

export async function resolveReceiptRecipient(client, req, declaration, revision) {
  const profile = await receiptAccount(client, declaration.createdByDeclarantUserId)
  const {account, email} = revision === 0 ? await creationRecipient(client, req, profile)
    : await correctionRecipient(client, declaration.id, profile)
  return {
    recipientUserId: account?.id ?? null,
    recipientName: receiptName(account),
    recipientEmail: matchesDepositor(account, profile, email) ? email : null
  }
}

export async function getReceiptDeliveryAccess(client, receipt) {
  const declaration = await client.declaration.findUnique({where: {id: receipt.declarationId},
    select: {createdByDeclarantUserId: true}})
  const profile = await receiptAccount(client, declaration?.createdByDeclarantUserId)
  const account = profile?.id === receipt.recipientUserId ? profile : await receiptAccount(client, receipt.recipientUserId)
  if (!matchesDepositor(account, profile, personalAddress(receipt.recipientEmail))) return {deliver: false, canEdit: false}
  // The submitter can always consult their own deposit. Editing has the
  // stricter rules of the actual form and is not available for file deposits.
  if (receipt.kind === 'FILES_RECEIVED') return {deliver: true, canEdit: false}
  try {
    const draft = await getEditableQuickDeclaration(client, profile, receipt.declarationId)
    return {deliver: true, canEdit: draft.entries.length > 0}
  } catch (error) {
    if (![400, 403, 404, 409].includes(error.statusCode)) throw error
    return {deliver: true, canEdit: false}
  }
}
