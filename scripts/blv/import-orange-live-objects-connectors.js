/* eslint-disable no-await-in-loop */
import '../../lib/config/env.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {parse} from 'csv-parse/sync'
import {prisma} from '../../db/prisma.js'

const DEFAULT_CSV_PATH
  = 'data/blv/pisciculteurs-template-file/orange-live-objects-connectors.csv'

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
    const pointName = getColumn(row, [
      'point_name',
      'nom_forage',
      'Nom forage',
      'nom_point',
      'point',
      'Point'
    ])

    const sourcePointId = getColumn(row, [
      'live_objects_stream_id',
      'identifiant_live_objects',
      'Identifiant Live Objects',
      'sourcePointId',
      'source_point_id',
      'stream_id'
    ])

    if (!pointName) {
      throw new Error(`Ligne CSV #${index + 2}: colonne point_name manquante`)
    }

    if (!sourcePointId) {
      throw new Error(
        `Ligne CSV #${index + 2}: colonne live_objects_stream_id manquante`
      )
    }

    if (!sourcePointId.startsWith('urn:lo:nsid:imei:')) {
      throw new Error(
        `Ligne CSV #${index + 2}: identifiant Live Objects invalide: ${sourcePointId}`
      )
    }

    return {
      pointName,
      sourcePointId
    }
  })
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
      `[orange] Plusieurs points candidats pour "${pointName}", aucun choix automatique:`
    )

    for (const candidate of candidates) {
      console.warn(`  - ${candidate.name} (${candidate.id})`)
    }
  }

  return null
}

async function updateExploitationsForMapping(mapping, options) {
  const point = await findPointByName(mapping.pointName)

  if (!point) {
    console.warn(`[orange] Point introuvable: "${mapping.pointName}"`)
    return {
      pointFound: false,
      updatedCount: 0
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
      connectorType: true,
      connectorParameters: true
    },
    orderBy: {
      createdAt: 'asc'
    }
  })

  if (exploitations.length === 0) {
    console.warn(
      `[orange] Aucune exploitation pour le point "${point.name}" (${point.id})`
    )

    return {
      pointFound: true,
      updatedCount: 0
    }
  }

  console.log(
    `[orange] Point "${point.name}" (${point.id}) -> ${mapping.sourcePointId}`
  )
  console.log(`[orange] Exploitations trouvées: ${exploitations.length}`)

  let updatedCount = 0

  for (const exploitation of exploitations) {
    console.log(
      `[orange] ${
        options.dryRun ? '[dry-run] ' : ''
      }exploitation=${exploitation.id}, declarant=${exploitation.declarantUserId}`
    )

    if (!options.dryRun) {
      await prisma.declarantPointPrelevement.update({
        where: {
          id: exploitation.id
        },
        data: {
          connectorType: 'orange_live_objects',
          connectorParameters: {
            sourcePointId: mapping.sourcePointId
          }
        }
      })
    }

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
  const csvPath = parseArgValue(args, 'file') ?? DEFAULT_CSV_PATH

  console.log(`[orange] CSV: ${csvPath}`)
  console.log(`[orange] Mode: ${dryRun ? 'dry-run' : 'apply'}`)
  console.log('')

  const mappings = await readMappings(csvPath)

  if (mappings.length === 0) {
    throw new Error(`[orange] Aucun mapping trouvé dans ${csvPath}`)
  }

  const seenPointNames = new Set()
  const duplicatePointNames = []

  for (const mapping of mappings) {
    const key = normalizeName(mapping.pointName)

    if (seenPointNames.has(key)) {
      duplicatePointNames.push(mapping.pointName)
    }

    seenPointNames.add(key)
  }

  if (duplicatePointNames.length > 0) {
    throw new Error(
      `[orange] Points dupliqués dans le CSV: ${duplicatePointNames.join(', ')}`
    )
  }

  let foundPoints = 0
  let missingPoints = 0
  let updatedExploitations = 0

  for (const mapping of mappings) {
    const result = await updateExploitationsForMapping(mapping, {dryRun})

    if (result.pointFound) {
      foundPoints++
    } else {
      missingPoints++
    }

    updatedExploitations += result.updatedCount
  }

  console.log('')
  console.log('[orange] Résumé')
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
