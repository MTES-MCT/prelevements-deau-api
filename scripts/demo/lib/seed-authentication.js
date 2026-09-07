const ACTIVE_EMAIL_VERIFICATION_STATUSES = ['PENDING', 'SEND_FAILED']

function normalizedEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : null
}

function identityChanges(existing, expected) {
  return {
    email: normalizedEmail(existing.email) !== normalizedEmail(expected.email),
    role: existing.role !== expected.role,
    restoration: existing.deletedAt !== null
  }
}

function count(result) {
  return Number(result?.count ?? 0)
}

export async function resetPersonaAuthentication({database, userRecords}) {
  const personas = userRecords.filter(record =>
    typeof record.email === 'string' && record.email.length > 0)
  const personaUserIds = personas.map(record => record.id)

  if (personaUserIds.length !== 6 || new Set(personaUserIds).size !== 6) {
    throw new Error('Le nettoyage d’authentification requiert exactement six personas uniques')
  }

  await database.$queryRawUnsafe(`
    SELECT id
    FROM "User"
    WHERE id IN (
      SELECT value::uuid
      FROM jsonb_array_elements_text($1::jsonb)
    )
    ORDER BY id
    FOR UPDATE
  `, JSON.stringify(personaUserIds))

  const existingUsers = await database.user.findMany({
    where: {id: {in: personaUserIds}},
    select: {
      id: true,
      email: true,
      role: true,
      deletedAt: true,
      emailAliases: {select: {id: true}}
    }
  })
  const expectedById = new Map(personas.map(record => [record.id, record]))
  const changedUserIds = new Set()
  const automaticallyIncrementedUserIds = new Set()
  for (const user of existingUsers) {
    const changes = identityChanges(user, expectedById.get(user.id))
    const hasAliases = (user.emailAliases ?? []).length > 0
    if (changes.email || changes.role || changes.restoration || hasAliases) {
      changedUserIds.add(user.id)
    }

    if (changes.email || hasAliases) {
      automaticallyIncrementedUserIds.add(user.id)
    }
  }

  const now = new Date()
  const cancelledVerifications = await database.userEmailVerification.updateMany({
    where: {
      userId: {in: personaUserIds},
      status: {in: ACTIVE_EMAIL_VERIFICATION_STATUSES}
    },
    data: {
      status: 'CANCELLED',
      tokenHash: null,
      cancelledAt: now
    }
  })
  const clearedVerificationTokens = await database.userEmailVerification.updateMany({
    where: {
      userId: {in: personaUserIds},
      tokenHash: {not: null}
    },
    data: {tokenHash: null}
  })
  const aliases = await database.userEmailAlias.deleteMany({
    where: {userId: {in: personaUserIds}}
  })
  const passwordCredentials = await database.passwordCredential.deleteMany({
    where: {userId: {in: personaUserIds}}
  })
  const passwordActivations = await database.passwordActivation.deleteMany({
    where: {userId: {in: personaUserIds}}
  })
  const revokedUserIds = [...changedUserIds]
  const authTokens = revokedUserIds.length === 0
    ? {count: 0}
    : await database.authToken.deleteMany({
      where: {userId: {in: revokedUserIds}}
    })
  const sessionTokens = revokedUserIds.length === 0
    ? {count: 0}
    : await database.sessionToken.deleteMany({
      where: {
        OR: [
          {userId: {in: revokedUserIds}},
          {impersonatedByUserId: {in: revokedUserIds}}
        ]
      }
    })
  const explicitlyIncrementedUserIds = revokedUserIds.filter(userId =>
    !automaticallyIncrementedUserIds.has(userId))
  const incrementedAuthVersions = explicitlyIncrementedUserIds.length === 0
    ? {count: 0}
    : await database.user.updateMany({
      where: {id: {in: explicitlyIncrementedUserIds}},
      data: {authVersion: {increment: 1}}
    })

  return {
    personaUsers: personaUserIds.length,
    existingPersonaUsers: existingUsers.length,
    changedUsers: changedUserIds.size,
    authVersionsIncrementedExplicitly: count(incrementedAuthVersions),
    aliasesDeleted: count(aliases),
    emailVerificationsCancelled: count(cancelledVerifications),
    emailVerificationTokensCleared: count(clearedVerificationTokens),
    passwordCredentialsDeleted: count(passwordCredentials),
    passwordActivationsDeleted: count(passwordActivations),
    authTokensDeleted: count(authTokens),
    sessionTokensDeleted: count(sessionTokens)
  }
}
