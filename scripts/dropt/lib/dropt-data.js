// Noinspection JSNonASCIINames

import ExcelJS from 'exceljs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import proj4 from 'proj4'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const SOURCE_PREFIX = 'dropt-par-2026-2027'
export const SHEET_NAME = 'PAR_2026-2027'
export const EXCEL_PATH = path.resolve(
  __dirname,
  '../../../data/dropt/FICHIER_PLAT_OUDropt_RETOUR_ENQUETE26-27.xlsx'
)

export const DROPT_ROUGH_WGS84_BOUNDS = {
  minLon: -0.25,
  maxLon: 1.15,
  minLat: 44.45,
  maxLat: 44.9
}

const COLUMN_ALIASES = {
  commentairesDdt: ['Commentaires Instruction DDTs 33/24'],
  codeOuvrageOugc: ['code ouvrage ougc'],
  codeCacg: ['Code CACG'],
  modifiePar: ['MODIFIE PAR (initiales)'],
  commentairesIrrigants: ['Commentaires Irrigants et OU'],
  question: ['QUESTION'],
  aFaire: ['A FAIRE'],
  activite2024: ['ACTIVITE DU POINT 2024'],
  activite2025: ['ACTIVITE DU POINT 2025'],
  instruction2024: ['INSTRUCTION 2024'],
  instruction2025: ['INSTRUCTION 2025'],
  instruction2026: ['INSTRUCTION 2026'],
  action: ['ACTION'],
  retourEnquete2024: ['RETOUR ENQUETE 2024'],
  retourEnquete2025: ['RETOUR ENQUETE 2025'],
  retourEnquete2026: ['RETOUR ENQUETE 2026'],
  dpt: ['DPT'],
  pe: ['PE'],
  debitEte: ['Debit en m3/h - ETE', 'Débit en m3/h – ETE'],
  surfaceEte: ['Surface en ha - ETE', 'Surface en ha – ETE'],
  volumeDemandeEte: ['Volume demande m3 ETE', 'Volume demandé m3 ÉTÉ'],
  volumeNonReponsesEtiage: ['volumes des non reponses etiage'],
  volumeApresInstructionEtiage: ['VOLUMES APRES INSTRUCTION 1 ETIAGE'],
  volumeGroupesCacg: ['Volume groupes pour CACG'],
  volumeGroupesCacgEcrete: ['Volume groupes CACG ECRETE'],
  surfaceHorsEtiage: ['Surface en ha - HORS ETIAGE', 'Surface en ha – HORS ÉTIAGE'],
  debitHorsEtiage: ['Debit en m3/h - HORS ETIAGE', 'Débit en m3/h – HORS ÉTIAGE'],
  volumeDemandeHorsEtiage: ['Volume demande m3 HORS ETIAGE', 'Volume demandé m3 HORS ÉTIAGE'],
  volumeApresInstructionHorsEtiage: ['VOLUMES APRES INSTRUCTION 1 HORS ETIAGE'],
  volumeHiverIrrigation: ['Volume hiver irrigation'],
  volumeHiverRemplissage: ['Volume hiver remplissage'],
  volumeHiverAntigel: ['Volume hiver antigel'],
  pointDdt: ['N° Point DDT (N° Interne a la DDT)2', 'N° Point DDT (N° Interne à la DDT)2'],
  ouvrageDdt: ['N° Ouvrage DDT (N° Interne a la DDT) CACG ouvrage3', 'N° Ouvrage DDT (N° Interne à la DDT) CACG ouvrage3'],
  ouvrageOugc: ['N° Ouvrage OUGC'],
  lieuDitImplantation: ['Lieu-dit implantation'],
  section: ['section'],
  parcelle: ['parcelle'],
  coordX: ['Coordonnee X', 'Coordonnée X'],
  coordY: ['Coordonnee Y', 'Coordonnée Y'],
  communeOuvrage: ['commune de l\'ouvrage'],
  usagePrincipal: ['Usage de l\'eau principal'],
  typeRessourcePrelevement: ['Type de ressource de prelevement', 'Type de ressource de prélèvement'],
  typeRessourcePar: ['TYPE DE RESSOURCE DANS LE PAR'],
  ressourceLocale: ['Libelle local de la ressource de prelevement', 'Libellé local de la ressource de prélèvement'],
  methodeRemplissage: ['Methode de remplissage', 'Méthode de remplissage'],
  volumeNominalStockage: ['Volume nominal (en m3) de l\'unite de stockage temporaire de prelevement', 'Volume nominal (en m3) de l\'unité de stockage temporaire de prélèvement'],
  compteurReference: ['Reference dispositif de comptage (N° de serie)', 'Référence dispositif de comptage (N° de série)'],
  compteurType: ['TYPE COMPTEUR'],
  compteurDateInstallation: ['Date installation'],
  siret: ['Code SIRET du preleveur', 'Code SIRET du préleveur'],
  syndicat: ['Syndicat'],
  nomPreleveur: ['Nom du preleveur', 'Nom du préleveur'],
  gerant: ['gerant', 'gérant'],
  adresseResidence: ['Adresse du preleveur (residence)', 'Adresse du préleveur (résidence)'],
  adresseVoie: ['ADRESSE DU PRELEVEUR (VOIE)', 'ADRESSE DU PRÉLEVEUR  (VOIE)'],
  adresseLieuDit: ['ADRESSE DU PRELEVEUR (LIEU-DIT)', 'ADRESSE DU PRÉLEVEUR  (LIEU-DIT)'],
  postalCode: ['Adresse du preleveur (code postal)', 'Adresse du préleveur  (code postal)'],
  communeCode: ['Adresse du preleveur (Pour la France, ce champ contient la valeur du code INSEE)', 'Adresse du préleveur  (Pour la France, ce champ contient la valeur du code INSEE)'],
  city: ['Adresse du preleveur (localite)', 'Adresse du préleveur  (localité)'],
  email: ['mail'],
  portable: ['portable'],
  fixe: ['fixe'],
  communicationPreference: ['Preference de communication', 'Préférence de communication']
}

