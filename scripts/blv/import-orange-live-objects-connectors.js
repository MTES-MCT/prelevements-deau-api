import '../../lib/config/env.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {parse} from 'csv-parse/sync'
import {prisma} from '../../db/prisma.js'

const DEFAULT_CSV_PATH
  = 'data/blv/pisciculteurs-template-file/orange-live-objects-connectors.csv'

const CONNECTOR_TYPE = 'orange_live_objects'
const CONNECTOR_LABEL = 'orange'

function parseArgValue(args, argName) {
  const arg = args.find(item => item.startsWith(`--${argName}=`))

  if (!arg) {
    return undefined
  }

  return arg.split('=').slice(1).join('=').replaceAll(/^["']|["']$/g, '')
}

function normalizeName(value) {
  return String(value ?? '')
    .trim()
    .normalize('NFC')
    .toLocaleLowerCase('fr-FR')
    .replaceAll(/\s+/g, ' ')
}

function getColumn(row, names) {
  for (const name of names) {
    const value = row[name]

    if (value !== undefined && String(value).trim()) {
      return String(value).trim()
    }
  }

  return undefined
}

function detectDelimiter(content) {
  const firstLine = content.split(/\r?\n/).find(line => line.trim()) ?? ''

  return firstLine.includes(';') ? ';' : ','
}

function normalizeRate(value, rowNumber) {
  const rate = Number(String(value ?? '100').replace(',', '.'))

  if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
    throw new Error(
      `[${CONNECTOR_LABEL}] Ligne CSV #${rowNumber}: rate invalide "${value}". Valeur attendue: > 0 et <= 100.`
    )
  }

  return rate
}

async function readMappings(csvPath) {
  const absolutePath = path.resolve(csvPath)
  const content = await fs.readFile(absolutePath, 'utf8')
  const delimiter = detectDelimiter(content)

  const rows = parse(content, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: true,
    delimiter
  })

  return rows.map((row, index) => {
    const rowNumber = index + 2

    const pointName = getColumn(row, [
      'point_name',
      'PP identifié',
      'PP identifie',
      'pp_identifie',
      'nom_forage',
      'Nom forage',
      'nom_point',
      'point',
      'Point'
    ])

    const liveObjectsStreamId = getColumn(row, [
      'live_objects_stream_id',
      'identifiant_live_objects',
      'Identifiant Live Objects',
      'sourcePointId',
      'source_point_id',
      'stream_id'
    ])

    const rate = normalizeRate(getColumn(row, ['rate', 'ratio']), rowNumber)

    if (!pointName) {
      throw new Error(
        `[${CONNECTOR_LABEL}] Ligne CSV #${rowNumber}: colonne point_name manquante`
      )
    }

    if (!liveObjectsStreamId) {
      throw new Error(
        `[${CONNECTOR_LABEL}] Ligne CSV #${rowNumber}: colonne live_objects_stream_id manquante`
      )
    }

    if (!liveObjectsStreamId.startsWith('urn:lo:nsid:imei:')) {
      throw new Error(
        `[${CONNECTOR_LABEL}] Ligne CSV #${rowNumber}: identifiant Live Objects invalide "${liveObjectsStreamId}"`
      )
    }

    return {
      pointName,
      sourcePointId: liveObjectsStreamId,
      liveObjectsStreamId,
      rate
    }
  })
}

function validateMappings(mappings) {
  const seenMappingKeys = new Set()
  const duplicateMappings = []
  const ratesBySourcePointId = new Map()

  for (const mapping of mappings) {
    const key = `${mapping.sourcePointId}:${normalizeName(mapping.pointName)}`

    if (seenMappingKeys.has(key)) {
      duplicateMappings.push(`${mapping.sourcePointId} -> ${mapping.pointName}`)
    }

    seenMappingKeys.add(key)

    const rates = ratesBySourcePointId.get(mapping.sourcePointId) ?? []
    rates.push(mapping.rate)
    ratesBySourcePointId.set(mapping.sourcePointId, rates)
  }

  if (duplicateMappings.length > 0) {
    throw new Error(
      `[${CONNECTOR_LABEL}] Mappings dupliqués dans le CSV: ${duplicateMappings.join(', ')}`
    )
  }

  for (const [sourcePointId, rates] of ratesBySourcePointId.entries()) {
    const total = rates.reduce((sum, rate) => sum + rate, 0)

    if (total > 100) {
      throw new Error(
        `[${CONNECTOR_LABEL}] Le total des ratios du connecteur ${sourcePointId} dépasse 100%: ${total}%.`
      )
    }

    if (rates.length > 1 && Math.abs(total - 100) > 0.000_001) {
      throw new Error(
        `[${CONNECTOR_LABEL}] Le connecteur ${sourcePointId} est partagé entre plusieurs PP, mais le total des ratios vaut ${total}% au lieu de 100%.`
      )
    }
  }
}

function groupMappingsByPointName(mappings) {
  const groupedMappings = new Map()

  for (const mapping of mappings) {
    const key = normalizeName(mapping.pointName)
    const group = groupedMappings.get(key) ?? {
      pointName: mapping.pointName,
      mappings: []
    }

    group.mappings.push(mapping)
    groupedMappings.set(key, group)
  }

  return [...groupedMappings.values()]
}

