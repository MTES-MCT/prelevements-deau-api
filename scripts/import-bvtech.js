import '../lib/config/env.js'

import ExcelJS from 'exceljs'
import {randomUUID} from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import process, {argv} from 'node:process'
import {deburr} from 'lodash-es'
import proj4 from 'proj4'

import {prisma} from '../db/prisma.js'
import {
  insertPointPrelevement,
  updatePointPrelevementById
} from '../lib/models/point-prelevement.js'

const DEFAULT_INPUT = 'data/bvtech'
const SOURCE = 'BVTECH'
const POINT_SOURCE_PREFIX = 'bvtech:point-prelevement'
const DECLARANT_SOURCE_PREFIX = 'bvtech:preleveur'
const INPUT_PROJECTION_NAME = process.env.BVTECH_INPUT_EPSG || 'EPSG:2154'
const INPUT_PROJ4 = process.env.BVTECH_INPUT_PROJ4

const WGS84 = 'EPSG:4326'
const LAMBERT_93 = 'EPSG:2154'

proj4.defs(WGS84, '+proj=longlat +datum=WGS84 +no_defs +type=crs')
proj4.defs(
  LAMBERT_93,
  '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs'
)

if (INPUT_PROJ4) {
  proj4.defs(INPUT_PROJECTION_NAME, INPUT_PROJ4)
}

const PP_COLUMNS = {
  displayOrder: 1,
  watershedFromFile: 2,
  underWatershed: 3,
  resourceName: 4,
  name: 5,
  owner: 6,
  state: 7,
  identifierAsa: 8,
  identificationComment: 9,
  x: 10,
  y: 11,
  codeEUMasseDEau: 12,
  codeSISEAUX: 13,
  codeBSS: 14,
  identifierDdtm: 15,
  identifierAermc: 16,
  usage: 17,
  communeName: 18,
  obstacleType: 19,
  obstacleCharacteristics: 20,
  codeROE: 21
}

const PRELEVEUR_COLUMNS = {
  id: 1,
  socialReason: 2,
  postalCode: 3,
  city: 4,
  presidentLastName: 5,
  presidentFirstName: 6,
  presidentAddress: 7,
  presidentPostalCode: 8,
  presidentCity: 9,
  presidentPhone: 10,
  secretaryLastName: 11,
  secretaryFirstName: 12,
  secretaryAddress: 13,
  secretaryPostalCode: 14,
  secretaryCity: 15,
  secretaryPhone: 16,
  inseeIntervenant: 17,
  presidentEmail: 18,
  secretaryEmail: 19,
  siret: 20,
  state: 21
}

const MISSING_VALUES = new Set([
  '',
  '?',
  '??',
  '-',
  '(-)',
  'na',
  'n/a',
  'nr',
  'non renseigne',
  'non renseigné'
])

const COMMUNE_CODE_BY_NORMALIZED_NAME = new Map(Object.entries({
  'Amélie les Bains Palalda': '66003',
  'Amélie-les-Bains-Palalda': '66003',
  'Argelès sur Mer': '66008',
  'Argelès-sur-Mer': '66008',
  'Arles sur Tech': '66009',
  'Arles-sur-Tech': '66009',
  Coustouges: '66061',
  Céret: '66049',
  'Laroque des Albères': '66093',
  'Laroque-des-Albères': '66093',
  'Le Boulou': '66024',
  'Le Tech': '66206',
  'Maureillas las Illas': '66106',
  'Maureillas-las-Illas': '66106',
  'Montesquieu des Albères': '66115',
  'Montesquieu-des-Albères': '66115',
  Ortaffa: '66129',
  'Palau del Vidre': '66133',
  'Palau-del-Vidre': '66133',
  'Prats de Mollo la Preste': '66150',
  'Prats-de-Mollo-la-Preste': '66150',
  Reynes: '66160',
  Reynès: '66160',
  Sorède: '66196',
  Sorede: '66196',
  'St Jean Pla de Corts': '66178',
  'Saint Jean Pla de Corts': '66178',
  'Saint-Jean-Pla-de-Corts': '66178',
  'St Laurent de Cerdans': '66179',
  'Saint Laurent de Cerdans': '66179',
  'Saint-Laurent-de-Cerdans': '66179'
}).map(([name, code]) => [normalizeName(name), code]))

