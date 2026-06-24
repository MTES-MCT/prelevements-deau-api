import '../../lib/config/env.js'

import ExcelJS from 'exceljs'
import * as XLSX from 'xlsx'
import {randomUUID} from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import process, {argv} from 'node:process'
import {deburr} from 'lodash-es'
import proj4 from 'proj4'

import {prisma} from '../../db/prisma.js'
import {
  insertPointPrelevement,
  updatePointPrelevementById
} from '../../lib/models/point-prelevement.js'

const DEFAULT_INPUT = 'data/bvtech/bvtech-eaux-superficielles.xlsx'
const DEFAULT_INPUT_FILENAME = 'bvtech-eaux-superficielles.xlsx'
const SOURCE = 'BVTECH'
const POINT_SOURCE_PREFIX = 'bvtech:point-prelevement'
const DECLARANT_SOURCE_PREFIX = 'bvtech:preleveur'
const OWNER_DECLARANT_SOURCE_PREFIX = 'bvtech:preleveur-owner'
const EXPLOITATION_SOURCE_PREFIX = 'bvtech:exploitation'
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
  address: 8,
  contactEmail: 9,
  identifierAsa: 10,
  identificationComment: 11,
  x: 12,
  y: 13,
  codeEUMasseDEau: 14,
  codeSISEAUX: 15,
  codeBSS: 16,
  identifierDdtm: 17,
  identifierAermc: 18,
  usage: 19,
  communeName: 20,
  obstacleType: 21,
  obstacleCharacteristics: 22,
  codeROE: 23,
  authorizationReference: 27,
  authorizedFlowOrVolume: 28,
  observations: 35,
  l21418DecisionType: 37,
  l21418Reference: 38,
  l21418Comment: 39,
  fieldVisitDates: 40,
  retainedHypothesis: 41,
  reservedFlow: 42,
  modulation: 43,
  prescriptions: 44,
  applicationYear: 45,
  controlDevices: 46
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

const NORMALIZED_SHEETS = {
  points: 'Points prélèvement',
  declarants: 'Déclarant',
  exploitations: 'Exploitations'
}

const NORMALIZED_POINT_COLUMNS = {
  name: 'Nom du point *',
  longitude: 'Coordonnée X - longitude (WGS84) *',
  latitude: 'Coordonnée Y - latitude (WGS84) *',
  otherNames: 'Autres noms (séparés par |)',
  depth: 'Profondeur (m)',
  isZre: 'Zone de répartition des eaux',
  isBiologicalReservoir: 'Réservoir biologique',
  streamName: 'Nom du cours d\'eau',
  locationDescription: 'Description du lieu',
  codeBSS: 'Code BSS',
  codeBNPE: 'Code BNPE',
  codeAIOT: 'Code AIOT',
  codeEUMasseDEau: 'Code EU Masse d\'Eau',
  codePTP: 'Code PTP',
  codeOPR: 'Code OPR',
  codeBDLISA: 'Code BDLISA',
  codeBDCarthage: 'Code BDCarthage',
  codeBDTopage: 'Code BDTopage',
  codeSISPEA: 'Code SISPEA',
  internalComment: 'Commentaire',
  watershed: 'Bassin versant',
  underWatershed: 'Sous-BV hydrographique',
  resourceName: 'Ressource',
  codeSISEAUX: 'Code CISEAU',
  codeINSEE: 'Code INSEE',
  communeName: 'Commune',
  codeROE: 'Code ROE',
  identifierDdtm: 'Identifiant DDTM',
  identifierAermc: 'Identifiant AERMC',
  identifierAsa: 'Identifiant ASA',
  obstacleType: 'Type obstacle',
  obstacleCharacteristics: 'Caractéristiques obstacle',
  usages: 'Usages techniques',
  waterBodyType: 'WaterBodyType technique',
  nature: 'Nature technique',
  withdrawalType: 'PrelevementType technique',
  sourceId: 'SourceId point'
}

