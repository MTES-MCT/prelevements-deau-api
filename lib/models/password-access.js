import {createHash, randomBytes, randomUUID} from 'node:crypto'

import {prisma} from '../../db/prisma.js'
import {createSessionToken} from './session-token.js'

export const PASSWORD_ACTIVATION_TTL_SECONDS = 72 * 60 * 60

export function generatePasswordActivationToken() {
  return randomBytes(32).toString('base64url')
}

export function hashPasswordActivationToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex')
}

function getUserSessionsWhere(userId) {
  return {
    OR: [
      {userId},
      {impersonatedByUserId: userId}
    ]
  }
}

export async function getPasswordCredential(userId, {client = prisma} = {}) {
  return client.passwordCredential.findUnique({where: {userId}})
}

export async function lockPasswordAccessUser(userId, {client = prisma} = {}) {
  const rows = await client.$queryRaw`
    SELECT "id"
    FROM "User"
    WHERE "id" = ${userId}::uuid
    FOR UPDATE
  `

  return rows.length === 1
}

export async function updatePasswordCredentialHash(userId, credential, {client = prisma} = {}) {
  return client.passwordCredential.updateMany({
    where: {userId},
    data: credential
  })
}

export async function lockPasswordCredential(userId, expectedCredential, {
  client = prisma,
  lockUser = lockPasswordAccessUser
} = {}) {
  if (!await lockUser(userId, {client})) {
    return false
  }

  const rows = await client.$queryRaw`
    SELECT "userId"
    FROM "PasswordCredential"
    WHERE "userId" = ${userId}::uuid
      AND "passwordHash" = ${expectedCredential.passwordHash}
      AND "pepperVersion" = ${expectedCredential.pepperVersion}
    FOR UPDATE
  `

  return rows.length === 1
}

export async function listPasswordAccesses({search, limit = 50}, {client = prisma} = {}) {
  const normalizedSearch = typeof search === 'string' ? search.trim() : ''
  const searchWhere = normalizedSearch
    ? {
      OR: [
        {email: {contains: normalizedSearch, mode: 'insensitive'}},
        {firstName: {contains: normalizedSearch, mode: 'insensitive'}},
        {lastName: {contains: normalizedSearch, mode: 'insensitive'}}
      ]
    }
    : {}

  return client.user.findMany({
    where: {
      deletedAt: null,
      email: {not: null},
      ...searchWhere
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      passwordCredential: {
        select: {
          createdAt: true,
          updatedAt: true,
          pepperVersion: true
        }
      },
      passwordActivation: {
        select: {
          createdAt: true,
          expiresAt: true
        }
      }
    },
    orderBy: [
      {lastName: 'asc'},
      {firstName: 'asc'},
      {email: 'asc'}
    ],
    take: limit
  })
}

export async function issuePasswordActivation(userId, {
  createdByUserId = null,
  ttlSeconds = PASSWORD_ACTIVATION_TTL_SECONDS,
  client = prisma,
  lockUser = lockPasswordAccessUser,
  now = new Date()
} = {}) {
  const token = generatePasswordActivationToken()
  const tokenHash = hashPasswordActivationToken(token)
  const expiresAt = new Date(now.getTime() + (ttlSeconds * 1000))

  const result = await client.$transaction(async transaction => {
    if (!await lockUser(userId, {client: transaction})) {
      return null
    }

    const user = await transaction.user.findFirst({
      where: {
        id: userId,
        deletedAt: null,
        email: {not: null}
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true
      }
    })

    if (!user) {
      return null
    }

    const existingCredential = await transaction.passwordCredential.findUnique({
      where: {userId},
      select: {userId: true}
    })

    let sessionsRevoked = 0
    if (existingCredential) {
      await transaction.passwordCredential.delete({where: {userId}})
      const deletedSessions = await transaction.sessionToken.deleteMany({
        where: getUserSessionsWhere(userId)
      })
      sessionsRevoked = deletedSessions.count
    }

    await transaction.passwordActivation.deleteMany({where: {userId}})

    const activation = await transaction.passwordActivation.create({
      data: {
        id: randomUUID(),
        tokenHash,
        userId,
        createdByUserId,
        expiresAt
      },
      select: {
        createdAt: true,
        expiresAt: true
      }
    })

    return {
      user,
      activation,
      reset: Boolean(existingCredential),
      sessionsRevoked
    }
  })

  return result ? {...result, token} : null
}

export async function getPasswordActivation(token, {
  client = prisma,
  now = new Date()
} = {}) {
  return client.passwordActivation.findFirst({
    where: {
      tokenHash: hashPasswordActivationToken(token),
      expiresAt: {gt: now},
      user: {deletedAt: null, email: {not: null}}
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          deletedAt: true
        }
      }
    }
  })
}

export async function consumePasswordActivation(token, credential, {
  client = prisma,
  lockUser = lockPasswordAccessUser,
  now = new Date()
} = {}) {
  const tokenHash = hashPasswordActivationToken(token)

  return client.$transaction(async transaction => {
    const candidate = await transaction.passwordActivation.findFirst({
      where: {
        tokenHash,
        expiresAt: {gt: now},
        user: {deletedAt: null, email: {not: null}}
      },
      select: {userId: true}
    })

    if (!candidate || !await lockUser(candidate.userId, {client: transaction})) {
      return null
    }

    const activation = await transaction.passwordActivation.findFirst({
      where: {
        tokenHash,
        expiresAt: {gt: now},
        user: {deletedAt: null, email: {not: null}}
      },
      include: {
        user: {
          select: {
            id: true,
            role: true
          }
        }
      }
    })

    if (!activation) {
      return null
    }

    await transaction.passwordCredential.upsert({
      where: {userId: activation.userId},
      create: {
        userId: activation.userId,
        ...credential
      },
      update: credential
    })
    await transaction.passwordActivation.delete({where: {id: activation.id}})
    await transaction.sessionToken.deleteMany({
      where: getUserSessionsWhere(activation.userId)
    })

    return createSessionToken(
      activation.userId,
      activation.user.role,
      undefined,
      {client: transaction}
    )
  })
}

export async function replacePasswordCredential(user, credential, {
  client = prisma,
  expectedCredential,
  lockCredential = lockPasswordCredential
} = {}) {
  return client.$transaction(async transaction => {
    const locked = await lockCredential(user.id, expectedCredential, {client: transaction})
    if (!locked) {
      return null
    }

    await transaction.passwordCredential.update({
      where: {userId: user.id},
      data: credential
    })
    await transaction.passwordActivation.deleteMany({where: {userId: user.id}})
    await transaction.sessionToken.deleteMany({
      where: getUserSessionsWhere(user.id)
    })

    return createSessionToken(user.id, user.role, undefined, {client: transaction})
  })
}

export async function revokePasswordAccess(userId, {
  client = prisma,
  lockUser = lockPasswordAccessUser
} = {}) {
  return client.$transaction(async transaction => {
    if (!await lockUser(userId, {client: transaction})) {
      return null
    }

    const user = await transaction.user.findFirst({
      where: {id: userId, deletedAt: null},
      select: {id: true, email: true, firstName: true, lastName: true, role: true}
    })

    if (!user) {
      return null
    }

    const [credentials, activations, sessions] = await Promise.all([
      transaction.passwordCredential.deleteMany({where: {userId}}),
      transaction.passwordActivation.deleteMany({where: {userId}}),
      transaction.sessionToken.deleteMany({where: getUserSessionsWhere(userId)})
    ])

    return {
      user,
      revoked: credentials.count > 0 || activations.count > 0,
      sessionsRevoked: sessions.count
    }
  })
}
