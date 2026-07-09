import '../lib/config/env.js'

import {prisma} from '../db/prisma.js'
import {NON_REJECTED_CHUNK_INSTRUCTION_STATUSES} from '../lib/constants/chunk-statuses.js'
import {buildChunkActorData, getDeclarantRole} from '../lib/services/chunk-actors.js'

const DEFAULT_BATCH_SIZE = 500

function hasArg(name) {
  return process.argv.includes(name)
}

function getArgValue(name) {
  const prefix = `${name}=`
  const match = process.argv.find(arg => arg.startsWith(prefix))
  return match ? match.slice(prefix.length) : null
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function activeWindowOverlapsWhere(chunk) {
  return {
    AND: [
      {OR: [{startDate: null}, {startDate: {lte: chunk.maxDate}}]},
      {OR: [{endDate: null}, {endDate: {gte: chunk.minDate}}]}
    ]
  }
}

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined)
  )
}

function getMetadataDeclarantId(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null
  }

  return typeof metadata.declarantId === 'string' ? metadata.declarantId : null
}

function getObjectMetadata(metadata) {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
}

function normalizeSiret(value) {
  const normalized = String(value ?? '').replaceAll(/\D/g, '')

  return normalized || null
}

function normalizeLabel(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('fr-FR')
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
}

function getExternalDeclarantFromMetadata(metadata) {
  const record = getObjectMetadata(metadata)
  const direct = getObjectMetadata(record.externalDeclarant)
  const nested = getObjectMetadata(getObjectMetadata(record.sourceMetadata).externalDeclarant)
  const externalDeclarant = Object.keys(direct).length > 0 ? direct : nested

  if (Object.keys(externalDeclarant).length === 0) {
    return null
  }

  return {
    sourceId: typeof externalDeclarant.sourceId === 'string' ? externalDeclarant.sourceId.trim() : null,
    name: typeof externalDeclarant.name === 'string' ? externalDeclarant.name.trim() : null,
    siret: normalizeSiret(externalDeclarant.siret)
  }
}

function sameValue(left, right) {
  return (left ?? null) === (right ?? null)
}

function changedValue(currentValue, targetValue) {
  return sameValue(currentValue, targetValue) ? undefined : targetValue
}

function buildChanges(chunk, actorData) {
  if (!actorData) {
    return {}
  }

  return compactObject({
    preleveurUserId: changedValue(chunk.preleveurUserId, actorData.preleveurUserId),
    submittedByDeclarantUserId: changedValue(
      chunk.submittedByDeclarantUserId,
      actorData.submittedByDeclarantUserId
    ),
    collecteurUserId: changedValue(chunk.collecteurUserId, actorData.collecteurUserId)
  })
}

function buildUnresolvedActorData(chunk, {collecteurUserId = null, submittedByDeclarantUserId = null} = {}) {
  return {
    preleveurUserId: chunk.preleveurUserId ?? null,
    submittedByDeclarantUserId: submittedByDeclarantUserId ?? chunk.submittedByDeclarantUserId ?? null,
    collecteurUserId: collecteurUserId ?? chunk.collecteurUserId ?? null
  }
}

function getSubmittedByDeclarantUserIdForDeclaration(declaration) {
  return declaration.createdByDeclarantUserId || declaration.declarantUserId
}

async function findActiveExploitationsForChunk(chunk, declarantUserId = null) {
  if (!chunk.pointPrelevementId || !chunk.minDate || !chunk.maxDate) {
    return []
  }

  return prisma.declarantPointPrelevement.findMany({
    where: {
      ...(declarantUserId ? {declarantUserId} : {}),
      pointPrelevementId: chunk.pointPrelevementId,
      ...activeWindowOverlapsWhere(chunk)
    },
    select: {
      id: true,
      declarantUserId: true,
      declarant: {
        select: {
          declarantRole: true,
          siret: true,
          socialReason: true,
          user: {
            select: {
              firstName: true,
              lastName: true
            }
          }
        }
      }
    }
  })
}

function serializeExploitationCandidate(exploitation) {
  return {
    exploitationId: exploitation.id,
    declarantUserId: exploitation.declarantUserId,
    declarantRole: exploitation.declarant?.declarantRole ?? null
  }
}

function filterPreleveurExploitations(exploitations, collecteurUserId = null) {
  return exploitations.filter(exploitation => {
    if (collecteurUserId && exploitation.declarantUserId === collecteurUserId) {
      return false
    }

    return exploitation.declarant?.declarantRole === 'PRELEVEUR'
  })
}

function getDeclarantLabels(declarant) {
  const user = declarant?.user ?? {}

  return [
    declarant?.socialReason,
    [user.firstName, user.lastName].filter(Boolean).join(' '),
    [user.lastName, user.firstName].filter(Boolean).join(' ')
  ].filter(Boolean)
}