const NORMALIZED_DECLARANT_COLUMNS = {
  email: 'Email *',
  socialReason: 'Raison sociale',
  siret: 'SIRET',
  firstName: 'Prénom',
  lastName: 'Nom',
  phoneNumber: 'Téléphone',
  jobTitle: 'Fonction',
  addressLine1: 'Adresse',
  addressLine2: 'Complément d\'adresse',
  poBox: 'Boîte postale',
  postalCode: 'Code postal',
  city: 'Ville',
  sourceId: 'Identifiant source déclarant',
  identifierAsa: 'Identifiant ASA',
  origin: 'Origine',
  secondaryEmails: 'Emails secondaires'
}

const NORMALIZED_EXPLOITATION_COLUMNS = {
  pointName: 'Point de prélèvement *',
  declarantLabel: 'Préleveur *',
  startDate: 'Date de début',
  endDate: 'Date de fin',
  comment: 'Commentaire',
  sourceId: 'Identifiant source exploitation',
  declarantSourceId: 'Identifiant source déclarant',
  usages: 'Usages techniques'
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
  'non renseigné',
  'inconnu',
  'inconnue',
  'incconu'
])

const GENERIC_OWNER_NAMES = new Set([
  'prive',
  'privé',
  'gestionnaire inconnu',
  'inconnu',
  'inconnue'
].map(normalizeName))

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
    .replaceAll(/\?{3,}/g, '??')
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

function ownerKey(value) {
  const tokens = [...comparableTokens(value)].sort()
  return tokens.join('-') || null
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

function normalizeIdentifier(value) {
  const normalized = normalizeCellValue(value)

  if (!normalized) {
    return null
  }

  const candidate = normalized.replace(',', '.')
  const numeric = Number(candidate)

  if (/^[+-]?\d+(?:\.0+)?(?:e[+-]?\d+)?$/i.test(candidate) && Number.isSafeInteger(numeric)) {
    return String(numeric)
  }

  return normalized
}

function normalizeSiret(value) {
  const digits = String(value ?? '').replaceAll(/\D/g, '')
  return digits.length === 14 ? digits : null
}

function normalizePostalCode(value) {
  const digits = String(value ?? '').replaceAll(/\D/g, '')
  return digits ? digits.padStart(5, '0').slice(0, 5) : null
}

function postalCodeFromText(value) {
  const normalized = normalizeCellValue(value)

  if (!normalized) {
    return null
  }

  const match = normalized.match(/\b\d{5}\b/)
  return match ? match[0] : null
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

  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    return null
  }

  return {
    type: 'Point',
    coordinates: [
      Number(longitude.toFixed(8)),
      Number(latitude.toFixed(8))
    ]
  }
}

function mapUsages(rawUsage) {
  const usage = normalizeName(rawUsage)
  const usages = []

  if (!usage) {
    return ['INCONNU']
  }

  if (usage.includes('irrig') || usage.includes('jardin')) {
    usages.push('IRRIGATION')
  }

  if (usage.includes('agri') || usage.includes('elevage')) {
    usages.push('AGRICULTURE_ELEVAGE')
  }

  if (usage.includes('microcentrale') || usage.includes('hydro') || usage.includes('energie') || usage.includes('elec')) {
    usages.push('ENERGIE')
  }

  if (usage.includes('potable') || usage.includes('aep')) {
    usages.push('AEP')
  }

  if (usage.includes('dom')) {
    usages.push('DOMESTIQUE')
  }

  if (usage.includes('industrie') || usage.includes('industriel')) {
    usages.push('INDUSTRIE')
  }

  if (usage.includes('canal') && usages.length === 0) {
    usages.push('CANAUX')
  }

  return unique(usages).length > 0 ? unique(usages) : ['INCONNU']
}

function compactLines(lines) {
  return lines
    .filter(([, value]) => value)
    .map(([label, value]) => `${label} : ${value}`)
    .join('\n') || null
}