proj4.defs('EPSG:4326', '+proj=longlat +datum=WGS84 +no_defs')
proj4.defs(
  'EPSG:2154',
  '+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs'
)
proj4.defs(
  'EPSG:3944',
  '+proj=lcc +lat_1=43.25 +lat_2=44.75 +lat_0=44 +lon_0=3 +x_0=1700000 +y_0=3200000 +ellps=GRS80 +units=m +no_defs'
)
proj4.defs(
  'EPSG:3857',
  '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs'
)

export function clean(value) {
  if (value === null || value === undefined) {
    return null
  }

  const raw = String(value)
    .replaceAll('\u00A0', ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()

  return raw || null
}

function cellToText(value) {
  if (value === null || value === undefined) {
    return null
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10)
  }

  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) {
      return clean(value.richText.map(part => part.text ?? '').join(''))
    }

    if ('result' in value) {
      return cellToText(value.result)
    }

    if ('text' in value) {
      return clean(value.text)
    }

    if ('hyperlink' in value && 'text' in value) {
      return clean(value.text)
    }
  }

  return clean(value)
}

export function normalizeLookup(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036F]/g, '')
    .replaceAll(/[’‘]/g, '\'')
    .replaceAll(/[–—]/g, '-')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('fr-FR')
}

export function slug(value) {
  const s = String(clean(value) ?? 'non-renseigne')
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036F]/g, '')
    .toLocaleLowerCase('fr-FR')
    .replaceAll(/[^a-z\d]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 120)

  return s || 'non-renseigne'
}