function externalDeclarantNameMatches(declarant, externalDeclarant) {
  const externalName = normalizeLabel(externalDeclarant?.name)
  if (!externalName) {
    return false
  }

  const externalTokens = new Set(externalName.split(' ').filter(token => token.length > 1))

  return getDeclarantLabels(declarant).some(label => {
    const normalizedLabel = normalizeLabel(label)
    if (!normalizedLabel) {
      return false
    }

    if (normalizedLabel === externalName || normalizedLabel.includes(externalName) || externalName.includes(normalizedLabel)) {
      return true
    }

    const labelTokens = new Set(normalizedLabel.split(' ').filter(token => token.length > 1))

    return externalTokens.size > 0 && [...externalTokens].every(token => labelTokens.has(token))
  })
}

function exploitationMatchesExternalDeclarant(exploitation, externalDeclarant) {
  if (!externalDeclarant || !exploitation.declarant) {
    return false
  }

  if (externalDeclarant.siret && normalizeSiret(exploitation.declarant.siret) === externalDeclarant.siret) {
    return true
  }

  return externalDeclarantNameMatches(exploitation.declarant, externalDeclarant)
}

async function resolveActorsFromPoint(chunk, options = {}) {
  const {
    collecteurUserId = null,
    submittedByDeclarantUserId = null,
    resolutionPrefix = 'POINT'
  } = options
  const exploitations = await findActiveExploitationsForChunk(chunk)
  const candidates = filterPreleveurExploitations(exploitations, collecteurUserId)
  const externalDeclarant = getExternalDeclarantFromMetadata(chunk.metadata)
  const externalMatches = externalDeclarant
    ? candidates.filter(exploitation => exploitationMatchesExternalDeclarant(exploitation, externalDeclarant))
    : []
  const resolvedCandidates = externalMatches.length > 0 ? externalMatches : candidates

  if (resolvedCandidates.length === 1) {
    return {
      actorData: await buildChunkActorData({
        preleveurUserId: resolvedCandidates[0].declarantUserId,
        submittedByDeclarantUserId,
        client: prisma
      }),
      resolution: externalMatches.length === 1
        ? `${resolutionPrefix}_EXTERNAL_DECLARANT_MATCH`
        : `${resolutionPrefix}_ACTIVE_PRELEVEUR_EXPLOITATION`
    }
  }

  const actorData = collecteurUserId
    ? buildUnresolvedActorData(chunk, {
      collecteurUserId,
      submittedByDeclarantUserId
    })
    : null

  return {
    actorData,
    resolution: candidates.length === 0
      ? `${resolutionPrefix}_NO_ACTIVE_PRELEVEUR_EXPLOITATION`
      : `${resolutionPrefix}_MULTIPLE_ACTIVE_PRELEVEUR_EXPLOITATIONS`,
    candidates: candidates.map(serializeExploitationCandidate),
    ignoredCandidates: exploitations
      .filter(exploitation => !candidates.some(candidate => candidate.id === exploitation.id))
      .map(serializeExploitationCandidate)
  }
}

async function resolveActorsForChunk(chunk) {
  if (chunk.source?.declaration) {
    const {declaration} = chunk.source
    const declarantRole = declaration.declarant?.declarantRole
      ?? await getDeclarantRole(declaration.declarantUserId, prisma)

    if (declarantRole === 'COLLECTEUR') {
      return resolveActorsFromPoint(chunk, {
        collecteurUserId: declaration.declarantUserId,
        submittedByDeclarantUserId: getSubmittedByDeclarantUserIdForDeclaration(declaration),
        resolutionPrefix: 'COLLECTEUR_DECLARATION_POINT'
      })
    }

    return {
      actorData: await buildChunkActorData({
        preleveurUserId: declaration.declarantUserId,
        submittedByDeclarantUserId: getSubmittedByDeclarantUserIdForDeclaration(declaration),
        client: prisma
      }),
      resolution: 'DECLARATION'
    }
  }

  if (chunk.source?.apiImport?.declarantUserId) {
    return {
      actorData: await buildChunkActorData({
        preleveurUserId: chunk.source.apiImport.declarantUserId,
        client: prisma
      }),
      resolution: 'API_IMPORT'
    }
  }

  const metadataDeclarantId = getMetadataDeclarantId(chunk.source?.metadata)
  if (metadataDeclarantId) {
    return {
      actorData: await buildChunkActorData({
        preleveurUserId: metadataDeclarantId,
        client: prisma
      }),
      resolution: 'SOURCE_METADATA_DECLARANT'
    }
  }

  return resolveActorsFromPoint(chunk)
}