function cleanOwnerLabel(value) {
  const owner = normalizeCellValue(value)

  if (!owner) {
    return null
  }

  const cleaned = owner
    .replaceAll(/\?+/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim()

  if (!cleaned || GENERIC_OWNER_NAMES.has(normalizeName(cleaned))) {
    return null
  }

  return cleaned
}

function buildPointInternalComment(row) {
  return compactLines([
    ['Gestionnaire/propriétaire source', cleanOwnerLabel(cell(row, PP_COLUMNS.owner)) ?? cell(row, PP_COLUMNS.owner)],
    ['État source', cell(row, PP_COLUMNS.state)],
    ['Identification source', cell(row, PP_COLUMNS.identificationComment)],
    ['Type obstacle', cell(row, PP_COLUMNS.obstacleType)],
    ['Caractéristiques obstacle', cell(row, PP_COLUMNS.obstacleCharacteristics)],
    ['Référence autorisation/reconnaissance', cell(row, PP_COLUMNS.authorizationReference)],
    ['Débit ou volume autorisé', cell(row, PP_COLUMNS.authorizedFlowOrVolume)],
    ['Débit réservé Qr', cell(row, PP_COLUMNS.reservedFlow)],
    ['Modulation', cell(row, PP_COLUMNS.modulation)],
    ['Prescriptions particulières', cell(row, PP_COLUMNS.prescriptions)],
    ['Hypothèse retenue', cell(row, PP_COLUMNS.retainedHypothesis)],
    ['Décision L214-18', cell(row, PP_COLUMNS.l21418DecisionType)],
    ['Référence AP L214-18', cell(row, PP_COLUMNS.l21418Reference)],
    ['Commentaire L214-18', cell(row, PP_COLUMNS.l21418Comment)],
    ['Dates visite MCGS', cell(row, PP_COLUMNS.fieldVisitDates)],
    ['Année application', cell(row, PP_COLUMNS.applicationYear)],
    ['Dispositifs de contrôle validés', cell(row, PP_COLUMNS.controlDevices)],
    ['Observations', cell(row, PP_COLUMNS.observations)]
  ])
}

async function resolveWorkbookPath(input) {
  const inputPath = input || DEFAULT_INPUT
  const stat = await fs.stat(inputPath)

  if (stat.isFile()) {
    return inputPath
  }

  const inputFiles = await fs.readdir(inputPath)

  if (inputFiles.includes(DEFAULT_INPUT_FILENAME)) {
    return path.join(inputPath, DEFAULT_INPUT_FILENAME)
  }

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

function getWorksheetByNamesOrThrow(workbook, sheetNames) {
  for (const sheetName of sheetNames) {
    const worksheet = workbook.getWorksheet(sheetName)

    if (worksheet) {
      return worksheet
    }
  }

  throw new Error(`Onglet introuvable : ${sheetNames.join(' ou ')}`)
}

function getPointWorksheet(workbook) {
  return getWorksheetByNamesOrThrow(workbook, ['données', 'donnees', 'PP'])
}

function getPreleveurWorksheet(workbook) {
  return getWorksheetByNamesOrThrow(workbook, ['preleveurs', 'préleveurs'])
}

async function readXlsxWorkbook(workbookPath) {
  const buffer = await fs.readFile(workbookPath)
  return XLSX.read(buffer, {
    type: 'buffer',
    cellDates: true
  })
}

function isNormalizedWorkbook(workbook) {
  return Object.values(NORMALIZED_SHEETS)
    .every(sheetName => workbook.SheetNames.includes(sheetName))
}

function normalizedRows(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName]

  if (!sheet) {
    throw new Error(`Onglet introuvable : ${sheetName}`)
  }

  return XLSX.utils.sheet_to_json(sheet, {
    defval: null,
    raw: true,
    blankrows: false
  })
}

function rowCell(row, column) {
  return normalizeCellValue(row[column])
}

function rowNumericCell(row, column) {
  const value = rowCell(row, column)

  if (!value) {
    return null
  }

  const numeric = Number(String(value).replace(',', '.'))
  return Number.isFinite(numeric) ? numeric : null
}

function rowBooleanCell(row, column) {
  const value = rowCell(row, column)

  if (!value) {
    return null
  }

  const normalized = normalizeName(value)

  if (['1', 'oui', 'true', 'vrai', 'yes'].includes(normalized)) {
    return true
  }

  if (['0', 'non', 'false', 'faux', 'no'].includes(normalized)) {
    return false
  }

  return null
}

function rowDateCell(row, column) {
  const value = row[column]

  if (!value) {
    return null
  }

  if (value instanceof Date) {
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()))
  }

  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value)

    if (parsed) {
      return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d))
    }
  }

  const normalized = rowCell(row, column)

  if (!normalized) {
    return null
  }

  const frenchDate = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (frenchDate) {
    const [, day, month, year] = frenchDate
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  }

  const isoDate = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (isoDate) {
    const [, year, month, day] = isoDate
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  }

  return null
}