const communeOverrides = parseCommuneOverrides()

function parseCommuneOverrides() {
  if (!process.env.BVTECH_COMMUNE_CODE_OVERRIDES) {
    return new Map()
  }

  try {
    return new Map(
      Object.entries(JSON.parse(process.env.BVTECH_COMMUNE_CODE_OVERRIDES))
        .map(([name, code]) => [normalizeName(name), String(code)])
    )
  } catch (error) {
    throw new Error(`BVTECH_COMMUNE_CODE_OVERRIDES doit être un JSON objet valide : ${error.message}`)
  }
}

function normalizeCellValue(value) {
  if (value === undefined || value === null) {
    return null
  }

  if (typeof value === 'object') {
    if ('text' in value) {
      return normalizeCellValue(value.text)
    }

    if ('result' in value) {
      return normalizeCellValue(value.result)
    }

    if ('richText' in value && Array.isArray(value.richText)) {
      return normalizeCellValue(value.richText.map(part => part.text ?? '').join(''))
    }
  }

  const normalized = String(value)
    .replaceAll('\u00A0', ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()

  const comparable = deburr(normalized).toLowerCase()

  if (MISSING_VALUES.has(comparable)) {
    return null
  }

  return normalized
}

function normalizeName(value) {
  return deburr(String(value ?? ''))
    .toLowerCase()
    .replaceAll(/\bst\b/g, 'saint')
    .replaceAll(/[’']/g, ' ')
    .replaceAll(/[^a-z\d]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

function comparableTokens(value) {
  return new Set(
    normalizeName(value)
      .split(' ')
      .filter(token => token.length > 1)
      .filter(token => !['de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'et', 'asa'].includes(token))
  )
}

function tokenSimilarity(left, right) {
  const leftTokens = comparableTokens(left)
  const rightTokens = comparableTokens(right)

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0
  }

  let sharedCount = 0
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      sharedCount++
    }
  }

  return sharedCount / Math.min(leftTokens.size, rightTokens.size)
}

function slug(value) {
  return normalizeName(value).replaceAll(' ', '-') || randomUUID()
}

function cell(row, column) {
  return normalizeCellValue(row.getCell(column).value)
}

function numericCell(row, column) {
  const value = cell(row, column)

  if (!value) {
    return null
  }

  const numeric = Number(String(value).replace(',', '.'))
  return Number.isFinite(numeric) ? numeric : null
}

function normalizeEmail(email) {
  return email.toLowerCase().trim()
}

function extractEmails(value) {
  const normalized = normalizeCellValue(value)

  if (!normalized) {
    return []
  }

  return [...normalized.matchAll(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g)]
    .map(match => normalizeEmail(match[0]))
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function normalizeSiret(value) {
  const digits = String(value ?? '').replaceAll(/\D/g, '')
  return digits.length === 14 ? digits : null
}

function normalizePostalCode(value) {
  const digits = String(value ?? '').replaceAll(/\D/g, '')
  return digits ? digits.padStart(5, '0').slice(0, 5) : null
}

function normalizePhone(value) {
  const digits = String(value ?? '').replaceAll(/\D/g, '')

  if (digits.length < 10) {
    return null
  }

  return digits.slice(0, 10)
}

function resolveCommuneCode(communeName) {
  const normalized = normalizeName(communeName)
  return communeOverrides.get(normalized) ?? COMMUNE_CODE_BY_NORMALIZED_NAME.get(normalized) ?? null
}

function convertCoordinates(x, y) {
  if (x === null || y === null) {
    return null
  }

  const [longitude, latitude] = proj4(INPUT_PROJECTION_NAME, WGS84, [x, y])

  return {
    type: 'Point',
    coordinates: [
      Number(longitude.toFixed(8)),
      Number(latitude.toFixed(8))
    ]
  }
}

function mapUsage(rawUsage) {
  const usage = normalizeName(rawUsage)

  if (!usage) {
    return 'INCONNU'
  }

  if (usage.includes('irrig')) {
    return 'IRRIGATION'
  }

  if (usage.includes('microcentrale') || usage.includes('hydro') || usage.includes('energie')) {
    return 'ENERGIE'
  }

  if (usage.includes('potable') || usage === 'aep') {
    return 'AEP'
  }

  if (usage.includes('canal')) {
    return 'CANAUX'
  }

  return 'INCONNU'
}

async function resolveWorkbookPath(input) {
  const inputPath = input || DEFAULT_INPUT
  const stat = await fs.stat(inputPath)

  if (stat.isFile()) {
    return inputPath
  }

  const inputFiles = await fs.readdir(inputPath)

  const files = inputFiles
    .filter(file => file.toLowerCase().endsWith('.xlsx'))
    .filter(file => !file.startsWith('~$'))
    .sort((left, right) => left.localeCompare(right, 'fr'))

  if (files.length === 0) {
    throw new Error(`Aucun fichier .xlsx trouvé dans ${inputPath}`)
  }

  if (files.length > 1) {
    console.warn(`Plusieurs fichiers .xlsx trouvés dans ${inputPath}; import de ${files[0]}.`)
  }

  return path.join(inputPath, files[0])
}

function getWorksheetOrThrow(workbook, sheetName) {
  const worksheet = workbook.getWorksheet(sheetName)

  if (!worksheet) {
    throw new Error(`Onglet introuvable : ${sheetName}`)
  }

  return worksheet
}

async function safePrimaryEmail(primaryEmail, currentUserId = null) {
  if (!primaryEmail) {
    return null
  }

  const [existingUser, existingAlias] = await Promise.all([
    prisma.user.findUnique({
      where: {email: primaryEmail},
      select: {id: true}
    }),
    prisma.userEmailAlias.findUnique({
      where: {email: primaryEmail},
      select: {userId: true}
    })
  ])

  if (existingUser && existingUser.id !== currentUserId) {
    console.warn(`Email principal ignoré car déjà utilisé comme email principal par un autre utilisateur : ${primaryEmail}`)
    return null
  }

  if (existingAlias) {
    if (existingAlias.userId === currentUserId) {
      console.warn(`Email principal déjà présent comme alias de ce déclarant, conservé en alias : ${primaryEmail}`)
    } else {
      console.warn(`Email principal ignoré car déjà utilisé comme alias par un autre utilisateur : ${primaryEmail}`)
    }

    return null
  }

  return primaryEmail
}

async function syncAliases(userId, emails) {
  const user = await prisma.user.findUnique({
    where: {id: userId},
    select: {email: true}
  })

  const candidateEmails = unique(emails)
    .filter(email => email !== user?.email)

  if (candidateEmails.length === 0) {
    return
  }

  const [primaryUsers, existingAliases] = await Promise.all([
    prisma.user.findMany({
      where: {email: {in: candidateEmails}},
      select: {id: true, email: true}
    }),
    prisma.userEmailAlias.findMany({
      where: {email: {in: candidateEmails}},
      select: {userId: true, email: true}
    })
  ])

  const primaryEmails = new Set(
    primaryUsers
      .map(({email}) => email ? normalizeEmail(email) : null)
      .filter(Boolean)
  )
  const aliasesByEmail = new Map(
    existingAliases.map(({email, userId}) => [normalizeEmail(email), userId])
  )
  const aliasesToCreate = []

  for (const email of candidateEmails) {
    const normalizedEmail = normalizeEmail(email)

    if (primaryEmails.has(normalizedEmail)) {
      console.warn(`Alias ignoré car cet email est déjà un email principal : ${email}`)
      continue
    }

    const existingAliasUserId = aliasesByEmail.get(normalizedEmail)

    if (existingAliasUserId) {
      if (existingAliasUserId !== userId) {
        console.warn(`Alias ignoré car cet email est déjà rattaché à un autre utilisateur : ${email}`)
      }

      continue
    }

    aliasesToCreate.push({userId, email})
  }

  if (aliasesToCreate.length === 0) {
    return
  }

  await prisma.userEmailAlias.createMany({
    data: aliasesToCreate,
    skipDuplicates: true
  })
}

async function upsertDeclarant({sourceId, primaryEmail, secondaryEmails, userData, declarantData}) {
  const existingDeclarant = await prisma.declarant.findUnique({
    where: {sourceId},
    include: {user: true}
  })

  const existingUser = existingDeclarant
    ? null
    : (primaryEmail
      ? await prisma.user.findUnique({
        where: {email: primaryEmail},
        include: {declarant: true}
      })
      : null)

  if (existingDeclarant) {
    const email = await safePrimaryEmail(primaryEmail, existingDeclarant.userId)

    await prisma.$transaction(async tx => {
      await tx.user.update({
        where: {id: existingDeclarant.userId},
        data: {
          ...userData,
          email
        }
      })

      await tx.declarant.update({
        where: {userId: existingDeclarant.userId},
        data: declarantData
      })
    })

    await syncAliases(existingDeclarant.userId, [email ? null : primaryEmail, ...secondaryEmails])
    return existingDeclarant.userId
  }

  if (existingUser) {
    const email = await safePrimaryEmail(primaryEmail, existingUser.id)

    await prisma.$transaction(async tx => {
      await tx.user.update({
        where: {id: existingUser.id},
        data: {
          ...userData,
          email
        }
      })

      if (existingUser.declarant) {
        await tx.declarant.update({
          where: {userId: existingUser.id},
          data: declarantData
        })
      } else {
        await tx.declarant.create({
          data: {
            userId: existingUser.id,
            ...declarantData
          }
        })
      }
    })

    await syncAliases(existingUser.id, [email ? null : primaryEmail, ...secondaryEmails])
    return existingUser.id
  }

  const userId = randomUUID()
  const email = await safePrimaryEmail(primaryEmail)

  await prisma.user.create({
    data: {
      id: userId,
      role: 'DECLARANT',
      email,
      ...userData,
      declarant: {
        create: declarantData
      }
    }
  })

  await syncAliases(userId, [email ? null : primaryEmail, ...secondaryEmails])
  return userId
}

async function importDeclarants(workbook) {
  const worksheet = getWorksheetOrThrow(workbook, 'préleveurs')
  const results = []
  const byId = new Map()
  const byName = new Map()

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber)
    const preleveurId = cell(row, PRELEVEUR_COLUMNS.id)
    const socialReason = cell(row, PRELEVEUR_COLUMNS.socialReason)

    if (!preleveurId && !socialReason) {
      continue
    }

    const emails = unique([
      ...extractEmails(row.getCell(PRELEVEUR_COLUMNS.presidentEmail).value),
      ...extractEmails(row.getCell(PRELEVEUR_COLUMNS.secretaryEmail).value)
    ])
    const [primaryEmail, ...secondaryEmails] = emails
    const sourceId = `${DECLARANT_SOURCE_PREFIX}:${preleveurId ?? slug(socialReason)}`
    const userData = {
      firstName: cell(row, PRELEVEUR_COLUMNS.presidentFirstName),
      lastName: cell(row, PRELEVEUR_COLUMNS.presidentLastName)
    }

    const declarantData = {
      declarantType: 'LEGAL_PERSON',
      declarantRole: 'PRELEVEUR',
      socialReason,
      addressLine1: cell(row, PRELEVEUR_COLUMNS.secretaryAddress) ?? cell(row, PRELEVEUR_COLUMNS.presidentAddress),
      postalCode: normalizePostalCode(cell(row, PRELEVEUR_COLUMNS.postalCode)),
      city: cell(row, PRELEVEUR_COLUMNS.city),
      siret: normalizeSiret(cell(row, PRELEVEUR_COLUMNS.siret)),
      phoneNumber: normalizePhone(cell(row, PRELEVEUR_COLUMNS.presidentPhone))
        ?? normalizePhone(cell(row, PRELEVEUR_COLUMNS.secretaryPhone)),
      sourceId
    }

    const userId = await upsertDeclarant({
      sourceId,
      primaryEmail,
      secondaryEmails,
      userData,
      declarantData
    })

    const result = {
      userId,
      sourceId,
      id: preleveurId,
      socialReason,
      normalizedName: normalizeName(socialReason)
    }

    results.push(result)

    if (preleveurId) {
      byId.set(String(preleveurId), result)
    }

    if (socialReason) {
      byName.set(normalizeName(socialReason), result)
    }
  }

  return {results, byId, byName}
}

function findDeclarantForPoint(row, declarants) {
  const identifierAsa = cell(row, PP_COLUMNS.identifierAsa)

  if (identifierAsa && declarants.byId.has(identifierAsa)) {
    return declarants.byId.get(identifierAsa)
  }

  const owner = cell(row, PP_COLUMNS.owner)

  if (!owner) {
    return null
  }

  const normalizedOwner = normalizeName(owner)
  const exact = declarants.byName.get(normalizedOwner)

  if (exact) {
    return exact
  }

  let best = null
  let bestScore = 0

  for (const declarant of declarants.results) {
    const score = tokenSimilarity(owner, declarant.socialReason)

    if (score > bestScore) {
      bestScore = score
      best = declarant
    }
  }

  return bestScore >= 0.75 ? best : null
}

function buildPointPayload(row) {
  const name = cell(row, PP_COLUMNS.name)
  const identifierDdtm = cell(row, PP_COLUMNS.identifierDdtm)
  const identifierAermc = cell(row, PP_COLUMNS.identifierAermc)
  const identifierAsa = cell(row, PP_COLUMNS.identifierAsa)
  const communeName = cell(row, PP_COLUMNS.communeName)
  const codeINSEE = resolveCommuneCode(communeName)
  const resourceName = cell(row, PP_COLUMNS.resourceName)
  const coordinates = convertCoordinates(
    numericCell(row, PP_COLUMNS.x),
    numericCell(row, PP_COLUMNS.y)
  )

  if (!name || !coordinates) {
    return null
  }

  const identifiers = Object.fromEntries([
    ['DDTM', identifierDdtm],
    ['AERMC', identifierAermc],
    ['ASA', identifierAsa]
  ].filter(([, value]) => value))

  const sourceStablePart = identifierDdtm ?? identifierAermc ?? identifierAsa ?? slug(name)

  return {
    sourceId: `${POINT_SOURCE_PREFIX}:${slug(sourceStablePart)}`,
    name,
    waterBodyType: 'SUPERFICIELLE',
    nature: 'COURS_EAU',
    withdrawalType: 'CONTINENTAL',
    coordinates,
    watershed: 'BV Tech',
    underWatershed: cell(row, PP_COLUMNS.underWatershed),
    resourceName,
    streamName: resourceName,
    codeEUMasseDEau: cell(row, PP_COLUMNS.codeEUMasseDEau),
    codeBSS: cell(row, PP_COLUMNS.codeBSS),
    codeSISEAUX: cell(row, PP_COLUMNS.codeSISEAUX),
    codeINSEE,
    communeCode: codeINSEE,
    communeName,
    codeROE: cell(row, PP_COLUMNS.codeROE),
    identifiers,
    names: [
      {
        type: 'NOM_OUVRAGE_PRELEVEMENT',
        value: name,
        source: SOURCE
      }
    ],
    internalComment: cell(row, PP_COLUMNS.identificationComment)
  }
}

async function upsertPoint(payload) {
  const existing = await prisma.pointPrelevement.findFirst({
    where: {
      OR: [
        {sourceId: payload.sourceId},
        {name: payload.name}
      ]
    },
    select: {id: true, name: true, deletedAt: true}
  })

  if (!existing) {
    return insertPointPrelevement(payload)
  }

  if (existing.deletedAt) {
    await prisma.pointPrelevement.update({
      where: {id: existing.id},
      data: {deletedAt: null}
    })
  }

  return updatePointPrelevementById(existing.id, payload)
}

async function upsertPointDeclarantLink(point, declarant, rawUsage) {
  if (!declarant) {
    return null
  }

  const usage = mapUsage(rawUsage)
  const sourceId = `bvtech:exploitation:${declarant.userId}:${point.id}`

  return prisma.declarantPointPrelevement.upsert({
    where: {
      declarantUserId_pointPrelevementId: {
        declarantUserId: declarant.userId,
        pointPrelevementId: point.id
      }
    },
    create: {
      declarantUserId: declarant.userId,
      pointPrelevementId: point.id,
      status: 'EN_ACTIVITE',
      usages: [usage],
      sourceId
    },
    update: {
      status: 'EN_ACTIVITE',
      usages: [usage],
      sourceId
    }
  })
}

async function importPoints(workbook, declarants) {
  const worksheet = getWorksheetOrThrow(workbook, 'PP')
  const summary = {
    processed: 0,
    skipped: 0,
    linkedDeclarants: 0,
    missingDeclarants: 0,
    unresolvedCommunes: new Set()
  }

  for (let rowNumber = 4; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber)
    const payload = buildPointPayload(row)

    if (!payload) {
      summary.skipped++
      continue
    }

    if (payload.communeName && !payload.codeINSEE) {
      summary.unresolvedCommunes.add(payload.communeName)
    }

    const point = await upsertPoint(payload)
    const declarant = findDeclarantForPoint(row, declarants)
    const link = await upsertPointDeclarantLink(point, declarant, cell(row, PP_COLUMNS.usage))

    summary.processed++

    if (link) {
      summary.linkedDeclarants++
    } else {
      summary.missingDeclarants++
      console.warn(`Aucun préleveur rattaché au point "${payload.name}" (${cell(row, PP_COLUMNS.owner) ?? 'gestionnaire absent'}).`)
    }
  }

  return summary
}

async function main() {
  const workbookPath = await resolveWorkbookPath(argv[2])
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(workbookPath)

  console.log(`Import BV Tech depuis ${workbookPath}`)
  console.log(`Projection source : ${INPUT_PROJECTION_NAME}${INPUT_PROJ4 ? ' (définition fournie par BVTECH_INPUT_PROJ4)' : ''}`)

  const declarants = await importDeclarants(workbook)
  const summary = await importPoints(workbook, declarants)

  console.log('\nImport terminé')
  console.log(`Déclarants importés/mis à jour : ${declarants.results.length}`)
  console.log(`Points importés/mis à jour : ${summary.processed}`)
  console.log(`Lignes PP ignorées : ${summary.skipped}`)
  console.log(`Rattachements PP/préleveurs créés ou mis à jour : ${summary.linkedDeclarants}`)
  console.log(`Points sans préleveur trouvé : ${summary.missingDeclarants}`)

  if (summary.unresolvedCommunes.size > 0) {
    console.warn('Communes sans code INSEE résolu :')
    for (const commune of [...summary.unresolvedCommunes].sort()) {
      console.warn(`- ${commune}`)
    }

    console.warn('Ajouter une correction via BVTECH_COMMUNE_CODE_OVERRIDES={"Nom commune":"code"}.')
  }
}

try {
  await main()
} finally {
  await prisma.$disconnect()
}