export function parseNumber(value) {
  const raw = clean(value)
  if (!raw) {
    return null
  }

  const normalized = raw
    .replaceAll(/\s/g, '')
    .replace(',', '.')

  const n = Number(normalized)
  return Number.isFinite(n) ? n : null
}

export function normalizeSiret(value) {
  const raw = clean(value)
  if (!raw) {
    return null
  }

  const digits = raw.replaceAll(/\D/g, '')
  if (!digits || /^0+$/.test(digits)) {
    return null
  }

  return digits.slice(0, 14) || null
}

function normalizeIdentifier(value) {
  const raw = clean(value)
  if (!raw) {
    return null
  }

  return raw
    .replace(/\.0$/, '')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

function isGenericPointIdentifier(value) {
  const normalized = normalizeLookup(value)

  return !normalized
    || normalized === '0'
    || normalized === '-'
    || normalized === 'neant'
    || normalized === 'non renseigne'
    || normalized === 'sage nappes profondes'
}

function getPointBaseKey(row) {
  const candidates = [
    row.ouvrageOugc,
    row.codeOuvrageOugc,
    row.pointDdt,
    row.codeCacg
  ]
    .map(normalizeIdentifier)
    .filter(Boolean)

  for (const candidate of candidates) {
    if (!isGenericPointIdentifier(candidate)) {
      return candidate
    }
  }

  const fallback = [
    row.communeOuvrage,
    row.lieuDitImplantation,
    row.section,
    row.parcelle
  ]
    .map(normalizeIdentifier)
    .filter(Boolean)
    .join(' - ')

  return fallback || `ligne-${row.excelRowNumber}`
}

function getDeclarantBaseKey(row) {
  const siret = normalizeSiret(row.siret)
  if (siret) {
    return `siret-${siret}`
  }

  const name = clean(row.nomPreleveur)
  if (name) {
    return `nom-${name}`
  }

  const email = getEmails(row)[0]
  if (email) {
    return `email-${email}`
  }

  return `ligne-${row.excelRowNumber}`
}

function isRelevantDroptRow(row) {
  return [
    row.codeOuvrageOugc,
    row.ouvrageOugc,
    row.pointDdt,
    row.codeCacg,
    row.nomPreleveur,
    row.siret,
    row.communeOuvrage,
    row.coordX,
    row.coordY
  ].some(value => clean(value))
}

function getValueByAliases(valuesByHeader, aliases) {
  for (const alias of aliases) {
    const key = normalizeLookup(alias)
    if (valuesByHeader.has(key)) {
      return valuesByHeader.get(key)
    }
  }

  return null
}

function collectCultureSummary(valuesByHeader, labelsByHeader) {
  const lines = []

  for (const [header, value] of valuesByHeader.entries()) {
    const v = clean(value)
    if (!v) {
      continue
    }

    if (header.includes('culture') || header.startsWith('ha ')) {
      const label = labelsByHeader.get(header) ?? header
      lines.push(`${label}: ${v}`)
    }
  }

  return lines.length > 0 ? lines.join(' ; ') : null
}

function countBy(values) {
  const counts = new Map()

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }

  return counts
}

function annotateRows(rows) {
  const pointBaseKeys = rows.map(row => slug(getPointBaseKey(row)))
  const pointCounts = countBy(pointBaseKeys)

  for (const row of rows) {
    const basePointKey = getPointBaseKey(row)
    const pointKeySlug = slug(basePointKey)
    const isDuplicate = pointCounts.get(pointKeySlug) > 1
      || isGenericPointIdentifier(basePointKey)

    const pointSourceKey = isDuplicate
      ? `${basePointKey}-ligne-${row.excelRowNumber}`
      : basePointKey

    row.pointSourceKey = pointSourceKey
    row.pointSourceId = `${SOURCE_PREFIX}-point-${slug(pointSourceKey)}`
    row.pointName = isDuplicate
      ? `${basePointKey} (ligne ${row.excelRowNumber})`
      : basePointKey

    const declarantSourceKey = getDeclarantBaseKey(row)
    row.declarantSourceKey = declarantSourceKey
    row.declarantSourceId = `${SOURCE_PREFIX}-declarant-${slug(declarantSourceKey)}`
    row.exploitationSourceId = `${SOURCE_PREFIX}-exploitation-${slug(declarantSourceKey)}-${slug(pointSourceKey)}`
  }

  return rows
}