function normalizedUsages(value) {
  const usages = mapUsages(value)
  return usages.length > 0 ? usages : ['INCONNU']
}

function buildNormalizedPointPayload(row) {
  const name = rowCell(row, NORMALIZED_POINT_COLUMNS.name)
  const longitude = rowNumericCell(row, NORMALIZED_POINT_COLUMNS.longitude)
  const latitude = rowNumericCell(row, NORMALIZED_POINT_COLUMNS.latitude)

  if (!name || longitude === null || latitude === null) {
    return null
  }

  const codeBSS = rowCell(row, NORMALIZED_POINT_COLUMNS.codeBSS)
  const identifierDdtm = normalizeIdentifier(rowCell(row, NORMALIZED_POINT_COLUMNS.identifierDdtm))
  const identifierAermc = normalizeIdentifier(rowCell(row, NORMALIZED_POINT_COLUMNS.identifierAermc))
  const identifierAsa = normalizeIdentifier(rowCell(row, NORMALIZED_POINT_COLUMNS.identifierAsa))
  const sourceStablePart = codeBSS ?? identifierDdtm ?? identifierAermc ?? identifierAsa ?? slug(name)
  const sourceId = rowCell(row, NORMALIZED_POINT_COLUMNS.sourceId) ?? `${POINT_SOURCE_PREFIX}:${slug(sourceStablePart)}`
  const identifiers = Object.fromEntries([
    ['BSS', codeBSS],
    ['DDTM', identifierDdtm],
    ['AERMC', identifierAermc],
    ['ASA', identifierAsa]
  ].filter(([, value]) => value))
  const communeCode = rowCell(row, NORMALIZED_POINT_COLUMNS.codeINSEE)
  const resourceName = rowCell(row, NORMALIZED_POINT_COLUMNS.resourceName)

  return {
    sourceId,
    name,
    waterBodyType: rowCell(row, NORMALIZED_POINT_COLUMNS.waterBodyType) ?? 'SUPERFICIELLE',
    nature: rowCell(row, NORMALIZED_POINT_COLUMNS.nature) ?? 'COURS_EAU',
    withdrawalType: rowCell(row, NORMALIZED_POINT_COLUMNS.withdrawalType) ?? 'CONTINENTAL',
    coordinates: {
      type: 'Point',
      coordinates: [
        Number(longitude.toFixed(8)),
        Number(latitude.toFixed(8))
      ]
    },
    otherNames: rowCell(row, NORMALIZED_POINT_COLUMNS.otherNames),
    names: [
      {
        type: 'NOM_OUVRAGE_PRELEVEMENT',
        value: name,
        source: SOURCE
      }
    ],
    identifiers,
    depth: rowNumericCell(row, NORMALIZED_POINT_COLUMNS.depth),
    isZre: rowBooleanCell(row, NORMALIZED_POINT_COLUMNS.isZre),
    isBiologicalReservoir: rowBooleanCell(row, NORMALIZED_POINT_COLUMNS.isBiologicalReservoir),
    streamName: rowCell(row, NORMALIZED_POINT_COLUMNS.streamName) ?? resourceName,
    locationDescription: rowCell(row, NORMALIZED_POINT_COLUMNS.locationDescription),
    geometryPrecision: 'Coordonnées WGS84 issues de bvtech-eaux-superficielles.xlsx',
    internalComment: compactLines([
      ['Commentaire', rowCell(row, NORMALIZED_POINT_COLUMNS.internalComment)],
      ['Type obstacle', rowCell(row, NORMALIZED_POINT_COLUMNS.obstacleType)],
      ['Caractéristiques obstacle', rowCell(row, NORMALIZED_POINT_COLUMNS.obstacleCharacteristics)]
    ]),
    watershed: rowCell(row, NORMALIZED_POINT_COLUMNS.watershed),
    underWatershed: rowCell(row, NORMALIZED_POINT_COLUMNS.underWatershed),
    resourceName,
    codeBSS,
    codeBNPE: rowCell(row, NORMALIZED_POINT_COLUMNS.codeBNPE),
    codeAIOT: rowCell(row, NORMALIZED_POINT_COLUMNS.codeAIOT),
    codeEUMasseDEau: rowCell(row, NORMALIZED_POINT_COLUMNS.codeEUMasseDEau),
    codePTP: rowCell(row, NORMALIZED_POINT_COLUMNS.codePTP),
    codeOPR: rowCell(row, NORMALIZED_POINT_COLUMNS.codeOPR),
    codeBDLISA: rowCell(row, NORMALIZED_POINT_COLUMNS.codeBDLISA),
    codeBDCarthage: rowCell(row, NORMALIZED_POINT_COLUMNS.codeBDCarthage),
    codeBDTopage: rowCell(row, NORMALIZED_POINT_COLUMNS.codeBDTopage),
    codeSISPEA: rowCell(row, NORMALIZED_POINT_COLUMNS.codeSISPEA),
    codeSISEAUX: rowCell(row, NORMALIZED_POINT_COLUMNS.codeSISEAUX),
    codeINSEE: communeCode,
    communeCode,
    communeName: rowCell(row, NORMALIZED_POINT_COLUMNS.communeName),
    codeROE: rowCell(row, NORMALIZED_POINT_COLUMNS.codeROE)
  }
}

