import '../../lib/config/env.js'
import process from 'node:process'
import {prisma} from '../../db/prisma.js'

const CONNECTOR_TYPE = 'omniscient_murgat'
const CONNECTOR_START_DATE = new Date('2021-10-12T08:00:00.000Z')
const CONNECTOR_START_DATE_PARAMETER = '2021-10-12T10:00:00+02:00'
const DECLARANT_SOURCE_ID
  = 'blv-pisciculteurs-template-file-murgat-declarant-06850221000013'
const EXPLOITATION_SOURCE_ID_PREFIX
  = 'blv-pisciculteurs-template-file-murgat-exploitation-06850221000013'
const POINT_SOURCE_ID_PREFIX = 'blv-pisciculteurs-template-file-murgat'

const METERS = [
  {compteurId: '38-2018-00234', label: 'Pompe A1'},
  {compteurId: '38-2017-00418', label: 'Pompe A2'},
  {compteurId: '38-2018-00243', label: 'Pompe A3'},
  {compteurId: '38-2018-00239', label: 'Pompe A4'},
  {compteurId: '38-2018-00236', label: 'Pompe A5'},
  {compteurId: '38-2018-00244', label: 'Pompe A6'},
  {compteurId: '38-2018-00235', label: 'Pompe E1'},
  {compteurId: '38-2018-00240', label: 'Pompe E2'},
  {compteurId: '38-2018-00242', label: 'Pompe P1'},
  {compteurId: '38-2017-00419', label: 'Pompe P2'},
  {compteurId: '38-2018-00247', label: 'Pompe P3'},
  {compteurId: '38-2018-00238', label: 'Pompe P4'},
  {compteurId: '38-2018-00241', label: 'Pompe P5'}
]