export async function readDroptRows() {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(EXCEL_PATH)

  const worksheet = workbook.getWorksheet(SHEET_NAME)
  if (!worksheet) {
    throw new Error(`Onglet introuvable : ${SHEET_NAME}`)
  }

  const headerIndexes = new Map()
  const labelsByHeader = new Map()
  const headerRow = worksheet.getRow(1)

  headerRow.eachCell({includeEmpty: false}, (cell, columnNumber) => {
    const label = cellToText(cell.value)
    const normalized = normalizeLookup(label)
    if (normalized) {
      headerIndexes.set(normalized, columnNumber)
      labelsByHeader.set(normalized, label)
    }
  })

  const rows = []

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
    const excelRow = worksheet.getRow(rowNumber)
    const valuesByHeader = new Map()

    for (const [header, columnNumber] of headerIndexes.entries()) {
      valuesByHeader.set(header, cellToText(excelRow.getCell(columnNumber).value))
    }

    const row = {
      excelRowNumber: rowNumber,
      cultureSummary: collectCultureSummary(valuesByHeader, labelsByHeader)
    }

    for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
      row[key] = getValueByAliases(valuesByHeader, aliases)
    }

    if (isRelevantDroptRow(row)) {
      rows.push(row)
    }
  }

  return annotateRows(rows)
}

function isWgs84LonLat(x, y) {
  return x >= -5 && x <= 10 && y >= 40 && y <= 52
}

function isWgs84LatLon(x, y) {
  return x >= 40 && x <= 52 && y >= -5 && y <= 10
}

function isInDroptBounds(lon, lat) {
  return lon >= DROPT_ROUGH_WGS84_BOUNDS.minLon
    && lon <= DROPT_ROUGH_WGS84_BOUNDS.maxLon
    && lat >= DROPT_ROUGH_WGS84_BOUNDS.minLat
    && lat <= DROPT_ROUGH_WGS84_BOUNDS.maxLat
}

function toLonLat(x, y, srid) {
  if (srid === 4326) {
    return [x, y]
  }

  return proj4(`EPSG:${srid}`, 'EPSG:4326', [x, y])
}

function addCoordinateCandidate(candidates, {x, y, srid, note}) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !srid) {
    return
  }

  try {
    const [lon, lat] = toLonLat(x, y, srid)

    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      return
    }

    candidates.push({x, y, srid, lon, lat, note})
  } catch {}
}

function oneDigitDeletionNumbers(rawValue) {
  const raw = clean(rawValue)
  if (!raw) {
    return []
  }

  const sign = raw.trim().startsWith('-') ? '-' : ''
  const digits = raw.replaceAll(/\D/g, '')
  if (digits.length < 8) {
    return []
  }

  const values = new Set()

  for (let index = 0; index < digits.length; index++) {
    const candidateDigits = digits.slice(0, index) + digits.slice(index + 1)
    if (candidateDigits.length < 6) {
      continue
    }

    const n = Number(`${sign}${candidateDigits}`)
    if (Number.isFinite(n)) {
      values.add(n)
    }
  }

  return [...values]
}

