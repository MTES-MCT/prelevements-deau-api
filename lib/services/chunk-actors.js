import {prisma} from '../../db/prisma.js'

export async function getDeclarantRole(declarantUserId, client = prisma) {
  if (!declarantUserId) {
    return null
  }

  const declarant = await client.declarant.findUnique({
    where: {
      userId: declarantUserId
    },
    select: {
      declarantRole: true
    }
  })

  return declarant?.declarantRole ?? null
}

export async function buildChunkActorData({
  preleveurUserId,
  matchedPreleveurUserId = null,
  submittedByDeclarantUserId = null,
  client = prisma
}) {
  const effectivePreleveurUserId = matchedPreleveurUserId || preleveurUserId || null
  const effectiveSubmittedByDeclarantUserId = submittedByDeclarantUserId || preleveurUserId || null
  let collecteurUserId = null

  if (
    effectiveSubmittedByDeclarantUserId
    && (!effectivePreleveurUserId || effectiveSubmittedByDeclarantUserId !== effectivePreleveurUserId)
  ) {
    const role = await getDeclarantRole(effectiveSubmittedByDeclarantUserId, client)
    collecteurUserId = role === 'COLLECTEUR' ? effectiveSubmittedByDeclarantUserId : null
  }

  return {
    preleveurUserId: effectivePreleveurUserId,
    submittedByDeclarantUserId: effectiveSubmittedByDeclarantUserId,
    collecteurUserId
  }
}