function parseArgValue(args, argName) {
  const arg = args.find(item => item.startsWith(`--${argName}=`))

  if (!arg) {
    return undefined
  }

  return arg.split('=').slice(1).join('=').replaceAll(/^["']|["']$/g, '')
}

function getPointSourceId(compteurId) {
  return `${POINT_SOURCE_ID_PREFIX}-${compteurId}`
}

function getExploitationSourceId(compteurId) {
  return `${EXPLOITATION_SOURCE_ID_PREFIX}-${compteurId}`
}

function getSourcePointIdFromConnector(connector) {
  const parameters = connector.connectorParameters

  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return null
  }

  const sourcePointId = [
    parameters.sourcePointId,
    parameters.compteurId,
    parameters.meterId
  ].find(value => typeof value === 'string' && value.trim())

  return sourcePointId ?? null
}

function buildConnectorParameters(meter) {
  return {
    sourcePointId: meter.compteurId,
    compteurId: meter.compteurId,
    compteurLabel: meter.label,
    site: 'pisciculture-murgat',
    baseUrl: 'https://o-mniscient.org',
    chartPathTemplate: '/api/compteur/chart/{date}/{compteur}',
    sourceUnit: 'litre',
    targetUnit: 'm3',
    granularity: '1 hour',
    startDate: CONNECTOR_START_DATE_PARAMETER
  }
}

function appendUsage(usages, usage) {
  const values = Array.isArray(usages) ? usages : []

  return [...new Set([...values, usage])]
}

async function resolveServiceAccountId(explicitServiceAccountId) {
  if (explicitServiceAccountId) {
    const serviceAccount = await prisma.serviceAccount.findFirst({
      where: {
        id: explicitServiceAccountId,
        deletedAt: null
      },
      select: {
        id: true,
        name: true
      }
    })

    if (!serviceAccount) {
      throw new Error(`Service account introuvable: ${explicitServiceAccountId}`)
    }

    return serviceAccount.id
  }

  const serviceAccounts = await prisma.serviceAccount.findMany({
    where: {
      isActive: true,
      deletedAt: null
    },
    select: {
      id: true,
      name: true
    },
    orderBy: {
      createdAt: 'asc'
    }
  })

  if (serviceAccounts.length === 1) {
    return serviceAccounts[0].id
  }

  if (serviceAccounts.length > 1) {
    console.warn(
      '[murgat-omniscient] Plusieurs service accounts actifs trouvés. '
      + 'Aucun rattachement automatique ne sera créé; relancer avec --service-account-id=<id>.'
    )

    for (const serviceAccount of serviceAccounts) {
      console.warn(`  - ${serviceAccount.name} (${serviceAccount.id})`)
    }
  } else {
    console.warn(
      '[murgat-omniscient] Aucun service account actif trouvé. '
      + 'Les connecteurs seront créés, mais l’orchestrateur ne les verra pas avant rattachement.'
    )
  }

  return null
}

async function resolveDeclarant() {
  const declarant = await prisma.declarant.findUnique({
    where: {
      sourceId: DECLARANT_SOURCE_ID
    },
    include: {
      user: true
    }
  })

  if (!declarant) {
    throw new Error(
      `Déclarant Murgat introuvable (${DECLARANT_SOURCE_ID}). `
      + 'Lancer d’abord les imports BLV template-files.'
    )
  }

  return declarant
}

async function resolvePoint(meter) {
  return prisma.pointPrelevement.findFirst({
    where: {
      deletedAt: null,
      OR: [
        {sourceId: getPointSourceId(meter.compteurId)},
        {name: meter.compteurId}
      ]
    },
    select: {
      id: true,
      name: true,
      sourceId: true
    }
  })
}

async function resolveExploitation(declarantUserId, point, meter) {
  return prisma.declarantPointPrelevement.findFirst({
    where: {
      OR: [
        {sourceId: getExploitationSourceId(meter.compteurId)},
        {
          declarantUserId,
          pointPrelevementId: point.id
        }
      ]
    },
    include: {
      connectors: {
        where: {
          connectorType: CONNECTOR_TYPE
        },
        orderBy: {
          createdAt: 'asc'
        }
      }
    }
  })
}

async function resolveMappings(declarantUserId) {
  const mappings = []
  const missing = []

  for (const meter of METERS) {
    const point = await resolvePoint(meter)

    if (!point) {
      missing.push(`point ${meter.compteurId}`)
      continue
    }

    const exploitation = await resolveExploitation(declarantUserId, point, meter)

    if (!exploitation) {
      missing.push(`exploitation ${meter.compteurId} (${point.id})`)
      continue
    }

    mappings.push({
      meter,
      point,
      exploitation
    })
  }

  if (missing.length > 0) {
    throw new Error(
      `Configuration incomplète, éléments introuvables: ${missing.join(', ')}`
    )
  }

  return mappings
}

function findExistingConnector(exploitation, meter) {
  return exploitation.connectors.find(
    connector => getSourcePointIdFromConnector(connector) === meter.compteurId
  ) ?? exploitation.connectors[0] ?? null
}

async function upsertServiceAccountDeclarant(tx, serviceAccountId, declarantUserId) {
  if (!serviceAccountId) {
    return false
  }

  const existingLink = await tx.serviceAccountDeclarant.findFirst({
    where: {
      serviceAccountId,
      declarantUserId
    },
    orderBy: {
      startDate: 'asc'
    }
  })

  if (existingLink) {
    await tx.serviceAccountDeclarant.update({
      where: {
        id: existingLink.id
      },
      data: {
        endDate: null
      }
    })

    return false
  }

  await tx.serviceAccountDeclarant.create({
    data: {
      serviceAccountId,
      declarantUserId,
      startDate: CONNECTOR_START_DATE
    }
  })

  return true
}

async function getExistingConnectorDataCounts(client = prisma) {
  const [sourceRows, chunkRows, chunkValueRows] = await Promise.all([
    client.$queryRaw`
      SELECT COUNT(*)::int AS count
      FROM "Source"
      WHERE metadata->>'connector' = ${CONNECTOR_TYPE}
    `,
    client.$queryRaw`
      SELECT COUNT(*)::int AS count
      FROM "Chunk"
      WHERE metadata->>'connector' = ${CONNECTOR_TYPE}
    `,
    client.$queryRaw`
      SELECT COUNT(*)::int AS count
      FROM "ChunkValue" cv
      JOIN "Chunk" c ON c.id = cv."chunkId"
      WHERE c.metadata->>'connector' = ${CONNECTOR_TYPE}
    `
  ])

  return {
    sources: sourceRows[0]?.count ?? 0,
    chunks: chunkRows[0]?.count ?? 0,
    chunkValues: chunkValueRows[0]?.count ?? 0
  }
}

async function deleteExistingConnectorData(tx) {
  const deletedSources = await tx.$queryRaw`
    DELETE FROM "Source"
    WHERE metadata->>'connector' = ${CONNECTOR_TYPE}
    RETURNING id
  `

  return deletedSources.length
}

async function applyConfiguration({
  dryRun,
  keepMostRecent,
  resetExistingConnectorData,
  serviceAccountId,
  declarant,
  mappings
}) {
  if (dryRun) {
    console.log('[murgat-omniscient] Dry-run, aucune écriture.')

    if (resetExistingConnectorData) {
      const counts = await getExistingConnectorDataCounts()
      console.log(
        '[murgat-omniscient] resetExistingConnectorData supprimerait '
        + `${counts.sources} sources, ${counts.chunks} chunks, ${counts.chunkValues} valeurs.`
      )
    }

    for (const mapping of mappings) {
      const existingConnector = findExistingConnector(
        mapping.exploitation,
        mapping.meter
      )
      const action = existingConnector ? 'update' : 'create'

      console.log(
        `[murgat-omniscient] ${action} exploitation=${mapping.exploitation.id} `
        + `point=${mapping.point.name} compteur=${mapping.meter.compteurId} `
        + `rate=100 resetMostRecent=${!keepMostRecent}`
      )
    }

    if (serviceAccountId) {
      console.log(
        `[murgat-omniscient] serviceAccountDeclarant declarant=${declarant.userId} serviceAccount=${serviceAccountId}`
      )
    }

    return
  }

  const result = await prisma.$transaction(async tx => {
    let createdConnectors = 0
    let updatedConnectors = 0
    let deletedSources = 0

    if (resetExistingConnectorData) {
      deletedSources = await deleteExistingConnectorData(tx)
    }

    const linkedServiceAccount = await upsertServiceAccountDeclarant(
      tx,
      serviceAccountId,
      declarant.userId
    )

    for (const mapping of mappings) {
      const connectorParameters = buildConnectorParameters(mapping.meter)
      const existingConnector = findExistingConnector(
        mapping.exploitation,
        mapping.meter
      )

      if (existingConnector) {
        await tx.declarantPointPrelevementConnector.update({
          where: {
            id: existingConnector.id
          },
          data: {
            connectorParameters,
            rate: 100
          }
        })
        updatedConnectors++
      } else {
        await tx.declarantPointPrelevementConnector.create({
          data: {
            declarantPointPrelevementId: mapping.exploitation.id,
            connectorType: CONNECTOR_TYPE,
            connectorParameters,
            rate: 100
          }
        })
        createdConnectors++
      }

      await tx.declarantPointPrelevement.update({
        where: {
          id: mapping.exploitation.id
        },
        data: {
          usages: appendUsage(mapping.exploitation.usages, 'AQUACULTURE'),
          ...(keepMostRecent ? {} : {mostRecentAvailableDate: null})
        }
      })
    }

    return {
      createdConnectors,
      updatedConnectors,
      deletedSources,
      linkedServiceAccount
    }
  })

  console.log(
    `[murgat-omniscient] terminé: created=${result.createdConnectors}, `
    + `updated=${result.updatedConnectors}, deletedSources=${result.deletedSources}, `
    + `serviceAccountLinked=${result.linkedServiceAccount}`
  )
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const keepMostRecent = args.includes('--keep-most-recent')
  const resetExistingConnectorData = args.includes('--reset-existing-connector-data')
  const explicitServiceAccountId = parseArgValue(args, 'service-account-id')

  console.log('[murgat-omniscient] start')
  console.log(`[murgat-omniscient] connectorType=${CONNECTOR_TYPE}`)
  console.log(`[murgat-omniscient] bootstrapStartDate=${CONNECTOR_START_DATE.toISOString()}`)
  console.log(`[murgat-omniscient] keepMostRecent=${keepMostRecent}`)
  console.log(`[murgat-omniscient] resetExistingConnectorData=${resetExistingConnectorData}`)

  const [declarant, serviceAccountId] = await Promise.all([
    resolveDeclarant(),
    resolveServiceAccountId(explicitServiceAccountId)
  ])

  const mappings = await resolveMappings(declarant.userId)

  console.log(
    `[murgat-omniscient] déclarant=${declarant.user.email} (${declarant.userId}), compteurs=${mappings.length}`
  )

  await applyConfiguration({
    dryRun,
    keepMostRecent,
    resetExistingConnectorData,
    serviceAccountId,
    declarant,
    mappings
  })
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