export function normalizeCoordinates(row) {
  const rawX = row.coordX
  const rawY = row.coordY
  const x = parseNumber(rawX)
  const y = parseNumber(rawY)

  if (x === null || y === null || (x === 0 && y === 0)) {
    return {
      x: null,
      y: null,
      srid: null,
      lon: null,
      lat: null,
      note: 'coordonnées absentes ou nulles'
    }
  }

  const candidates = []

  if (isWgs84LonLat(x, y)) {
    addCoordinateCandidate(candidates, {
      x,
      y,
      srid: 4326,
      note: 'coordonnées WGS84 lon/lat'
    })
  }

  if (isWgs84LatLon(x, y)) {
    addCoordinateCandidate(candidates, {
      x: y,
      y: x,
      srid: 4326,
      note: 'coordonnées WGS84 lat/lon inversées dans le fichier'
    })
  }

  addCoordinateCandidate(candidates, {
    x,
    y,
    srid: 2154,
    note: 'Lambert-93 EPSG:2154'
  })

  if (Math.abs(y) > 100_000 && Math.abs(y) < 1_000_000) {
    addCoordinateCandidate(candidates, {
      x,
      y: y * 10,
      srid: 2154,
      note: 'Lambert-93 EPSG:2154, ordonnée multipliée par 10 (zéro manquant probable)'
    })
  }

  if (Math.abs(y) > 10_000_000) {
    addCoordinateCandidate(candidates, {
      x,
      y: y / 10,
      srid: 2154,
      note: 'Lambert-93 EPSG:2154, ordonnée divisée par 10 (chiffre supplémentaire probable)'
    })

    for (const candidateY of oneDigitDeletionNumbers(rawY)) {
      addCoordinateCandidate(candidates, {
        x,
        y: candidateY,
        srid: 2154,
        note: 'Lambert-93 EPSG:2154, ordonnée corrigée par suppression d’un chiffre probable'
      })
    }
  }

  addCoordinateCandidate(candidates, {
    x,
    y,
    srid: 3944,
    note: 'Conique Conforme 44 EPSG:3944'
  })

  addCoordinateCandidate(candidates, {
    x,
    y,
    srid: 3857,
    note: 'Web Mercator EPSG:3857'
  })

  const candidate = candidates.find(c => isInDroptBounds(c.lon, c.lat))

  if (!candidate) {
    return {
      x: null,
      y: null,
      srid: null,
      lon: null,
      lat: null,
      note: `coordonnées ignorées : aucune projection testée ne tombe dans l’emprise Dropt approximative (X=${rawX}, Y=${rawY})`
    }
  }

  return candidate
}

function compactLines(lines) {
  return lines.filter(Boolean).join('\n') || null
}

function line(label, value) {
  const v = clean(value)
  return v ? `${label}: ${v}` : null
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))]
}

export function getWaterBodyType(row) {
  const typePar = normalizeLookup(row.typeRessourcePar)
  const typePrelevement = normalizeLookup(row.typeRessourcePrelevement)

  if (typePar.includes('nappe') || typePrelevement === 'f' || typePrelevement === 'p') {
    return 'SOUTERRAIN'
  }

  if (
    typePar.includes('eaux superficielles')
    || typePar.includes('retenues')
    || ['pe', 'cont', 'ce'].includes(typePrelevement)
  ) {
    return 'SURFACE'
  }

  return null
}

export function buildOtherNames(row) {
  const values = uniq([
    row.codeOuvrageOugc,
    row.codeCacg,
    row.pointDdt,
    row.ouvrageDdt,
    row.ouvrageOugc
  ].map(normalizeIdentifier))

  return values.length > 0 ? values.join(' | ') : null
}

export function buildLocationDescription(row) {
  return compactLines([
    line('Lieu-dit implantation', row.lieuDitImplantation),
    line('Section', row.section),
    line('Parcelle', row.parcelle)
  ])
}

export function buildPointComment(row) {
  return compactLines([
    `Import SAGE Dropt - ${SHEET_NAME} - ligne Excel ${row.excelRowNumber}`,
    line('DPT', row.dpt),
    line('PE', row.pe),
    line('Usage principal', row.usagePrincipal),
    line('Type ressource prélèvement', row.typeRessourcePrelevement),
    line('Type ressource PAR', row.typeRessourcePar),
    line('Libellé local ressource', row.ressourceLocale),
    line('Méthode remplissage', row.methodeRemplissage),
    line('Volume nominal stockage (m3)', row.volumeNominalStockage),
    line('Référence compteur', row.compteurReference),
    line('Type compteur', row.compteurType),
    line('Date installation compteur', row.compteurDateInstallation)
  ])
}

