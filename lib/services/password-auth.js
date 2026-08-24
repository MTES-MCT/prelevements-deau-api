import {prisma} from '../../db/prisma.js'
import {
  consumePasswordActivation,
  getPasswordActivation,
  getPasswordCredential,
  lockPasswordCredential,
  replacePasswordCredential,
  updatePasswordCredentialHash
} from '../models/password-access.js'
import {createSessionToken} from '../models/session-token.js'
import {getAuthUserByEmail} from '../models/user.js'
import {normalizeEmail} from '../util/email.js'
import {
  hashPassword,
  runDummyPasswordVerification,
  validatePasswordPolicy,
  verifyPassword
} from '../util/password.js'

function getUserPasswordInputs(user) {
  const emailLocalPart = user.email?.split('@')[0]
  return [user.email, emailLocalPart, user.firstName, user.lastName]
}

function isInvalidRawEmail(email) {
  return typeof email !== 'string' || email.length > 320
}

export async function authenticateWithPassword(email, password, {
  client = prisma,
  findUserByEmail = getAuthUserByEmail,
  findCredential = getPasswordCredential,
  verify = verifyPassword,
  verifyDummy = runDummyPasswordVerification,
  createSession = createSessionToken,
  hash = hashPassword,
  lockCredential = lockPasswordCredential,
  updateCredentialHash = updatePasswordCredentialHash,
  now = new Date()
} = {}) {
  if (isInvalidRawEmail(email)) {
    await verifyDummy(password)
    return null
  }

  let normalizedEmail
  try {
    normalizedEmail = normalizeEmail(email)
  } catch {
    await verifyDummy(password)
    return null
  }

  const user = await findUserByEmail(normalizedEmail, {client})
  const credential = user ? await findCredential(user.id, {client}) : null

  if (!user || !credential) {
    await verifyDummy(password)
    return null
  }

  const verification = await verify(password, credential)
  if (!verification.valid) {
    return {user, session: null}
  }

  let replacementCredential = null
  if (verification.needsRehash) {
    replacementCredential = await hash(password)
  }

  const session = await client.$transaction(async transaction => {
    const locked = await lockCredential(user.id, credential, {client: transaction})
    if (!locked) {
      return null
    }

    if (replacementCredential) {
      await updateCredentialHash(user.id, replacementCredential, {client: transaction})
    }

    const createdSession = await createSession(user.id, user.role, undefined, {client: transaction})
    await transaction.user.update({
      where: {id: user.id},
      data: {lastLoginAt: now}
    })
    return createdSession
  })

  return {user, session}
}

export async function activatePassword(token, password, {
  client = prisma,
  findActivation = getPasswordActivation,
  consumeActivation = consumePasswordActivation,
  hash = hashPassword,
  now = new Date()
} = {}) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 512) {
    return null
  }

  const activation = await findActivation(token, {client, now})
  if (!activation) {
    return null
  }

  const normalizedPassword = validatePasswordPolicy(
    password,
    getUserPasswordInputs(activation.user)
  )
  const credential = await hash(normalizedPassword)
  const session = await consumeActivation(token, credential, {client, now})

  return session ? {user: activation.user, session} : null
}

export async function changePassword(user, currentPassword, newPassword, {
  client = prisma,
  findCredential = getPasswordCredential,
  verify = verifyPassword,
  verifyDummy = runDummyPasswordVerification,
  hash = hashPassword,
  replaceCredential = replacePasswordCredential
} = {}) {
  const credential = await findCredential(user.id, {client})
  if (!credential) {
    await verifyDummy(currentPassword)
    return null
  }

  const verification = await verify(currentPassword, credential)
  if (!verification.valid) {
    return null
  }

  const normalizedPassword = validatePasswordPolicy(
    newPassword,
    getUserPasswordInputs(user)
  )
  const replacement = await hash(normalizedPassword)
  return replaceCredential(user, replacement, {
    client,
    expectedCredential: credential
  })
}
