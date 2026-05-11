
import '../../lib/config/env.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {parse} from 'csv-parse/sync'
import {prisma} from '../../db/prisma.js'

const DEFAULT_CSV_PATH
  = 'data/blv/pisciculteurs-template-file/willie-connectors.csv'

const CONNECTOR_TYPE = 'willie'
const DEFAULT_EXPLOITATION_TYPE = 'COLLECTEUR'

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
      `[willie] Ligne CSV #${rowNumber}: rate invalide "${value}". Valeur attendue: > 0 et <= 100.`
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
      'nom_point',
      'point',
      'Point'
    ])

    const sourcePointId = getColumn(row, [
      'station_id',
      'station.id',
      'willie_station_id',
      'sourcePointId',
      'source_point_id'
    ])

    const stationSiteName = getColumn(row, [
      'station_site_name',
      'station.site.name'
    ])

    const stationName = getColumn(row, [
      'station_name',
      'station.name'
    ])

    const rate = normalizeRate(getColumn(row, ['rate', 'ratio']), rowNumber)

    if (!pointName) {
      throw new Error(`[willie] Ligne CSV #${rowNumber}: colonne point_name manquante`)
    }

    if (!sourcePointId) {
      throw new Error(`[willie] Ligne CSV #${rowNumber}: colonne station_id manquante`)
    }

    return {
      pointName,
      sourcePointId,
      stationSiteName,
      stationName,
      rate
    }
  })
}

function validateRatesByStation(mappings) {
  const ratesByStation = new Map()

  for (const mapping of mappings) {
    const rates = ratesByStation.get(mapping.sourcePointId) ?? []
    rates.push(mapping.rate)
    ratesByStation.set(mapping.sourcePointId, rates)
  }

  for (const [sourcePointId, rates] of ratesByStation.entries()) {
    const total = rates.reduce((sum, rate) => sum + rate, 0)

    if (total > 100) {
      throw new Error(
        `[willie] Le total des ratios du compteur ${sourcePointId} dépasse 100%: ${total}%.`
      )
    }

    if (rates.length > 1 && total !== 100) {
      throw new Error(
        `[willie] Le compteur ${sourcePointId} est partagé entre plusieurs PP, mais le total des ratios vaut ${total}% au lieu de 100%.`
      )
    }
  }
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
      `[willie] Plusieurs points candidats pour "${pointName}", aucun choix automatique:`
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

  return typeof parameters.sourcePointId === 'string'
    ? parameters.sourcePointId
    : null
}

async function upsertConnectorForExploitation(exploitation, mapping, options) {
  const existingConnector = exploitation.connectors.find(connector => getSourcePointIdFromConnector(connector) === mapping.sourcePointId)

  const connectorParameters = {
    sourcePointId: mapping.sourcePointId,
    stationId: mapping.sourcePointId,
    stationSiteName: mapping.stationSiteName,
    stationName: mapping.stationName
  }

  if (options.dryRun) {
    console.log(
      `[willie] [dry-run] exploitation=${exploitation.id}, declarant=${exploitation.declarantUserId}, station=${mapping.sourcePointId}, rate=${mapping.rate}`
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

async function updateExploitationsForMapping(mapping, options) {
  const point = await findPointByName(mapping.pointName)

  if (!point) {
    console.warn(`[willie] Point introuvable: "${mapping.pointName}"`)
    return {
      pointFound: false,
      updatedCount: 0
    }
  }

  const exploitationWhere = {
    pointPrelevementId: point.id
  }

  if (!options.allTypes) {
    exploitationWhere.type = DEFAULT_EXPLOITATION_TYPE
  }

  const exploitations = await prisma.declarantPointPrelevement.findMany({
    where: exploitationWhere,
    select: {
      id: true,
      declarantUserId: true,
      pointPrelevementId: true,
      type: true,
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
      `[willie] Aucune exploitation ${options.allTypes ? '' : DEFAULT_EXPLOITATION_TYPE} pour le point "${point.name}" (${point.id})`
    )

    return {
      pointFound: true,
      updatedCount: 0
    }
  }

  console.log(
    `[willie] Point "${point.name}" (${point.id}) -> station=${mapping.sourcePointId}, rate=${mapping.rate}`
  )
  console.log(`[willie] Exploitations trouvées: ${exploitations.length}`)

  let updatedCount = 0

  for (const exploitation of exploitations) {
    console.log(
      `[willie] ${
        options.dryRun ? '[dry-run] ' : ''
      }exploitation=${exploitation.id}, declarant=${exploitation.declarantUserId}, type=${exploitation.type}`
    )

    await upsertConnectorForExploitation(exploitation, mapping, options)
    updatedCount++
  }

  return {
    pointFound: true,
    updatedCount
  }
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const allTypes = args.includes('--all-types')
  const csvPath = parseArgValue(args, 'file') ?? DEFAULT_CSV_PATH

  console.log(`[willie] CSV: ${csvPath}`)
  console.log(`[willie] Mode: ${dryRun ? 'dry-run' : 'apply'}`)
  console.log(`[willie] Type exploitation: ${allTypes ? 'tous' : DEFAULT_EXPLOITATION_TYPE}`)
  console.log('')

  const mappings = await readMappings(csvPath)

  if (mappings.length === 0) {
    throw new Error(`[willie] Aucun mapping trouvé dans ${csvPath}`)
  }

  validateRatesByStation(mappings)

  const seenMappingKeys = new Set()
  const duplicateMappings = []

  for (const mapping of mappings) {
    const key = `${mapping.sourcePointId}:${normalizeName(mapping.pointName)}`

    if (seenMappingKeys.has(key)) {
      duplicateMappings.push(`${mapping.sourcePointId} -> ${mapping.pointName}`)
    }

    seenMappingKeys.add(key)
  }

  if (duplicateMappings.length > 0) {
    throw new Error(
      `[willie] Mappings dupliqués dans le CSV: ${duplicateMappings.join(', ')}`
    )
  }

  let foundPoints = 0
  let missingPoints = 0
  let updatedExploitations = 0

  for (const mapping of mappings) {
    const result = await updateExploitationsForMapping(mapping, {
      dryRun,
      allTypes
    })

    if (result.pointFound) {
      foundPoints++
    } else {
      missingPoints++
    }

    updatedExploitations += result.updatedCount
  }

  console.log('')
  console.log('[willie] Résumé')
  console.log(`- mappings lus: ${mappings.length}`)
  console.log(`- points trouvés: ${foundPoints}`)
  console.log(`- points introuvables: ${missingPoints}`)
  console.log(`- exploitations ${dryRun ? 'à mettre à jour' : 'mises à jour'}: ${updatedExploitations}`)
}

try {
  await main()
} finally {
  await prisma.$disconnect()
}