async function importNormalizedDeclarants(workbook) {
  const rows = normalizedRows(workbook, NORMALIZED_SHEETS.declarants)
  const indexes = {
    results: [],
    byId: new Map(),
    byName: new Map(),
    byOwnerKey: new Map(),
    bySourceId: new Map()
  }

  for (const row of rows) {
    const sourceId = rowCell(row, NORMALIZED_DECLARANT_COLUMNS.sourceId)
    const socialReason = rowCell(row, NORMALIZED_DECLARANT_COLUMNS.socialReason)
    const preleveurId = normalizeIdentifier(rowCell(row, NORMALIZED_DECLARANT_COLUMNS.identifierAsa))

    if (!sourceId || !socialReason) {
      continue
    }

    const emails = unique([
      ...extractEmails(row[NORMALIZED_DECLARANT_COLUMNS.email]),
      ...extractEmails(row[NORMALIZED_DECLARANT_COLUMNS.secondaryEmails])
    ])
    const [primaryEmail, ...secondaryEmails] = emails
    const userId = await upsertDeclarant({
      sourceId,
      primaryEmail,
      secondaryEmails,
      userData: {
        firstName: rowCell(row, NORMALIZED_DECLARANT_COLUMNS.firstName),
        lastName: rowCell(row, NORMALIZED_DECLARANT_COLUMNS.lastName)
      },
      declarantData: {
        declarantType: 'LEGAL_PERSON',
        declarantRole: 'PRELEVEUR',
        socialReason,
        jobTitle: rowCell(row, NORMALIZED_DECLARANT_COLUMNS.jobTitle),
        addressLine1: rowCell(row, NORMALIZED_DECLARANT_COLUMNS.addressLine1),
        addressLine2: rowCell(row, NORMALIZED_DECLARANT_COLUMNS.addressLine2),
        poBox: rowCell(row, NORMALIZED_DECLARANT_COLUMNS.poBox),
        postalCode: normalizePostalCode(rowCell(row, NORMALIZED_DECLARANT_COLUMNS.postalCode)),
        city: rowCell(row, NORMALIZED_DECLARANT_COLUMNS.city),
        siret: normalizeSiret(rowCell(row, NORMALIZED_DECLARANT_COLUMNS.siret)),
        phoneNumber: normalizePhone(rowCell(row, NORMALIZED_DECLARANT_COLUMNS.phoneNumber)),
        sourceId
      }
    })

    addDeclarantToIndexes(indexes, {
      userId,
      sourceId,
      id: preleveurId,
      socialReason,
      normalizedName: normalizeName(socialReason),
      origin: rowCell(row, NORMALIZED_DECLARANT_COLUMNS.origin)
    })
  }

  return indexes
}

async function importNormalizedPoints(workbook) {
  const rows = normalizedRows(workbook, NORMALIZED_SHEETS.points)
  const summary = {
    processed: 0,
    skipped: 0,
    byName: new Map(),
    bySourceId: new Map()
  }

  for (const row of rows) {
    const payload = buildNormalizedPointPayload(row)

    if (!payload) {
      summary.skipped++
      continue
    }

    const point = await upsertPoint(payload)
    summary.processed++
    summary.byName.set(normalizeName(payload.name), point)
    summary.bySourceId.set(payload.sourceId, point)
  }

  return summary
}

