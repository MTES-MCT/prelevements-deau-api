import '../../lib/config/env.js'

import {randomUUID} from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {argv} from 'node:process'
import {createRequire} from 'node:module'

import {parse} from 'csv-parse/sync'
import {deburr} from 'lodash-es'
import * as XLSX from 'xlsx'

import {prisma} from '../../db/prisma.js'
import {
  insertPointPrelevement,
  updatePointPrelevementById
} from '../../lib/models/point-prelevement.js'
import {getWaterUseByLegacyUsage} from '../../lib/services/sandre-water-uses.js'

const SOURCE = 'BVTECH'
const POINT_SOURCE_PREFIX = 'bvtech:eaux-souterraines:point-prelevement'
const DECLARANT_SOURCE_PREFIX = 'bvtech:eaux-souterraines:preleveur'
const EXPLOITATION_SOURCE_PREFIX = 'bvtech:eaux-souterraines:exploitation'
const SMNPR_COLLECTEUR_SOURCE_ID = 'bvtech-collecteur-smnpr'
const LEGACY_SMNPR_COLLECTEUR_SOURCE_IDS = ['bvtech-collecteur-snmpr']
const COLLECTEUR_ACCOUNTS_PATH = 'data/bvtech/collecteur-accounts.csv'

const DATASETS = [
  {
    key: 'smnpr',
    label: 'SMNPR',
    input: 'data/bvtech/bvtech-eaux-souterraines-Initialisation-smnpr.xlsx',
    collecteurSourceId: SMNPR_COLLECTEUR_SOURCE_ID
  },
  {
    key: 'non-smnpr',
    label: 'non_smnpr',
    input: 'data/bvtech/bvtech-eaux-souterraines-Initialisation_non_smnpr.xlsx',
    collecteurSourceId: null
  },
  {
    key: 'aep-publics',
    label: 'aep_publics_non_smnpr',
    input: 'data/bvtech/bvtech-eaux-souterraines-aep_publics_non_smnpr.xlsx',
    collecteurSourceId: null
  }
]

const SHEETS = {
  points: 'Points prélèvement',
  declarants: 'Déclarant',
  exploitations: 'Exploitations'
}

const POINT_COLUMNS = {
  order: '#',
  name: 'Nom du point *',
  longitude: 'Coordonnée X - longitude (WGS84) *',
  latitude: 'Coordonnée Y - latitude (WGS84) *',
  waterType: 'Type de milieu *',
  internalIdentifier: 'Identifiant interne',
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
  internalComment: 'Commentaire'
}

const DECLARANT_COLUMNS = {
  order: '#',
  email: 'Email *',
  socialReason: 'Raison sociale',
  siret: 'SIRET',
  civility: 'Civilité',
  firstName: 'Prénom',
  lastName: 'Nom',
  phoneNumber: 'Téléphone',
  jobTitle: 'Fonction',
  addressLine1: 'Adresse',
  addressLine2: 'Complément d\'adresse',
  poBox: 'Boîte postale',
  postalCode: 'Code postal',
  city: 'Ville'
}