export function buildPointInternalComment(row, coordinates) {
  const coordinateLine = coordinates?.srid
    ? `Coordonnées retenues: SRID ${coordinates.srid}, ${coordinates.note}, lon/lat ≈ ${coordinates.lon.toFixed(6)}, ${coordinates.lat.toFixed(6)}`
    : `Coordonnées non importées: ${coordinates?.note ?? 'non renseigné'}`

  return compactLines([
    coordinateLine,
    line('Commentaires instruction DDT', row.commentairesDdt),
    line('Commentaires irrigants et OU', row.commentairesIrrigants),
    line('Question', row.question),
    line('À faire', row.aFaire),
    line('Modifié par', row.modifiePar),
    line('Action', row.action),
    line('Instruction 2024', row.instruction2024),
    line('Instruction 2025', row.instruction2025),
    line('Instruction 2026', row.instruction2026),
    line('Retour enquête 2024', row.retourEnquete2024),
    line('Retour enquête 2025', row.retourEnquete2025),
    line('Retour enquête 2026', row.retourEnquete2026),
    line('Activité du point 2024', row.activite2024),
    line('Activité du point 2025', row.activite2025),
    line('Débit été (m3/h)', row.debitEte),
    line('Surface été (ha)', row.surfaceEte),
    line('Volume demandé été (m3)', row.volumeDemandeEte),
    line('Volumes non-réponses étiage', row.volumeNonReponsesEtiage),
    line('Volumes après instruction étiage', row.volumeApresInstructionEtiage),
    line('Volume groupes CACG', row.volumeGroupesCacg),
    line('Volume groupes CACG écrêté', row.volumeGroupesCacgEcrete),
    line('Surface hors étiage (ha)', row.surfaceHorsEtiage),
    line('Débit hors étiage (m3/h)', row.debitHorsEtiage),
    line('Volume demandé hors étiage (m3)', row.volumeDemandeHorsEtiage),
    line('Volumes après instruction hors étiage', row.volumeApresInstructionHorsEtiage),
    line('Volume hiver irrigation', row.volumeHiverIrrigation),
    line('Volume hiver remplissage', row.volumeHiverRemplissage),
    line('Volume hiver antigel', row.volumeHiverAntigel),
    line('Cultures', row.cultureSummary)
  ])
}

export function getPointCodes(row) {
  return {
    codePTP: normalizeIdentifier(row.pointDdt),
    codeOPR: normalizeIdentifier(row.ouvrageOugc),
    codeAIOT: null,
    codeBNPE: null
  }
}

function stripNamePrefix(value) {
  return String(clean(value) ?? '')
    .replace(/^(m\.?|mme|madame|monsieur)\s+/i, '')
    .trim()
}

function parseIndividual(fullNameRaw) {
  const fullName = stripNamePrefix(fullNameRaw)
  if (!fullName) {
    return {firstName: null, lastName: null}
  }

  const parts = fullName.split(' ').filter(Boolean)
  if (parts.length === 1) {
    return {firstName: null, lastName: parts[0]}
  }

  return {
    lastName: parts[0],
    firstName: parts.slice(1).join(' ') || null
  }
}

function isLikelyLegalPerson(name) {
  const normalized = normalizeLookup(name)

  return /\b(earl|gaec|scea|sarl|sas|sa|sci|eurl|asa|asl|gfa|cuma|commune|mairie|syndicat|societe|ets|etablissement|exploitation agricole|association)\b/.test(normalized)
}