async function upsertNormalizedExploitation({point, declarant, sourceId, usages, startDate, endDate, comment}) {
  const existing = await prisma.declarantPointPrelevement.findFirst({
    where: {
      OR: [
        {sourceId},
        {
          declarantUserId: declarant.userId,
          pointPrelevementId: point.id
        }
      ]
    },
    select: {id: true}
  })

  const data = {
    declarantUserId: declarant.userId,
    pointPrelevementId: point.id,
    status: 'EN_ACTIVITE',
    usages,
    startDate,
    endDate,
    sourceId,
    comment
  }

  if (existing) {
    return prisma.declarantPointPrelevement.update({
      where: {id: existing.id},
      data
    })
  }

  return prisma.declarantPointPrelevement.create({
    data
  })
}

async function importNormalizedExploitations(workbook, declarants, points) {
  const rows = normalizedRows(workbook, NORMALIZED_SHEETS.exploitations)
  const summary = {
    processed: 0,
    skipped: 0,
    missingDeclarants: 0,
    missingPoints: 0
  }

  for (const row of rows) {
    const sourceId = rowCell(row, NORMALIZED_EXPLOITATION_COLUMNS.sourceId)
    const declarantSourceId = rowCell(row, NORMALIZED_EXPLOITATION_COLUMNS.declarantSourceId)
    const pointName = rowCell(row, NORMALIZED_EXPLOITATION_COLUMNS.pointName)
    const declarant = declarantSourceId ? declarants.bySourceId.get(declarantSourceId) : null
    const point = pointName ? points.byName.get(normalizeName(pointName)) : null

    if (!sourceId || !pointName || !declarantSourceId) {
      summary.skipped++
      continue
    }

    if (!declarant) {
      summary.missingDeclarants++
      console.warn(`Déclarant introuvable pour l'exploitation ${sourceId} (${declarantSourceId}).`)
      continue
    }

    if (!point) {
      summary.missingPoints++
      console.warn(`Point introuvable pour l'exploitation ${sourceId} (${pointName}).`)
      continue
    }

    await upsertNormalizedExploitation({
      point,
      declarant,
      sourceId,
      usages: normalizedUsages(rowCell(row, NORMALIZED_EXPLOITATION_COLUMNS.usages)),
      startDate: rowDateCell(row, NORMALIZED_EXPLOITATION_COLUMNS.startDate),
      endDate: rowDateCell(row, NORMALIZED_EXPLOITATION_COLUMNS.endDate),
      comment: rowCell(row, NORMALIZED_EXPLOITATION_COLUMNS.comment)
    })
    summary.processed++
  }

  return summary
}