const EXPLOITATION_COLUMNS = {
  order: '#',
  pointName: 'Point de prélèvement *',
  declarantSelector: 'Préleveur *',
  mainUsage: 'Usage principal *',
  startDate: 'Date de début',
  endDate: 'Date de fin',
  usage2: 'Usage complémentaire 1',
  usage3: 'Usage complémentaire 2',
  comment: 'Commentaire'
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

const USAGE_BY_NORMALIZED_LABEL = new Map([
  ['inconnu', 'INCONNU'],
  ['pas d usage', 'PAS_D_USAGE'],
  ['irrigation', 'IRRIGATION'],
  ['agriculture elevage', 'AGRICULTURE_ELEVAGE'],
  ['aquaculture', 'AQUACULTURE'],
  ['industrie', 'INDUSTRIE'],
  ['alimentation en eau potable aep', 'AEP'],
  ['aep', 'AEP'],
  ['energie', 'ENERGIE'],
  ['loisirs', 'LOISIRS'],
  ['embouteillage', 'EMBOUTEILLAGE'],
  ['thermalisme thalasso', 'THERMALISME_THALASSO'],
  ['defense incendie', 'DEFENSE_INCENDIE'],
  ['realimentation en eau', 'REALIMENTATION_EAU'],
  ['canaux', 'CANAUX'],
  ['etiage', 'ETIAGE'],
  ['entretien voiries', 'ENTRETIEN_VOIRIES'],
  ['alimentation soutien canal', 'ALIMENTATION_SOUTIEN_CANAL'],
  ['domestique', 'DOMESTIQUE']
])

const require = createRequire(import.meta.url)
const communesPath = require.resolve('@etalab/decoupage-administratif/data/communes.json')
const communes = JSON.parse(await fs.readFile(communesPath, 'utf8'))
const communeCodesByNormalizedName = buildCommuneCodesByNormalizedName(communes)

function normalizeCellValue(value) {
  if (value === undefined || value === null) {
    return null
  }

  if (value instanceof Date) {
    return value
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
    .replaceAll(/\bste\b/g, 'sainte')
    .replaceAll(/[’']/g, ' ')
    .replaceAll(/[^a-z\d]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

function slug(value) {
  return normalizeName(value).replaceAll(' ', '-') || randomUUID()
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

function normalizeEmail(email) {
  return String(email).toLowerCase().trim()
}

function extractEmails(value) {
  const normalized = normalizeCellValue(value)

  if (!normalized) {
    return []
  }

  return [...String(normalized).matchAll(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g)]
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

function normalizePhone(value) {
  const digits = String(value ?? '').replaceAll(/\D/g, '')

  if (digits.length < 10) {
    return null
  }

  return digits.slice(0, 10)
}

function normalizeCivility(value) {
  const normalized = normalizeName(value)

  if (['m', 'mr', 'monsieur'].includes(normalized)) {
    return 'MR'
  }

  if (['mme', 'madame'].includes(normalized)) {
    return 'MRS'
  }

  return null
}

function compactLines(lines) {
  return lines
    .filter(([, value]) => value)
    .map(([label, value]) => `${label} : ${value}`)
    .join('\n') || null
}

function cleanObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined)
  )
}

function buildCommuneCodesByNormalizedName(rows) {
  const map = new Map()

  for (const commune of rows) {
    const key = normalizeName(commune.nom)
    const existing = map.get(key) ?? []
    existing.push(commune)
    map.set(key, existing)
  }

  return map
}

function resolveCommuneCode(communeName) {
  const normalized = normalizeName(communeName)

  if (!normalized) {
    return null
  }

  const candidates = communeCodesByNormalizedName.get(normalized) ?? []

  if (candidates.length === 0) {
    return null
  }

  return (
    candidates.find(commune => commune.departement === '66')
    ?? candidates.find(commune => commune.type === 'commune-actuelle')
    ?? candidates[0]
  ).code
}

function extractMetadataFromDescription(description) {
  const metadata = {
    communeName: null,
    ouvrageType: null,
    resourceName: null,
    sector: null
  }

  const normalizedDescription = rowCell({description}, 'description')

  if (!normalizedDescription) {
    return metadata
  }

  for (const match of String(normalizedDescription).matchAll(/([^:;]+?)\s*[:：]\s*([^;]+)/g)) {
    const label = normalizeName(match[1])
    const value = normalizeCellValue(match[2])

    if (!value) {
      continue
    }

    if (label.includes('commune')) {
      metadata.communeName = value
    } else if (label.includes('type') && label.includes('ouvrage')) {
      metadata.ouvrageType = value
    } else if (label.includes('ressource')) {
      metadata.resourceName = value
    } else if (label.includes('secteur')) {
      metadata.sector = value
    }
  }

  return metadata
}

function isMissingIdentifier(value) {
  return ['xxx', 'inconnu', 'inconnue', 'nr'].includes(normalizeName(value))
}

function addIdentifier(identifiers, key, value) {
  const normalized = normalizeIdentifier(value)

  if (!normalized || isMissingIdentifier(normalized)) {
    return
  }

  identifiers[key] = normalized
}

function extractSourceIdentifiers({internalIdentifier, codeBSS, comment}) {
  const identifiers = {}

  addIdentifier(identifiers, 'BSS', codeBSS)
  addIdentifier(identifiers, 'BVTECH_INTERNE', internalIdentifier)

  const internalSmnpr = String(internalIdentifier ?? '').match(/^smnpr[-\s]*(\d+)$/i)
  if (internalSmnpr) {
    addIdentifier(identifiers, 'SMNPR', internalSmnpr[1])
  }

  const commentText = String(comment ?? '')

  const smnpr = commentText.match(/\bsmnpr\s+([a-z\d-]+)/i)
  if (smnpr && !identifiers.SMNPR) {
    addIdentifier(identifiers, 'SMNPR', smnpr[1])
  }

  const ddtm = commentText.match(/\bddtm\s+([a-z\d-]+)/i)
  if (ddtm) {
    addIdentifier(identifiers, 'DDTM', ddtm[1])
  }

  const aermc = commentText.match(/\baermc\s+([a-z\d-]+)/i)
    ?? commentText.match(/\bcode ae export\s*[:：]\s*([a-z\d-]+)/i)
  if (aermc) {
    addIdentifier(identifiers, 'AERMC', aermc[1])
  }

  return identifiers
}

function mapUsage(rawUsage) {
  const normalized = normalizeName(rawUsage)

  if (!normalized) {
    return null
  }

  const exact = USAGE_BY_NORMALIZED_LABEL.get(normalized)
  if (exact) {
    return exact
  }

  if (normalized.includes('irrig') || normalized.includes('jardin')) {
    return 'IRRIGATION'
  }

  if (normalized.includes('agri') || normalized.includes('elevage')) {
    return 'AGRICULTURE_ELEVAGE'
  }

  if (normalized.includes('aep') || normalized.includes('potable')) {
    return 'AEP'
  }

  if (normalized.includes('aqua')) {
    return 'AQUACULTURE'
  }

  if (normalized.includes('industri')) {
    return 'INDUSTRIE'
  }

  if (normalized.includes('energie') || normalized.includes('hydro') || normalized.includes('elec')) {
    return 'ENERGIE'
  }

  if (normalized.includes('dom')) {
    return 'DOMESTIQUE'
  }

  return 'INCONNU'
}

function mapUsages(values) {
  const usages = unique(values.map(value => mapUsage(value)).filter(Boolean))
  return usages.length > 0 ? usages : ['INCONNU']
}

async function resolveUsageId(usages) {
  const waterUse = await getWaterUseByLegacyUsage(usages.find(Boolean) ?? 'INCONNU', {rootOnly: true})
  return waterUse.id
}

function generatedPointSourceId(row) {
  const stablePart = rowCell(row, POINT_COLUMNS.internalIdentifier)
    ?? rowCell(row, POINT_COLUMNS.codeBSS)
    ?? rowCell(row, POINT_COLUMNS.name)

  return `${POINT_SOURCE_PREFIX}:${slug(stablePart)}`
}

function generatedDeclarantSourceId(row) {
  const emails = extractEmails(row[DECLARANT_COLUMNS.email])
  const [primaryEmail] = emails
  const siret = normalizeSiret(rowCell(row, DECLARANT_COLUMNS.siret))
  const socialReason = rowCell(row, DECLARANT_COLUMNS.socialReason)
  const city = rowCell(row, DECLARANT_COLUMNS.city)

  if (siret) {
    return `${DECLARANT_SOURCE_PREFIX}:siret:${siret}`
  }

  if (primaryEmail) {
    return `${DECLARANT_SOURCE_PREFIX}:email:${primaryEmail}`
  }

  return `${DECLARANT_SOURCE_PREFIX}:name:${slug([socialReason, city].filter(Boolean).join(' '))}`
}

function generatedExploitationSourceId(pointSourceId, declarantSourceId) {
  return `${EXPLOITATION_SOURCE_PREFIX}:${slug(declarantSourceId)}:${slug(pointSourceId)}`
}

function buildPointPayload({row, dataset}) {
  const name = rowCell(row, POINT_COLUMNS.name)
  const longitude = rowNumericCell(row, POINT_COLUMNS.longitude)
  const latitude = rowNumericCell(row, POINT_COLUMNS.latitude)

  if (!name || longitude === null || latitude === null) {
    return null
  }

  const locationDescription = rowCell(row, POINT_COLUMNS.locationDescription)
  const metadata = extractMetadataFromDescription(locationDescription)
  const {communeName} = metadata
  const communeCode = resolveCommuneCode(communeName)
  const internalIdentifier = rowCell(row, POINT_COLUMNS.internalIdentifier)
  const internalComment = rowCell(row, POINT_COLUMNS.internalComment)
  const codeBSS = rowCell(row, POINT_COLUMNS.codeBSS)
  const identifiers = extractSourceIdentifiers({
    internalIdentifier,
    codeBSS,
    comment: internalComment
  })
  const sourceId = generatedPointSourceId(row)
  const ouvrageType = normalizeName(metadata.ouvrageType)
  const nature = ouvrageType.includes('source') ? 'SOURCE' : 'NAPPE'

  return {
    sourceId,
    name,
    waterBodyType: 'SOUTERRAIN',
    nature,
    withdrawalType: 'SOUTERRAIN',
    coordinates: {
      type: 'Point',
      coordinates: [
        Number(longitude.toFixed(8)),
        Number(latitude.toFixed(8))
      ]
    },
    otherNames: rowCell(row, POINT_COLUMNS.otherNames),
    names: [
      {
        type: 'NOM_OUVRAGE_PRELEVEMENT',
        value: name,
        source: SOURCE
      }
    ],
    identifiers,
    depth: rowNumericCell(row, POINT_COLUMNS.depth),
    isZre: rowBooleanCell(row, POINT_COLUMNS.isZre),
    isBiologicalReservoir: rowBooleanCell(row, POINT_COLUMNS.isBiologicalReservoir),
    streamName: rowCell(row, POINT_COLUMNS.streamName),
    locationDescription,
    geometryPrecision: `Coordonnées WGS84 issues de ${path.basename(dataset.input)}`,
    internalComment: compactLines([
      ['Fichier source', path.basename(dataset.input)],
      ['Identifiant interne', internalIdentifier],
      ['Type de milieu source', rowCell(row, POINT_COLUMNS.waterType)],
      ['Type d\'ouvrage source', metadata.ouvrageType],
      ['Ressource source', metadata.resourceName],
      ['Secteur source', metadata.sector],
      ['Commentaire source', internalComment]
    ]),
    watershed: 'BV Tech',
    resourceName: metadata.resourceName,
    managementSubUnit: metadata.sector,
    aquiferName: metadata.resourceName,
    codeBSS,
    codeBNPE: rowCell(row, POINT_COLUMNS.codeBNPE),
    codeAIOT: rowCell(row, POINT_COLUMNS.codeAIOT),
    codeEUMasseDEau: rowCell(row, POINT_COLUMNS.codeEUMasseDEau),
    codePTP: rowCell(row, POINT_COLUMNS.codePTP),
    codeOPR: rowCell(row, POINT_COLUMNS.codeOPR),
    codeBDLISA: rowCell(row, POINT_COLUMNS.codeBDLISA),
    codeBDCarthage: rowCell(row, POINT_COLUMNS.codeBDCarthage),
    codeBDTopage: rowCell(row, POINT_COLUMNS.codeBDTopage),
    codeSISPEA: rowCell(row, POINT_COLUMNS.codeSISPEA),
    codeINSEE: communeCode,
    communeCode,
    communeName
  }
}

function buildDeclarantRecord(row) {
  const socialReason = rowCell(row, DECLARANT_COLUMNS.socialReason)
  const emails = extractEmails(row[DECLARANT_COLUMNS.email])
  const [primaryEmail, ...secondaryEmails] = emails
  const siret = normalizeSiret(rowCell(row, DECLARANT_COLUMNS.siret))
  const sourceId = generatedDeclarantSourceId(row)

  if (!sourceId || !socialReason) {
    return null
  }

  return {
    sourceId,
    primaryEmail,
    secondaryEmails,
    emails,
    siret,
    socialReason,
    userData: {
      firstName: rowCell(row, DECLARANT_COLUMNS.firstName),
      lastName: rowCell(row, DECLARANT_COLUMNS.lastName)
    },
    declarantData: {
      declarantType: 'LEGAL_PERSON',
      declarantRole: 'PRELEVEUR',
      socialReason,
      civility: normalizeCivility(rowCell(row, DECLARANT_COLUMNS.civility)),
      jobTitle: rowCell(row, DECLARANT_COLUMNS.jobTitle),
      addressLine1: rowCell(row, DECLARANT_COLUMNS.addressLine1),
      addressLine2: rowCell(row, DECLARANT_COLUMNS.addressLine2),
      poBox: rowCell(row, DECLARANT_COLUMNS.poBox),
      postalCode: normalizePostalCode(rowCell(row, DECLARANT_COLUMNS.postalCode)),
      city: rowCell(row, DECLARANT_COLUMNS.city),
      siret,
      phoneNumber: normalizePhone(rowCell(row, DECLARANT_COLUMNS.phoneNumber)),
      sourceId
    }
  }
}

function buildExploitationRecord(row) {
  const pointName = rowCell(row, EXPLOITATION_COLUMNS.pointName)
  const declarantSelector = rowCell(row, EXPLOITATION_COLUMNS.declarantSelector)

  if (!pointName || !declarantSelector) {
    return null
  }

  return {
    pointName,
    declarantSelector,
    legacyUsages: mapUsages([
      rowCell(row, EXPLOITATION_COLUMNS.mainUsage),
      rowCell(row, EXPLOITATION_COLUMNS.usage2),
      rowCell(row, EXPLOITATION_COLUMNS.usage3)
    ]),
    startDate: rowDateCell(row, EXPLOITATION_COLUMNS.startDate),
    endDate: rowDateCell(row, EXPLOITATION_COLUMNS.endDate),
    comment: rowCell(row, EXPLOITATION_COLUMNS.comment)
  }
}

async function readXlsxWorkbook(workbookPath) {
  const buffer = await fs.readFile(workbookPath)
  return XLSX.read(buffer, {
    type: 'buffer',
    cellDates: true
  })
}

function assertWorkbookSheets(workbook, dataset) {
  for (const sheetName of Object.values(SHEETS)) {
    if (!workbook.SheetNames.includes(sheetName)) {
      throw new Error(`Onglet "${sheetName}" introuvable dans ${dataset.input}`)
    }
  }
}

function sheetRows(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName]

  return XLSX.utils.sheet_to_json(sheet, {
    defval: null,
    raw: true,
    blankrows: false
  }).map((row, index) => ({
    row,
    rowNumber: index + 2
  })).filter(({row}) => rowCell(row, '#'))
}

async function readDataset(dataset) {
  const workbook = await readXlsxWorkbook(dataset.input)
  assertWorkbookSheets(workbook, dataset)

  const pointRows = sheetRows(workbook, SHEETS.points)
  const declarantRows = sheetRows(workbook, SHEETS.declarants)
  const exploitationRows = sheetRows(workbook, SHEETS.exploitations)

  const points = []
  const skippedPoints = []
  const unresolvedCommunes = new Set()

  for (const {row, rowNumber} of pointRows) {
    const payload = buildPointPayload({row, dataset})

    if (!payload) {
      skippedPoints.push(rowNumber)
      continue
    }

    if (payload.communeName && !payload.communeCode) {
      unresolvedCommunes.add(payload.communeName)
    }

    points.push({row, rowNumber, payload})
  }

  const declarants = []
  const skippedDeclarants = []

  for (const {row, rowNumber} of declarantRows) {
    const record = buildDeclarantRecord(row)

    if (!record) {
      skippedDeclarants.push(rowNumber)
      continue
    }

    declarants.push({row, rowNumber, ...record})
  }

  const exploitations = []
  const skippedExploitations = []

  for (const {row, rowNumber} of exploitationRows) {
    const record = buildExploitationRecord(row)

    if (!record) {
      skippedExploitations.push(rowNumber)
      continue
    }

    exploitations.push({row, rowNumber, ...record})
  }

  return {
    dataset,
    points,
    declarants,
    exploitations,
    skippedPoints,
    skippedDeclarants,
    skippedExploitations,
    unresolvedCommunes
  }
}

function createDeclarantIndexes() {
  return {
    results: [],
    bySourceId: new Map(),
    byEmail: new Map(),
    bySiret: new Map(),
    byName: new Map()
  }
}

function addDeclarantToIndexes(indexes, declarant) {
  indexes.results.push(declarant)
  indexes.bySourceId.set(declarant.sourceId, declarant)

  for (const email of declarant.emails ?? []) {
    indexes.byEmail.set(normalizeEmail(email), declarant)
  }

  if (declarant.siret) {
    indexes.bySiret.set(declarant.siret, declarant)
  }

  if (declarant.socialReason) {
    indexes.byName.set(normalizeName(declarant.socialReason), declarant)
  }
}

function createPointIndexes() {
  return {
    results: [],
    byName: new Map(),
    bySourceId: new Map()
  }
}

function addPointToIndexes(indexes, point) {
  indexes.results.push(point)
  indexes.byName.set(normalizeName(point.name), point)
  indexes.bySourceId.set(point.sourceId, point)
}

function findDeclarantForSelector(selector, indexes) {
  const emails = extractEmails(selector)

  for (const email of emails) {
    const declarant = indexes.byEmail.get(email)

    if (declarant) {
      return declarant
    }
  }

  const siret = normalizeSiret(selector)

  if (siret && indexes.bySiret.has(siret)) {
    return indexes.bySiret.get(siret)
  }

  return indexes.byName.get(normalizeName(selector)) ?? null
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

async function findExistingDeclarant(sourceId, legacySourceIds = []) {
  const sourceIds = [sourceId, ...legacySourceIds]

  return prisma.declarant.findFirst({
    where: {sourceId: {in: sourceIds}},
    include: {user: true}
  })
}

async function upsertDeclarant({
  sourceId,
  primaryEmail,
  secondaryEmails = [],
  userData,
  declarantData,
  strictPrimaryEmail = false,
  legacySourceIds = []
}) {
  const existingDeclarant = await findExistingDeclarant(sourceId, legacySourceIds)

  if (existingDeclarant) {
    const email = primaryEmail
      ? await safePrimaryEmail(primaryEmail, existingDeclarant.userId)
      : undefined

    if (strictPrimaryEmail && primaryEmail && email !== primaryEmail) {
      throw new Error(`Email collecteur déjà utilisé par un autre utilisateur : ${primaryEmail}`)
    }

    await prisma.$transaction(async tx => {
      await tx.user.update({
        where: {id: existingDeclarant.userId},
        data: cleanObject({
          ...userData,
          ...(primaryEmail ? {email} : {})
        })
      })

      await tx.declarant.update({
        where: {userId: existingDeclarant.userId},
        data: cleanObject({
          ...declarantData,
          sourceId
        })
      })
    })

    await syncAliases(existingDeclarant.userId, [email ? null : primaryEmail, ...secondaryEmails])
    return existingDeclarant.userId
  }

  const userId = randomUUID()
  const email = await safePrimaryEmail(primaryEmail)

  if (strictPrimaryEmail && primaryEmail && email !== primaryEmail) {
    throw new Error(`Email collecteur déjà utilisé par un autre utilisateur : ${primaryEmail}`)
  }

  await prisma.user.create({
    data: {
      id: userId,
      role: 'DECLARANT',
      email,
      ...cleanObject(userData),
      declarant: {
        create: cleanObject({
          ...declarantData,
          sourceId
        })
      }
    }
  })

  await syncAliases(userId, [email ? null : primaryEmail, ...secondaryEmails])
  return userId
}

async function upsertCollecteurFromCsv(sourceId) {
  const csv = await fs.readFile(COLLECTEUR_ACCOUNTS_PATH, 'utf8')
  const rows = parse(csv, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: true
  })
  const row = rows.find(candidate => rowCell(candidate, 'sourceId') === sourceId)
    ?? rows.find(candidate => LEGACY_SMNPR_COLLECTEUR_SOURCE_IDS.includes(rowCell(candidate, 'sourceId')))

  if (!row) {
    throw new Error(`Collecteur ${sourceId} introuvable dans ${COLLECTEUR_ACCOUNTS_PATH}`)
  }

  const emails = extractEmails(row.email)
  const [primaryEmail, ...secondaryEmails] = emails

  if (!primaryEmail) {
    throw new Error(`Email obligatoire pour le collecteur ${sourceId}`)
  }

  const userId = await upsertDeclarant({
    sourceId,
    primaryEmail,
    secondaryEmails,
    strictPrimaryEmail: true,
    legacySourceIds: LEGACY_SMNPR_COLLECTEUR_SOURCE_IDS,
    userData: {
      firstName: rowCell(row, 'firstName'),
      lastName: rowCell(row, 'lastName')
    },
    declarantData: {
      declarantType: rowCell(row, 'declarantType') ?? 'LEGAL_PERSON',
      declarantRole: 'COLLECTEUR',
      socialReason: rowCell(row, 'socialReason'),
      civility: normalizeCivility(rowCell(row, 'civility')),
      jobTitle: rowCell(row, 'jobTitle'),
      addressLine1: rowCell(row, 'addressLine1'),
      addressLine2: rowCell(row, 'addressLine2'),
      poBox: rowCell(row, 'poBox'),
      postalCode: normalizePostalCode(rowCell(row, 'postalCode')),
      city: rowCell(row, 'city'),
      phoneNumber: normalizePhone(rowCell(row, 'phoneNumber')),
      sourceId
    }
  })

  return {userId, sourceId}
}

async function importDeclarants(records) {
  const indexes = createDeclarantIndexes()

  for (const record of records) {
    const userId = await upsertDeclarant({
      sourceId: record.sourceId,
      primaryEmail: record.primaryEmail,
      secondaryEmails: record.secondaryEmails,
      userData: record.userData,
      declarantData: record.declarantData
    })

    addDeclarantToIndexes(indexes, {
      userId,
      sourceId: record.sourceId,
      emails: record.emails,
      siret: record.siret,
      socialReason: record.socialReason
    })
  }

  return indexes
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

async function importPoints(records) {
  const indexes = createPointIndexes()

  for (const record of records) {
    const point = await upsertPoint(record.payload)

    addPointToIndexes(indexes, {
      id: point.id,
      name: record.payload.name,
      sourceId: record.payload.sourceId
    })
  }

  return indexes
}

async function upsertExploitation({
  point,
  declarant,
  sourceId,
  legacyUsages,
  startDate,
  endDate,
  comment,
  collecteurUserId
}) {
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
    usageId: await resolveUsageId(legacyUsages),
    startDate,
    endDate,
    sourceId,
    comment
  }

  const exploitation = existing
    ? await prisma.declarantPointPrelevement.update({
      where: {id: existing.id},
      data,
      select: {id: true}
    })
    : await prisma.declarantPointPrelevement.create({
      data,
      select: {id: true}
    })

  if (collecteurUserId) {
    const result = await prisma.declarantCollecteurExploitation.createMany({
      data: [
        {
          id: randomUUID(),
          collecteurUserId,
          exploitationId: exploitation.id
        }
      ],
      skipDuplicates: true
    })

    return {
      exploitation,
      collecteurRightCreated: result.count > 0
    }
  }

  return {
    exploitation,
    collecteurRightCreated: false
  }
}

async function importExploitations({records, declarants, points, dataset, collecteur}) {
  const summary = {
    processed: 0,
    skipped: 0,
    missingDeclarants: 0,
    missingPoints: 0,
    collecteurRightsCreated: 0
  }

  for (const record of records) {
    const point = points.byName.get(normalizeName(record.pointName))
    const declarant = findDeclarantForSelector(record.declarantSelector, declarants)

    if (!point) {
      summary.missingPoints++
      console.warn(`[${dataset.label}] Point introuvable pour l'exploitation ligne ${record.rowNumber} : ${record.pointName}`)
      continue
    }

    if (!declarant) {
      summary.missingDeclarants++
      console.warn(`[${dataset.label}] Déclarant introuvable pour l'exploitation ligne ${record.rowNumber} : ${record.declarantSelector}`)
      continue
    }

    const sourceId = generatedExploitationSourceId(point.sourceId, declarant.sourceId)
    const result = await upsertExploitation({
      point,
      declarant,
      sourceId,
      legacyUsages: record.legacyUsages,
      startDate: record.startDate,
      endDate: record.endDate,
      comment: compactLines([
        ['Fichier source', path.basename(dataset.input)],
        ['Commentaire source', record.comment],
        ['Préleveur source', record.declarantSelector]
      ]),
      collecteurUserId: collecteur?.userId ?? null
    })

    summary.processed++

    if (result.collecteurRightCreated) {
      summary.collecteurRightsCreated++
    }
  }

  return summary
}

function buildDryRunDeclarantIndexes(records) {
  const indexes = createDeclarantIndexes()

  for (const record of records) {
    addDeclarantToIndexes(indexes, {
      userId: record.sourceId,
      sourceId: record.sourceId,
      emails: record.emails,
      siret: record.siret,
      socialReason: record.socialReason
    })
  }

  return indexes
}

function buildDryRunPointIndexes(records) {
  const indexes = createPointIndexes()

  for (const record of records) {
    addPointToIndexes(indexes, {
      id: record.payload.sourceId,
      sourceId: record.payload.sourceId,
      name: record.payload.name
    })
  }

  return indexes
}

function duplicatedValues(values) {
  const counts = new Map()

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
}

function dryRunDataset(data) {
  const declarants = buildDryRunDeclarantIndexes(data.declarants)
  const points = buildDryRunPointIndexes(data.points)
  const summary = {
    missingDeclarants: 0,
    missingPoints: 0,
    duplicatePointSourceIds: duplicatedValues(data.points.map(record => record.payload.sourceId)),
    duplicateDeclarantSourceIds: duplicatedValues(data.declarants.map(record => record.sourceId))
  }

  for (const record of data.exploitations) {
    if (!points.byName.has(normalizeName(record.pointName))) {
      summary.missingPoints++
    }

    if (!findDeclarantForSelector(record.declarantSelector, declarants)) {
      summary.missingDeclarants++
    }
  }

  return summary
}

async function importDataset(data, collecteursBySourceId) {
  const {dataset} = data
  console.log(`\nImport ${dataset.label} depuis ${dataset.input}`)

  const collecteur = dataset.collecteurSourceId
    ? collecteursBySourceId.get(dataset.collecteurSourceId)
    : null
  const declarants = await importDeclarants(data.declarants)
  const points = await importPoints(data.points)
  const exploitations = await importExploitations({
    records: data.exploitations,
    declarants,
    points,
    dataset,
    collecteur
  })

  console.log(`Déclarants importés/mis à jour : ${declarants.results.length}`)
  console.log(`Points importés/mis à jour : ${points.results.length}`)
  console.log(`Exploitations importées/mises à jour : ${exploitations.processed}`)
  console.log(`Droits collecteur créés : ${exploitations.collecteurRightsCreated}`)

  if (data.skippedPoints.length > 0) {
    console.warn(`Lignes points ignorées : ${data.skippedPoints.join(', ')}`)
  }

  if (data.skippedDeclarants.length > 0) {
    console.warn(`Lignes déclarants ignorées : ${data.skippedDeclarants.join(', ')}`)
  }

  if (data.skippedExploitations.length > 0 || exploitations.missingDeclarants > 0 || exploitations.missingPoints > 0) {
    console.warn(`Exploitations ignorées : ${data.skippedExploitations.length + exploitations.missingDeclarants + exploitations.missingPoints}`)
    console.warn(`- lignes incomplètes : ${data.skippedExploitations.length}`)
    console.warn(`- sans déclarant trouvé : ${exploitations.missingDeclarants}`)
    console.warn(`- sans point trouvé : ${exploitations.missingPoints}`)
  }

  if (data.unresolvedCommunes.size > 0) {
    console.warn('Communes sans code INSEE résolu :')
    for (const commune of [...data.unresolvedCommunes].sort()) {
      console.warn(`- ${commune}`)
    }
  }
}

function parseArgs(args) {
  const options = {
    dryRun: false,
    only: null
  }

  for (const arg of args) {
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }

    if (arg.startsWith('--only=')) {
      options.only = new Set(
        arg
          .slice('--only='.length)
          .split(',')
          .map(value => value.trim())
          .filter(Boolean)
      )
      continue
    }

    throw new Error(`Argument inconnu : ${arg}`)
  }

  return options
}

function selectedDatasets(options) {
  if (!options.only) {
    return DATASETS
  }

  const knownKeys = new Set(DATASETS.map(dataset => dataset.key))
  const unknownKeys = [...options.only].filter(key => !knownKeys.has(key))

  if (unknownKeys.length > 0) {
    throw new Error(`Valeur --only inconnue : ${unknownKeys.join(', ')}. Valeurs attendues : ${[...knownKeys].join(', ')}`)
  }

  return DATASETS.filter(dataset => options.only.has(dataset.key))
}

async function main() {
  const options = parseArgs(argv.slice(2))
  const datasets = selectedDatasets(options)
  const dataByDataset = []

  for (const dataset of datasets) {
    dataByDataset.push(await readDataset(dataset))
  }

  if (options.dryRun) {
    console.log('Dry-run BVTech eaux souterraines')

    for (const data of dataByDataset) {
      const summary = dryRunDataset(data)

      console.log(`\n${data.dataset.label}`)
      console.log(`Points valides : ${data.points.length}`)
      console.log(`Déclarants valides : ${data.declarants.length}`)
      console.log(`Exploitations valides : ${data.exploitations.length}`)
      console.log(`Lignes points ignorées : ${data.skippedPoints.length}`)
      console.log(`Lignes déclarants ignorées : ${data.skippedDeclarants.length}`)
      console.log(`Lignes exploitations ignorées : ${data.skippedExploitations.length}`)
      console.log(`Exploitations sans point trouvé : ${summary.missingPoints}`)
      console.log(`Exploitations sans déclarant trouvé : ${summary.missingDeclarants}`)
      console.log(`SourceId points dupliqués : ${summary.duplicatePointSourceIds.length}`)
      console.log(`SourceId déclarants dupliqués : ${summary.duplicateDeclarantSourceIds.length}`)
      console.log(`Communes sans code INSEE résolu : ${data.unresolvedCommunes.size}`)
    }

    return
  }

  const collecteurSourceIds = unique(datasets.map(dataset => dataset.collecteurSourceId))
  const collecteursBySourceId = new Map()

  for (const sourceId of collecteurSourceIds) {
    const collecteur = await upsertCollecteurFromCsv(sourceId)
    collecteursBySourceId.set(sourceId, collecteur)
    console.log(`Collecteur importé/mis à jour : ${sourceId}`)
  }

  for (const data of dataByDataset) {
    await importDataset(data, collecteursBySourceId)
  }

  console.log('\nImport BVTech eaux souterraines terminé')
}

try {
  await main()
} finally {
  await prisma.$disconnect()
}