async function auditActorCoherence(chunk, actorData) {
  const issues = []

  if (!actorData?.preleveurUserId) {
    issues.push('MISSING_PRELEVEUR')
  }

  if (
    chunk.source?.declaration?.declarantUserId
    && actorData?.preleveurUserId
    && chunk.source.declaration.declarantUserId !== actorData.preleveurUserId
    && chunk.source.declaration.declarant?.declarantRole !== 'COLLECTEUR'
  ) {
    issues.push('DECLARATION_PRELEVEUR_MISMATCH')
  }

  if (chunk.pointPrelevementId && actorData?.preleveurUserId) {
    const exploitations = await findActiveExploitationsForChunk(chunk, actorData.preleveurUserId)

    if (exploitations.length === 0) {
      issues.push('POINT_NOT_ATTACHED_TO_PRELEVEUR_ON_PERIOD')
    }
  }

  if (chunk.pointPrelevementId && actorData?.collecteurUserId && actorData?.preleveurUserId) {
    const collecteurLink = await prisma.declarantCollecteurExploitation.findFirst({
      where: {
        collecteurUserId: actorData.collecteurUserId,
        exploitation: {
          declarantUserId: actorData.preleveurUserId,
          pointPrelevementId: chunk.pointPrelevementId,
          ...activeWindowOverlapsWhere(chunk)
        }
      },
      select: {
        id: true
      }
    })

    if (!collecteurLink) {
      issues.push('COLLECTEUR_NOT_ATTACHED_TO_EXPLOITATION_ON_PERIOD')
    }
  }

  return issues
}

function serializeChunk(chunk, extra = {}) {
  return {
    chunkId: chunk.id,
    sourceId: chunk.sourceId,
    declarationId: chunk.source?.declarationId ?? null,
    apiImportId: chunk.source?.apiImportId ?? null,
    pointPrelevementId: chunk.pointPrelevementId,
    minDate: chunk.minDate,
    maxDate: chunk.maxDate,
    current: {
      preleveurUserId: chunk.preleveurUserId,
      submittedByDeclarantUserId: chunk.submittedByDeclarantUserId,
      collecteurUserId: chunk.collecteurUserId
    },
    ...extra
  }
}

const apply = hasArg('--apply')
const summaryOnly = hasArg('--summary-only')
const batchSize = parsePositiveInteger(getArgValue('--batch-size'), DEFAULT_BATCH_SIZE)
const limit = parsePositiveInteger(getArgValue('--limit'), null)
const onlyMissing = hasArg('--only-missing')

const summary = {
  mode: apply ? 'apply' : 'dry-run',
  scanned: 0,
  updated: 0,
  wouldUpdate: 0,
  unresolvedCount: 0,
  coherenceIssueChunkCount: 0,
  coherenceIssueCounts: {},
  unresolved: [],
  coherenceIssues: []
}

function incrementCounter(counter, key) {
  counter[key] = (counter[key] ?? 0) + 1
}

let cursor = null

while (true) {
  const remaining = limit ? limit - summary.scanned : batchSize
  if (limit && remaining <= 0) {
    break
  }

  const chunks = await prisma.chunk.findMany({
    where: {
      ...(cursor ? {id: {gt: cursor}} : {}),
      ...(onlyMissing
        ? {
          OR: [
            {preleveurUserId: null},
            {submittedByDeclarantUserId: null}
          ]
        }
        : {})
    },
    take: Math.min(batchSize, remaining),
    orderBy: {
      id: 'asc'
    },
    include: {
      source: {
        include: {
          declaration: {
            select: {
              id: true,
              declarantUserId: true,
              createdByDeclarantUserId: true,
              declarant: {
                select: {
                  declarantRole: true
                }
              }
            }
          },
          apiImport: {
            select: {
              id: true,
              declarantUserId: true
            }
          }
        }
      },
      chunkValues: {
        take: 1,
        select: {
          id: true
        }
      }
    }
  })

  if (chunks.length === 0) {
    break
  }

  for (const chunk of chunks) {
    summary.scanned++

    const resolution = await resolveActorsForChunk(chunk)
    const {actorData} = resolution
    const changes = buildChanges(chunk, actorData)

    if (!actorData?.preleveurUserId) {
      summary.unresolvedCount++

      if (!summaryOnly) {
        summary.unresolved.push(serializeChunk(chunk, {
          resolution: resolution.resolution,
          candidates: resolution.candidates ?? [],
          ignoredCandidates: resolution.ignoredCandidates ?? []
        }))
      }
    }

    if (Object.keys(changes).length > 0) {
      if (apply) {
        await prisma.chunk.update({
          where: {id: chunk.id},
          data: changes
        })
        summary.updated++
      } else {
        summary.wouldUpdate++
      }
    }

    if (
      chunk.chunkValues.length > 0
      && chunk.source?.status === 'COMPLETED'
      && NON_REJECTED_CHUNK_INSTRUCTION_STATUSES.includes(chunk.instructionStatus)
    ) {
      const issues = await auditActorCoherence(chunk, actorData)

      if (issues.length > 0) {
        summary.coherenceIssueChunkCount++

        for (const issue of issues) {
          incrementCounter(summary.coherenceIssueCounts, issue)
        }

        if (!summaryOnly) {
          summary.coherenceIssues.push(serializeChunk(chunk, {
            resolution: resolution.resolution,
            target: actorData,
            issues
          }))
        }
      }
    }
  }

  cursor = chunks.at(-1).id
}

console.log(JSON.stringify(summary, null, 2))

await prisma.$disconnect()