async function findPointByName(pointName) {
  const exactPoint = await prisma.pointPrelevement.findFirst({
    where: {
      name: pointName,
      deletedAt: null
    },
    select: {
      id: true,
      name: true
    }
  })

  if (exactPoint) {
    return exactPoint
  }

  const candidates = await prisma.pointPrelevement.findMany({
    where: {
      deletedAt: null,
      name: {
        contains: pointName,
        mode: 'insensitive'
      }
    },
    select: {
      id: true,
      name: true
    },
    take: 10
  })

  const normalizedTarget = normalizeName(pointName)
  const normalizedMatch = candidates.find(
    candidate => normalizeName(candidate.name) === normalizedTarget
  )

  if (normalizedMatch) {
    return normalizedMatch
  }

  if (candidates.length === 1) {
    return candidates[0]
  }

  if (candidates.length > 1) {
    console.warn(
      `[${CONNECTOR_LABEL}] Plusieurs points candidats pour "${pointName}", aucun choix automatique:`
    )

    for (const candidate of candidates) {
      console.warn(`  - ${candidate.name} (${candidate.id})`)
    }
  }

  return null
}

function getSourcePointIdFromConnector(connector) {
  const parameters = connector.connectorParameters

  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return null
  }

  const sourcePointId = [
    parameters.sourcePointId,
    parameters.liveObjectsStreamId,
    parameters.live_objects_stream_id,
    parameters.streamId
  ].find(value => typeof value === 'string' && value.trim())

  return sourcePointId ?? null
}

function buildConnectorParameters(mapping) {
  return {
    sourcePointId: mapping.sourcePointId,
    liveObjectsStreamId: mapping.liveObjectsStreamId
  }
}

async function upsertConnectorForExploitation(exploitation, mapping, options) {
  const existingConnector = exploitation.connectors.find(
    connector => getSourcePointIdFromConnector(connector) === mapping.sourcePointId
  )

  const connectorParameters = buildConnectorParameters(mapping)

  if (options.dryRun) {
    console.log(
      `[${CONNECTOR_LABEL}] [dry-run] exploitation=${exploitation.id}, declarant=${exploitation.declarantUserId}, stream=${mapping.sourcePointId}, rate=${mapping.rate}`
    )

    return
  }

  if (existingConnector) {
    await prisma.declarantPointPrelevementConnector.update({
      where: {
        id: existingConnector.id
      },
      data: {
        connectorParameters,
        rate: mapping.rate
      }
    })

    return
  }

  await prisma.declarantPointPrelevementConnector.create({
    data: {
      declarantPointPrelevementId: exploitation.id,
      connectorType: CONNECTOR_TYPE,
      connectorParameters,
      rate: mapping.rate
    }
  })
}

async function updateExploitationsForPointMappings(pointMappings, options) {
  const point = await findPointByName(pointMappings.pointName)

  if (!point) {
    console.warn(`[${CONNECTOR_LABEL}] Point introuvable: "${pointMappings.pointName}"`)

    return {
      pointFound: false,
      updatedConnectorCount: 0
    }
  }

  const exploitations = await prisma.declarantPointPrelevement.findMany({
    where: {
      pointPrelevementId: point.id
    },
    select: {
      id: true,
      declarantUserId: true,
      pointPrelevementId: true,
      connectors: {
        where: {
          connectorType: CONNECTOR_TYPE
        },
        select: {
          id: true,
          connectorParameters: true,
          rate: true
        },
        orderBy: {
          createdAt: 'asc'
        }
      }
    },
    orderBy: {
      createdAt: 'asc'
    }
  })

  if (exploitations.length === 0) {
    console.warn(
      `[${CONNECTOR_LABEL}] Aucune exploitation pour le point "${point.name}" (${point.id})`
    )

    return {
      pointFound: true,
      updatedConnectorCount: 0
    }
  }

  console.log(
    `[${CONNECTOR_LABEL}] Point "${point.name}" (${point.id}) -> ${pointMappings.mappings.length} connecteur(s)`
  )
  console.log(`[${CONNECTOR_LABEL}] Exploitations trouvées: ${exploitations.length}`)

  let updatedConnectorCount = 0

  for (const exploitation of exploitations) {
    console.log(
      `[${CONNECTOR_LABEL}] ${
        options.dryRun ? '[dry-run] ' : ''
      }exploitation=${exploitation.id}, declarant=${exploitation.declarantUserId}`
    )

    for (const mapping of pointMappings.mappings) {
      await upsertConnectorForExploitation(exploitation, mapping, options)
      updatedConnectorCount++
    }
  }

  return {
    pointFound: true,
    updatedConnectorCount
  }
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const csvPath = parseArgValue(args, 'file') ?? DEFAULT_CSV_PATH

  console.log(`[${CONNECTOR_LABEL}] CSV: ${csvPath}`)
  console.log(`[${CONNECTOR_LABEL}] Mode: ${dryRun ? 'dry-run' : 'apply'}`)
  console.log('')

  const mappings = await readMappings(csvPath)

  if (mappings.length === 0) {
    throw new Error(`[${CONNECTOR_LABEL}] Aucun mapping trouvé dans ${csvPath}`)
  }

  validateMappings(mappings)

  const groupedMappings = groupMappingsByPointName(mappings)

  let foundPoints = 0
  let missingPoints = 0
  let updatedConnectors = 0

  for (const pointMappings of groupedMappings) {
    const result = await updateExploitationsForPointMappings(pointMappings, {
      dryRun
    })

    if (result.pointFound) {
      foundPoints++
    } else {
      missingPoints++
    }

    updatedConnectors += result.updatedConnectorCount
  }

  console.log('')
  console.log(`[${CONNECTOR_LABEL}] Résumé`)
  console.log(`- mappings lus: ${mappings.length}`)
  console.log(`- points distincts dans le CSV: ${groupedMappings.length}`)
  console.log(`- points trouvés: ${foundPoints}`)
  console.log(`- points introuvables: ${missingPoints}`)
  console.log(`- connecteurs ${dryRun ? 'à créer/mettre à jour' : 'créés/mis à jour'}: ${updatedConnectors}`)
}

try {
  await main()
} finally {
  await prisma.$disconnect()
}
