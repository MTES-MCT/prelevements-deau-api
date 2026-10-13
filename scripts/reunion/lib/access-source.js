import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import Joi from 'joi'
import {
  getMissingPermissionDependencies,
  sortZonePermissions,
  ZONE_PERMISSION_CATALOG,
  ZONE_PERMISSION_CODES
} from '../../../lib/constants/zone-permissions.js'

const runFile = promisify(execFile)
const extractor = fileURLToPath(new URL('../extract-access-workbook.py', import.meta.url))
const permissionSheetName = 'Détail droits agent lecture seule'
const requiredHeaders = ['territoire', 'structure', 'prénom', 'nom', 'mail', 'fonction', 'statut', 'date_ouverture_droits', 'date_fermeture_droits', 'rôle Partageons l’eau', 'Détail']
const emailSchema = Joi.string().email({tlds: {allow: false}}).max(254).required()
const sha256 = value => createHash('sha256').update(value).digest('hex')
const text = value => String(value ?? '').trim()
const normalized = value => text(value).normalize('NFKD').replace(/\p{M}/gu, '').replace(/[’‘]/gu, "'").replace(/\s+/gu, ' ').toLowerCase()

function date(value, label) {
  const input = text(value)
  let candidate = input
  if (/^\d{2}\/\d{2}\/\d{2}(?:\d{2})?$/u.test(input)) {
    const [day, month, year] = input.split('/')
    candidate = `${year.length === 2 ? `20${year}` : year}-${month}-${day}`
  }

  if (!/^\d{4}-\d{2}-\d{2}$/u.test(candidate)) {
    throw new Error(`Date invalide : ${label}`)
  }

  const parsed = new Date(`${candidate}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate) {
    throw new Error(`Date invalide : ${label}`)
  }

  return candidate
}

function parseReadPermissions(permissionRows) {
  if (!Array.isArray(permissionRows) || normalized(permissionRows[0]?.cells?.[1]) !== 'agent lecture seule') {
    throw new Error('Feuille des droits lecture seule absente ou invalide')
  }

  const byLabel = new Map(ZONE_PERMISSION_CATALOG.map(item => [normalized(item.label), item.code]))
  const codes = []
  for (const record of permissionRows.slice(1)) {
    const label = normalized(record.cells?.[1])
    if (!label) {
      continue
    }

    const code = byLabel.get(label)
    if (!code || codes.includes(code)) {
      throw new Error(`Permission inconnue ou répétée à la ligne ${record.row}`)
    }

    codes.push(code)
  }

  if (codes.length !== 26 || getMissingPermissionDependencies(codes).length > 0) {
    throw new Error('La source doit définir exactement 26 droits lecture seule avec leurs dépendances')
  }

  return sortZonePermissions(codes)
}

function fieldsFromRows(rows) {
  if (!Array.isArray(rows) || !Array.isArray(rows[0]?.cells)) {
    throw new Error('Feuille des accès absente ou invalide')
  }

  const headers = rows[0].cells.map(normalized)
  for (const header of requiredHeaders) {
    if (headers.filter(value => value === normalized(header)).length !== 1) {
      throw new Error(`Colonne obligatoire absente ou répétée : ${header}`)
    }
  }

  return rows.slice(1).filter(record => record.cells.some(value => text(value))).map(record => {
    if (!Number.isSafeInteger(record.row) || record.row <= rows[0].row) {
      throw new Error('Numéro de ligne source invalide')
    }

    const field = name => text(record.cells[headers.indexOf(normalized(name))])
    return {row: record.row, field}
  })
}

function parseEntry({row, field}, {effectiveDate, readPermissions, warnings}) {
  const email = field('mail').toLowerCase()
  if (emailSchema.validate(email).error) {
    throw new Error(`Adresse email invalide à la ligne ${row}`)
  }

  const status = {'acces ouvert': 'OPEN', 'acces a supprimer': 'REMOVE', 'acces supprime': 'CLOSED'}[normalized(field('statut'))]
  if (!status) {
    throw new Error(`Statut inconnu à la ligne ${row}`)
  }

  const startDate = field('date_ouverture_droits') ? date(field('date_ouverture_droits'), `ouverture ligne ${row}`) : effectiveDate
  if (!field('date_ouverture_droits')) {
    warnings.push({code: 'MISSING_OPENING_DATE', row})
  }

  let endDate = null
  if (status === 'REMOVE') {
    endDate = effectiveDate
  } else if (status === 'CLOSED') {
    endDate = date(field('date_fermeture_droits'), `fermeture ligne ${row}`)
  } else if (field('date_fermeture_droits')) {
    throw new Error(`Accès ouvert avec date de fermeture à la ligne ${row}`)
  }

  if (endDate && endDate < startDate) {
    throw new Error(`Fermeture antérieure à l’ouverture à la ligne ${row}`)
  }

  let role = null
  let permissions = []
  if (status === 'OPEN') {
    const sourceRole = normalized(field('rôle Partageons l’eau'))
    if (sourceRole === 'declarant') {
      role = 'DECLARANT'
      if (field('Détail')) {
        throw new Error(`Détail de droits inattendu pour un déclarant à la ligne ${row}`)
      }
    } else if (sourceRole === 'agent') {
      role = 'INSTRUCTOR'
      const detail = normalized(field('Détail'))
      if (!['lecture seule', 'lecture et ecriture'].includes(detail)) {
        throw new Error(`Droits agent non définis à la ligne ${row}`)
      }

      permissions = [...(detail === 'lecture seule' ? readPermissions : ZONE_PERMISSION_CODES)]
    } else {
      throw new Error(`Rôle cible inconnu à la ligne ${row}`)
    }
  }

  const sourceTerritory = field('territoire')
  if (!sourceTerritory) {
    warnings.push({code: 'MISSING_TERRITORY_IN_REUNION_SOURCE', row})
  }

  const firstName = field('prénom')
  const lastName = field('nom')
  if (!firstName || !lastName) {
    warnings.push({code: 'INCOMPLETE_IDENTITY', row})
  }

  if (!field('structure')) {
    throw new Error(`Structure absente à la ligne ${row}`)
  }

  return {row, email, firstName, lastName, structure: field('structure'), jobTitle: field('fonction'), status, role, isAdmin: false, permissions, startDate, endDate, sourceTerritory}
}

export function parseAccessRows(rows, {effectiveDate, permissionRows, source} = {}) {
  effectiveDate = date(effectiveDate, 'date effective obligatoire')
  if (!source || !/^[a-f\d]{64}$/u.test(source.sha256) || !text(source.name)) {
    throw new Error('Identité et empreinte SHA-256 de la source obligatoires')
  }

  const fields = fieldsFromRows(rows)
  if (fields.length === 0) {
    throw new Error('La source ne contient aucun accès')
  }

  const territories = new Set(fields.map(({field}) => normalized(field('territoire'))).filter(Boolean))
  if (territories.size !== 1 || !territories.has('la reunion')) {
    throw new Error('La source doit concerner exclusivement La Réunion')
  }

  const readPermissions = parseReadPermissions(permissionRows)
  const warnings = []
  const entries = fields.map(record => parseEntry(record, {effectiveDate, readPermissions, warnings}))
  const emails = new Set()
  const rowsSeen = new Set()
  const identities = new Map()
  for (const entry of entries) {
    if (emails.has(entry.email) || rowsSeen.has(entry.row)) {
      throw new Error(`Adresse email ou ligne source répétée à la ligne ${entry.row}`)
    }

    emails.add(entry.email)
    rowsSeen.add(entry.row)
    if (entry.firstName && entry.lastName) {
      const identity = JSON.stringify([normalized(entry.structure), normalized(entry.firstName), normalized(entry.lastName)])
      const firstRow = identities.get(identity)
      if (firstRow) {
        warnings.push({code: 'SHARED_NAME_DIFFERENT_EMAILS', rows: [firstRow, entry.row]})
      } else {
        identities.set(identity, entry.row)
      }
    }
  }

  const count = predicate => entries.filter(predicate).length
  const summary = {
    total: entries.length,
    open: count(entry => entry.status === 'OPEN'),
    remove: count(entry => entry.status === 'REMOVE'),
    closed: count(entry => entry.status === 'CLOSED'),
    agents: count(entry => entry.role === 'INSTRUCTOR'),
    readOnlyAgents: count(entry => entry.role === 'INSTRUCTOR' && entry.permissions.length === readPermissions.length),
    writeAgents: count(entry => entry.role === 'INSTRUCTOR' && entry.permissions.length === ZONE_PERMISSION_CODES.length),
    declarants: count(entry => entry.role === 'DECLARANT'),
    warnings
  }
  const permissionsHash = sha256(JSON.stringify({readPermissions, catalog: ZONE_PERMISSION_CATALOG.map(({code, requires}) => ({code, requires}))}))
  const result = {version: 1, source: {sha256: source.sha256, name: text(source.name)}, effectiveDate, territory: 'DEP-974', readPermissions, entries, summary, permissionsHash}
  return {...result, sourceHash: sha256(JSON.stringify(result))}
}

export async function loadAccessSource(filename, {effectiveDate} = {}) {
  let stdout
  try {
    ({stdout} = await runFile('python3', [extractor, filename], {maxBuffer: 8 * 1024 * 1024, timeout: 30000}))
  } catch {
    throw new Error('Extraction du classeur ODS impossible')
  }

  const workbook = JSON.parse(stdout)
  if (workbook.version !== 1) {
    throw new Error('Version d’extraction ODS incompatible')
  }

  return parseAccessRows(workbook.sheets.find(sheet => sheet.name === 'liste_brute')?.rows, {
    effectiveDate,
    permissionRows: workbook.sheets.find(sheet => sheet.name === permissionSheetName)?.rows,
    source: workbook.source
  })
}