async function importNormalizedWorkbook(workbookPath, workbook) {
  console.log(`Import BV Tech normalisé depuis ${workbookPath}`)
  console.log('Coordonnées source : WGS84')

  const declarants = await importNormalizedDeclarants(workbook)
  const points = await importNormalizedPoints(workbook)
  const exploitations = await importNormalizedExploitations(workbook, declarants, points)

  console.log('\nImport terminé')
  console.log(`Déclarants importés/mis à jour : ${declarants.results.length}`)
  console.log(`Points importés/mis à jour : ${points.processed}`)
  console.log(`Lignes points ignorées : ${points.skipped}`)
  console.log(`Exploitations importées/mises à jour : ${exploitations.processed}`)
  console.log(`Lignes exploitations ignorées : ${exploitations.skipped}`)
  console.log(`Exploitations sans déclarant trouvé : ${exploitations.missingDeclarants}`)
  console.log(`Exploitations sans point trouvé : ${exploitations.missingPoints}`)
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

  if (existingDeclarant) {
    const email = primaryEmail
      ? await safePrimaryEmail(primaryEmail, existingDeclarant.userId)
      : undefined

    await prisma.$transaction(async tx => {
      await tx.user.update({
        where: {id: existingDeclarant.userId},
        data: {
          ...userData,
          ...(primaryEmail ? {email} : {})
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

function addDeclarantToIndexes(indexes, declarant) {
  indexes.results.push(declarant)

  if (declarant.id) {
    indexes.byId.set(String(declarant.id), declarant)
  }

  if (declarant.socialReason) {
    indexes.byName.set(normalizeName(declarant.socialReason), declarant)

    const key = ownerKey(declarant.socialReason)
    if (key) {
      indexes.byOwnerKey.set(key, declarant)
    }
  }

  if (declarant.sourceId) {
    indexes.bySourceId.set(declarant.sourceId, declarant)
  }
}

async function importDeclarants(workbook) {
  const worksheet = getPreleveurWorksheet(workbook)
  const indexes = {
    results: [],
    byId: new Map(),
    byName: new Map(),
    byOwnerKey: new Map(),
    bySourceId: new Map()
  }

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber)
    const preleveurId = normalizeIdentifier(cell(row, PRELEVEUR_COLUMNS.id))
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

    addDeclarantToIndexes(indexes, {
      userId,
      sourceId,
      id: preleveurId,
      socialReason,
      normalizedName: normalizeName(socialReason),
      origin: 'preleveurs'
    })
  }

  return indexes
}

function findDeclarantForPoint(row, declarants) {
  const identifierAsa = normalizeIdentifier(cell(row, PP_COLUMNS.identifierAsa))

  if (identifierAsa && declarants.byId.has(identifierAsa)) {
    return declarants.byId.get(identifierAsa)
  }

  const owner = cleanOwnerLabel(cell(row, PP_COLUMNS.owner))

  if (!owner) {
    return null
  }

  const normalizedOwner = normalizeName(owner)
  const exact = declarants.byName.get(normalizedOwner)

  if (exact) {
    return exact
  }

  const key = ownerKey(owner)
  if (key && declarants.byOwnerKey.has(key)) {
    return declarants.byOwnerKey.get(key)
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

async function importOwnerDeclarantsFromPoints(workbook, declarants) {
  const worksheet = getPointWorksheet(workbook)
  const ownerRowsByKey = new Map()

  for (let rowNumber = 4; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber)
    const pointName = cell(row, PP_COLUMNS.name)
    const owner = cleanOwnerLabel(cell(row, PP_COLUMNS.owner))

    if (!pointName || !owner || findDeclarantForPoint(row, declarants)) {
      continue
    }

    const key = ownerKey(owner)

    if (!key) {
      continue
    }

    const existing = ownerRowsByKey.get(key) ?? {
      key,
      socialReason: owner,
      emails: [],
      addressLine1: null,
      postalCode: null,
      city: null
    }

    existing.emails.push(...extractEmails(row.getCell(PP_COLUMNS.contactEmail).value))
    existing.addressLine1 ||= cell(row, PP_COLUMNS.address)
    existing.postalCode ||= postalCodeFromText(cell(row, PP_COLUMNS.address))
    existing.city ||= cell(row, PP_COLUMNS.communeName)
    ownerRowsByKey.set(key, existing)
  }

  let count = 0

  for (const ownerData of ownerRowsByKey.values()) {
    const sourceId = `${OWNER_DECLARANT_SOURCE_PREFIX}:${slug(ownerData.key)}`
    const emails = unique(ownerData.emails)
    const [primaryEmail, ...secondaryEmails] = emails

    const userId = await upsertDeclarant({
      sourceId,
      primaryEmail,
      secondaryEmails,
      userData: {
        firstName: null,
        lastName: null
      },
      declarantData: {
        declarantType: 'LEGAL_PERSON',
        declarantRole: 'PRELEVEUR',
        socialReason: ownerData.socialReason,
        addressLine1: ownerData.addressLine1,
        postalCode: ownerData.postalCode,
        city: ownerData.city,
        siret: null,
        phoneNumber: null,
        sourceId
      }
    })

    addDeclarantToIndexes(declarants, {
      userId,
      sourceId,
      id: null,
      socialReason: ownerData.socialReason,
      normalizedName: normalizeName(ownerData.socialReason),
      origin: 'owner'
    })
    count++
  }

  return count
}

function buildPointPayload(row) {
  const name = cell(row, PP_COLUMNS.name)
  const identifierDdtm = normalizeIdentifier(cell(row, PP_COLUMNS.identifierDdtm))
  const identifierAermc = normalizeIdentifier(cell(row, PP_COLUMNS.identifierAermc))
  const identifierAsa = normalizeIdentifier(cell(row, PP_COLUMNS.identifierAsa))
  const codeBSS = cell(row, PP_COLUMNS.codeBSS)
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
    ['BSS', codeBSS],
    ['DDTM', identifierDdtm],
    ['AERMC', identifierAermc],
    ['ASA', identifierAsa]
  ].filter(([, value]) => value))

  const sourceStablePart = codeBSS ?? identifierDdtm ?? identifierAermc ?? identifierAsa ?? cell(row, PP_COLUMNS.displayOrder) ?? slug(name)

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
    codeBSS,
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
    locationDescription: cell(row, PP_COLUMNS.address),
    geometryPrecision: `Coordonnées ${INPUT_PROJECTION_NAME} converties en WGS84`,
    internalComment: buildPointInternalComment(row)
  }
}

async function upsertPoint(payload) {
  const existing = await prisma.pointPrelevement.findUnique({
    where: {sourceId: payload.sourceId},
    select: {id: true, name: true, deletedAt: true}
  })

  if (existing) {
    if (existing.deletedAt) {
      await prisma.pointPrelevement.update({
        where: {id: existing.id},
        data: {deletedAt: null}
      })
    }

    return updatePointPrelevementById(existing.id, payload)
  }

  const nameConflict = await prisma.pointPrelevement.findUnique({
    where: {name: payload.name},
    select: {sourceId: true}
  })

  if (nameConflict) {
    throw new Error(`Point "${payload.name}" déjà importé avec sourceId=${nameConflict.sourceId ?? 'absent'}; import eaux souterraines interrompu pour éviter d'écraser un point d'un autre script.`)
  }

  return insertPointPrelevement(payload)
}

async function upsertPointDeclarantLink({point, pointPayload, declarant, rawUsage, row}) {
  if (!declarant) {
    return null
  }

  const sourceId = `${EXPLOITATION_SOURCE_PREFIX}:${slug(declarant.sourceId)}:${slug(pointPayload.sourceId)}`
  const existing = await prisma.declarantPointPrelevement.findFirst({
    where: {
      OR: [
        {sourceId},
        {
          declarantUserId: declarant.userId,
          pointPrelevementId: point.id
        }
      ]
    },
    select: {id: true}
  })

  const data = {
    declarantUserId: declarant.userId,
    pointPrelevementId: point.id,
    status: 'EN_ACTIVITE',
    usages: mapUsages(rawUsage),
    sourceId,
    comment: compactLines([
      ['Usage source', cell(row, PP_COLUMNS.usage)],
      ['Gestionnaire/propriétaire source', cell(row, PP_COLUMNS.owner)]
    ])
  }

  if (existing) {
    return prisma.declarantPointPrelevement.update({
      where: {id: existing.id},
      data
    })
  }

  return prisma.declarantPointPrelevement.create({
    data
  })
}

async function importPoints(workbook, declarants) {
  const worksheet = getPointWorksheet(workbook)
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
    const link = await upsertPointDeclarantLink({
      point,
      pointPayload: payload,
      declarant,
      rawUsage: cell(row, PP_COLUMNS.usage),
      row
    })

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
  const xlsxWorkbook = await readXlsxWorkbook(workbookPath)

  if (isNormalizedWorkbook(xlsxWorkbook)) {
    await importNormalizedWorkbook(workbookPath, xlsxWorkbook)
    return
  }

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(workbookPath)

  console.log(`Import BV Tech depuis ${workbookPath}`)
  console.log(`Projection source : ${INPUT_PROJECTION_NAME}${INPUT_PROJ4 ? ' (définition fournie par BVTECH_INPUT_PROJ4)' : ''}`)

  const declarants = await importDeclarants(workbook)
  const ownerDeclarantsCount = await importOwnerDeclarantsFromPoints(workbook, declarants)
  const summary = await importPoints(workbook, declarants)

  console.log('\nImport terminé')
  console.log(`Déclarants issus de l'onglet preleveurs importés/mis à jour : ${declarants.results.length - ownerDeclarantsCount}`)
  console.log(`Déclarants complémentaires issus des propriétaires/gestionnaires : ${ownerDeclarantsCount}`)
  console.log(`Déclarants totaux indexés : ${declarants.results.length}`)
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