export function getEmails(row) {
  const raw = clean(row.email)
  if (!raw) {
    return []
  }

  return uniq(
    raw
      .split(/[;,|\s]+/)
      .map(email => email.trim().toLocaleLowerCase('fr-FR'))
      .filter(email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  )
}

export function getDeclarantData(row) {
  const siret = normalizeSiret(row.siret)
  const name = clean(row.nomPreleveur)
  const managerName = clean(row.gerant)
  const legal = Boolean(siret) || isLikelyLegalPerson(name)
  const manager = parseIndividual(managerName)
  const individual = parseIndividual(name)

  const firstName = legal ? manager.firstName : individual.firstName
  const lastName = legal ? manager.lastName : individual.lastName

  const addressLine1 = clean(row.adresseVoie) ?? clean(row.adresseResidence)
  const addressLine2 = compactLines([
    clean(row.adresseResidence) && clean(row.adresseResidence) !== addressLine1
      ? row.adresseResidence
      : null,
    row.adresseLieuDit
  ])?.replace(/\n/g, ' - ') ?? null

  return {
    sourceId: row.declarantSourceId,
    syntheticEmail: `${row.declarantSourceId}@import.local`,
    realEmails: getEmails(row),
    declarantType: legal ? 'LEGAL_PERSON' : 'NATURAL_PERSON',
    firstName,
    lastName,
    socialReason: legal ? name : null,
    siret,
    addressLine1,
    addressLine2,
    postalCode: clean(row.postalCode),
    city: clean(row.city),
    phoneNumber: clean(row.portable) ?? clean(row.fixe),
    civility: null,
    jobTitle: managerName ? 'Gérant' : null
  }
}

export function getExploitationStatus(row) {
  const normalized = normalizeLookup([
    row.action,
    row.activite2025,
    row.activite2024
  ].filter(Boolean).join(' '))

  if (normalized.includes('abandon') || normalized.includes('suppression')) {
    return 'ABANDONNEE'
  }

  if (normalized.includes('inactif')) {
    return 'TERMINEE'
  }

  if (
    normalized.includes('actif')
    || normalized.includes('reserve')
    || normalized.includes('nouveau')
  ) {
    return 'EN_ACTIVITE'
  }

  return 'NON_RENSEIGNE'
}

export function buildExploitationComment(row) {
  return compactLines([
    `Import SAGE Dropt - ${SHEET_NAME} - ligne Excel ${row.excelRowNumber}`,
    line('Activité 2024', row.activite2024),
    line('Activité 2025', row.activite2025),
    line('Retour enquête 2024', row.retourEnquete2024),
    line('Retour enquête 2025', row.retourEnquete2025),
    line('Retour enquête 2026', row.retourEnquete2026),
    line('Action', row.action),
    line('Instruction 2024', row.instruction2024),
    line('Instruction 2025', row.instruction2025),
    line('Instruction 2026', row.instruction2026),
    line('Débit été (m3/h)', row.debitEte),
    line('Surface été (ha)', row.surfaceEte),
    line('Volume demandé été (m3)', row.volumeDemandeEte),
    line('Volumes après instruction étiage', row.volumeApresInstructionEtiage),
    line('Surface hors étiage (ha)', row.surfaceHorsEtiage),
    line('Volume demandé hors étiage (m3)', row.volumeDemandeHorsEtiage),
    line('Volumes après instruction hors étiage', row.volumeApresInstructionHorsEtiage),
    line('Volume hiver irrigation', row.volumeHiverIrrigation),
    line('Volume hiver remplissage', row.volumeHiverRemplissage),
    line('Volume hiver antigel', row.volumeHiverAntigel),
    line('Cultures', row.cultureSummary),
    line('Commentaires instruction DDT', row.commentairesDdt),
    line('Commentaires irrigants et OU', row.commentairesIrrigants),
    line('Question', row.question),
    line('À faire', row.aFaire)
  ])
}
