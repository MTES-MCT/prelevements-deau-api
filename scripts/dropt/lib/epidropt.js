import {createHash} from 'node:crypto'
import ExcelJS from 'exceljs'
import proj4 from 'proj4'
import {preserveManifestIdentities, proposePointMatches} from './reconciliation.js'

export const FORMAT_VERSION = 1
export const SCOPE = 'epidropt'
const LAMBERT93 = '+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs'
export const clean = value => String(value ?? '').replaceAll('\u00A0', ' ').trim()
export const normalized = value => clean(value).normalize('NFD').replaceAll(/[\u0300-\u036f]/g, '').toLowerCase().replaceAll(/\s+/g, ' ')
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
export function stableId(key) {
  const hash = createHash('sha256').update(`pe:epidropt:v1:${key}`).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

export function coordinates(x, y) {
  if (!clean(x) || !clean(y)) return null
  const a = Number(clean(x).replace(',', '.'))
  const b = Number(clean(y).replace(',', '.'))
  if (!Number.isFinite(a) || !Number.isFinite(b) || (a === 0 && b === 0)) return null
  const candidates = Math.abs(a) <= 180 && Math.abs(b) <= 90
    ? [[a, b], [b, a]]
    : [proj4(LAMBERT93, 'WGS84', [a, b])]
  return candidates.find(([lon, lat]) => lon >= -0.3 && lon <= 1.3 && lat >= 44.35 && lat <= 45) ?? null
}

export function emails(value) {
  return [...new Set(clean(value).split(/[;,\s]+/).map(email => email.toLowerCase()).filter(email => /^[^@\s]+@[^\s@][^\s.@]*\.[^\s@]+$/.test(email) && !/^(ex:|exemple|inconnu|nonrenseigne)/.test(email) && !email.endsWith('@email.fr')))].sort()
}

function cellValue(cell) {
  const value = cell.value
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === 'object') {
    if ('result' in value) return value.result ?? null
    if ('richText' in value) return value.richText.map(part => part.text).join('')
    if ('text' in value) return value.text
    throw new Error('Cellule non prise en charge : fournir une valeur explicite.')
  }

  return value ?? null
}

const headerKey = value => normalized(value).replaceAll('*', '').trim()
const pointHeaders = ['#', 'Nom du point', 'Type point', 'Coordonnée X - longitude (lambert93)',
  'Coordonnée Y - latitude (lambert93)', 'Date de mise en service du point', 'nature du point', 'type de milieu',
  'origine du prélèvement ou du rejet', 'type prélèvement / rejet', 'Zone de répartition des eaux (ZRE)',
  "Identifiant interne Agence de l'eau", 'Autres identifiants internes', "Point référent de l'ouvrage",
  'Autres noms (séparés par |)', 'Profondeur (m)', 'Réservoir biologique',
  "Nom de l'unité de gestion des volumes prélevables", 'Nom de la sous unité de gestion des volumes prélevables',
  'Code BSS', 'Code BNPE', 'Code AIOT', "Code EU Masse d'Eau", 'Code PTP', 'Numéro de série du compteur',
  'Code OPR', 'Code BDLISA', 'Code BDCarthage', 'Code BDTopage', 'plan_eau_connecté_cours_eau',
  'plan_eau_connecté_nappe', 'Code SISEAUX', 'Commentaire']

export function normalizePointWorkbookRow(values, headers) {
  const value = (label, required = false) => {
    const matches = headers.flatMap((header, column) => headerKey(header) === headerKey(label) ? [column] : [])
    if (matches.length > 1 || (required && matches.length !== 1)) throw new Error(`Colonne absente ou ambiguë : ${label}`)
    return matches.length ? values[matches[0]] ?? null : null
  }
  // Preserve the historical internal layout and its trailing empty columns,
  // while resolving every source column by its label (never a partial offset).
  const projected = Array(38).fill(null)
  pointHeaders.forEach((label, column) => { projected[column] = value(label, true) })
  return {
    values: projected,
    countingCode: nullable(value("Code comptage (code Agence de l'eau)")),
    reservoirNominalVolume: value('Volume nominal de la retenue'),
    waterBodyIdentifier: nullable(value('Identifiant plan eau'))
  }
}

export async function readWorkbook(filename, definitions) {
  const book = new ExcelJS.Workbook()
  await book.xlsx.readFile(filename)
  const result = {}
  for (const [name, {start, headers, layout}] of Object.entries(definitions)) {
    const sheet = book.getWorksheet(name)
    if (!sheet || sheet.rowCount > 10_000) throw new Error(`Feuille absente ou trop grande : ${name}`)
    for (const [column, expected] of Object.entries(headers)) {
      if (headerKey(cellValue(sheet.getRow(1).getCell(Number(column)))) !== headerKey(expected)) throw new Error(`Structure inattendue : ${name}, colonne ${column}`)
    }
    const labels = Array.from({length: sheet.columnCount}, (_, index) => cellValue(sheet.getRow(1).getCell(index + 1)))
    result[name] = []
    for (let rowNumber = start; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber)
      if (start === 3 && !clean(cellValue(row.getCell(2)))) continue
      const values = Array.from({length: sheet.columnCount}, (_, index) => cellValue(row.getCell(index + 1)))
      if (values.some(value => clean(value))) {
        const countingColumn = labels.findIndex(label => /^code comptage(?:\s|$)/.test(headerKey(label)))
        result[name].push({row: rowNumber, ...(layout === 'points'
          ? normalizePointWorkbookRow(values, labels)
          : {values, ...(name === 'Exploitations' && countingColumn !== -1 ? {countingCode: nullable(values[countingColumn])} : {})})})
      }
    }
  }

  return result
}

export const EPIDROPT_SHEETS = {
  'Points prélèvement': {start: 3, layout: 'points', headers: {2: 'Nom du point *'}},
  Préleveurs: {start: 3, headers: {3: 'Email *', 4: 'SIRET *'}},
  Exploitations: {start: 3, headers: {2: 'Point de prélèvement *', 3: 'Préleveur *', 4: 'Usage principal *'}}
}
export const RIVES_SHEETS = {
  Contrat: {start: 2, headers: {1: 'ID_Contrat', 2: 'NumClient'}},
  Compteur: {start: 2, headers: {1: 'NumeroCompteur'}},
  Lieu: {start: 2, headers: {1: 'NumeroLieuPrelevement', 2: 'CodeOU'}},
  Affectation: {start: 2, headers: {1: 'ID_Contrat', 2: 'NumeroLieuPrelevement', 3: 'NomPrelevement', 4: 'NumeroCompteur', 5: 'PctRepartitionCompteur'}}
}

function group(items, key) {
  const groups = new Map()
  for (const item of items) {
    const k = key(item)
    const list = groups.get(k) ?? []
    list.push(item)
    groups.set(k, list)
  }

  return groups
}

function referenceMap(rows, toRecord, sheet, conflictCode, issue) {
  const entries = new Map()
  const conflicts = new Set()
  const records = rows.map(({row, values}) => ({row, record: toRecord(values)}))
  for (const [id, candidates] of group(records, item => item.record.id)) {
    if (!id || new Set(candidates.map(item => digest(item.record))).size > 1) {
      conflicts.add(id)
      issue(conflictCode, {sheet, rows: candidates.map(item => item.row), id})
      continue
    }

    entries.set(id, candidates[0].record)
  }

  return {entries, conflicts}
}

const usageCodes = {irrigation: '2', domestique: '17', aep: '5', 'alimentation en eau potable': '5', aquaculture: '3B', industrie: '4'}
const waterBodyTypes = {'eau de surface': 'SUPERFICIELLE', 'eau souterraine': 'SOUTERRAIN'}
const nullable = value => clean(value) || null
const missingValues = new Set(['', 'non renseigne', 'non renseignee', 'non concerne', 'non concernee', 'sans objet', 'n/a', '#n/a', 'inconnu', '?', '-'])
const missing = value => missingValues.has(normalized(value))
const booleanValue = value => ({oui: true, non: false, true: true, false: false})[normalized(value)]
const identifierFields = [[11, 'waterAgencyInternalIdentifier'], [19, 'codeBSS'], [20, 'codeBNPE'], [21, 'codeAIOT'],
  [22, 'codeEUMasseDEau'], [23, 'codePTP'], [25, 'codeOPR'], [26, 'codeBDLISA'], [27, 'codeBDCarthage'],
  [28, 'codeBDTopage'], [31, 'codeSISEAUX']]
const booleanFields = [[10, 'isZre'], [13, 'isReferencePoint'], [16, 'isBiologicalReservoir'],
  [29, 'isWaterBodyConnectedToStream'], [30, 'isWaterBodyConnectedToGroundwater']]

function pointData(values, conflictedColumns, source, issue) {
  const data = {}
  const assign = (column, field, parse) => {
    if (conflictedColumns.has(column) || missing(values[column])) return
    const value = parse(values[column])
    if (value === undefined) issue('POINT_FIELD_INVALID', source, {field, column: column + 1})
    else data[field] = value
  }
  assign(8, 'nature', value => ({nappe: 'NAPPE', "cours d'eau": 'COURS_EAU', "plan d'eau": 'PLAN_EAU'})[normalized(value)])
  assign(9, 'withdrawalType', value => ({souterrain: 'SOUTERRAIN', superficiel: 'CONTINENTAL', continental: 'CONTINENTAL'})[normalized(value)])
  for (const [column, field] of identifierFields) {
    // A misplaced Oui/Non is not a hydrological identifier. Report it without
    // guessing which neighbouring column it was meant for or erasing live data.
    assign(column, field, value => booleanValue(value) === undefined ? clean(value) : undefined)
  }
  for (const [column, field] of booleanFields) assign(column, field, booleanValue)
  for (const [column, field] of [[17, 'managementUnit'], [18, 'managementSubUnit']]) assign(column, field, clean)
  return data
}

export function buildManifest({epidropt, rives, overrides = {}, inputs = {}, previousManifest, snapshot}) {
  const issues = []
  const reconciliation = []
  const issue = (code, source, details = {}) => issues.push({code, source, ...details})
  const points = new Map()
  const pointsByName = new Map()
  const declarants = new Map()
  const declarantsByEmail = new Map()
  const exploitations = new Map()
  const assignments = rives.Affectation.map(({row, values: v}) => ({row, contractId: clean(v[0]), lieuId: clean(v[1]), pointName: clean(v[2]), serial: clean(v[3]), percentage: clean(v[4])}))
  const byName = group(assignments, a => a.pointName)
  const {entries: lieux, conflicts: conflictingPlaces} = referenceMap(rives.Lieu,
    v => ({id: clean(v[0]), codeOU: clean(v[1]), label: clean(v[2]), coordinates: coordinates(v[3], v[4])}), 'Lieu', 'RIVES_PLACE_IDENTITY_CONFLICT', issue)
  const {entries: contracts} = referenceMap(rives.Contrat,
    v => ({id: clean(v[0]), clientId: clean(v[1]), name: clean(v[2]), subscribedVolume: v[3], subscribedFlow: v[4]}), 'Contrat', 'RIVES_CONTRACT_IDENTITY_CONFLICT', issue)
  const knownMeters = new Set(rives.Compteur.map(({values}) => clean(values[0])))
  const realPointRows = epidropt['Points prélèvement'].filter(({values}) =>
    !(normalized(values[1]) === 'forage 1' && values.every((value, column) => [0, 1].includes(column) || !clean(value))))

  for (const [name, rows] of group(realPointRows.filter(r => clean(r.values[1])), r => clean(r.values[1]))) {
    rows.sort((a, b) => digest(a.values).localeCompare(digest(b.values)))
    const override = overrides.points?.[name] ?? {}
    if (override.skip) continue
    const rowsSource = {sheet: 'Points prélèvement', rows: rows.map(r => r.row), name}
    if (!name || name === '?' || /^ex\s*:/i.test(name)) {
      issue('POINT_IDENTITY_MISSING', rowsSource)
      continue
    }

    const placeIds = [...new Set((byName.get(name) ?? []).map(a => a.lieuId))]
    const lieuId = override.lieuId ? String(override.lieuId) : (placeIds.length === 1 ? placeIds[0] : null)
    const place = lieuId ? lieux.get(lieuId) : null
    if (placeIds.length > 1 && !override.lieuId) {
      issue('POINT_MULTIPLE_RIVES_PLACES', rowsSource)
      continue
    }

    if (conflictingPlaces.has(lieuId)) {
      issue('POINT_RIVES_PLACE_CONFLICT', rowsSource)
      continue
    }

    const distinctCoordinates = [...new Map(rows.map(({values: v}) => coordinates(v[3], v[4])).filter(Boolean).map(c => [c.map(n => n.toFixed(5)).join(','), c])).values()]
    if (!place?.coordinates && distinctCoordinates.length > 1 && !override.coordinates) {
      issue('POINT_CONFLICTING_COORDINATES', rowsSource)
      continue
    }

    if (new Set(rows.map(({values}) => normalized(values[7])).filter(Boolean)).size > 1) {
      issue('POINT_RESOURCE_CONFLICT', rowsSource)
      continue
    }

    const v = [...rows[0].values]
    const conflictedColumns = new Set()
    // Complementary duplicates are resolved by evidence, not by the digest or
    // row order of an arbitrary first row. Conflicting values remain reported.
    for (let column = 0; column < v.length; column++) {
      const available = [...new Map(rows.filter(row => !missing(row.values[column]))
        .map(row => [normalized(row.values[column]), row.values[column]])).values()]
      if (missing(v[column]) && available.length === 1) v[column] = available[0]
      if (available.length > 1 && ![0, 3, 4, 24].includes(column)) {
        issue('POINT_FIELD_CONFLICT', rowsSource, {column: column + 1})
        conflictedColumns.add(column)
        v[column] = null
      }
    }
    const geometry = override.coordinates === undefined
      ? place?.coordinates ?? distinctCoordinates[0] ?? null
      : Array.isArray(override.coordinates) && override.coordinates.length === 2 ? coordinates(...override.coordinates) : null
    const waterBodyType = waterBodyTypes[normalized(v[7])]
    if (!geometry || !coordinates(...geometry) || !waterBodyType) {
      issue('POINT_LOCATION_OR_RESOURCE_UNRESOLVED', rowsSource)
      continue
    }

    const key = override.key ?? (lieuId ? `rives:lieu:${lieuId}` : `epidropt:point:${name}`)
    const point = points.get(key) ?? {
      key, id: override.id ?? stableId(key), names: [], references: [], coordinates: geometry, countingCodes: [],
      data: {name, flowType: 'PRELEVEMENT', waterBodyType, pointKind: 'PHYSIQUE',
        ...pointData(v, conflictedColumns, rowsSource, issue), locationDescription: place?.label || null},
      sourceId: `dropt-epidropt:point:${digest(key).slice(0, 32)}`, source: []
    }
    if (point.data.waterBodyType !== waterBodyType) {
      issue('POINT_RESOURCE_CONFLICT', rowsSource)
      continue
    }

    point.names.push(name)
    point.names.sort()
    point.data.name = point.names[0]
    point.data.otherNames = point.names.slice(1).join(' | ') || null
    point.references.push({provider: 'epidropt', externalId: name})
    if (lieuId && !point.references.some(ref => ref.provider === 'rives-et-eaux')) point.references.push({provider: 'rives-et-eaux', externalId: lieuId})
    point.source.push(rowsSource)
    for (const [column, field] of [[8, 'nature'], [9, 'withdrawalType'], [17, 'managementUnit'], [18, 'managementSubUnit'],
      ...identifierFields, ...booleanFields]) {
      if (conflictedColumns.has(column)) delete point.data[field]
    }
    point.countingCodes = [...new Set([...point.countingCodes, ...rows.map(row => row.countingCode).filter(Boolean)])].sort()
    for (const field of ['reservoirNominalVolume', 'waterBodyIdentifier']) {
      const distinct = [...new Set(rows.map(row => row[field]).filter(value => !missing(value)))]
      if (distinct.length === 1) {
        const value = field === 'reservoirNominalVolume' ? Number(clean(distinct[0]).replace(',', '.')) : clean(distinct[0])
        if (field === 'reservoirNominalVolume' ? (Number.isFinite(value) && value >= 0) : booleanValue(value) === undefined) point.data[field] = value
        else issue('POINT_FIELD_INVALID', rowsSource, {field})
      } else if (distinct.length > 1) issue('POINT_FIELD_CONFLICT', rowsSource, {field})
    }
    points.set(key, point)
    pointsByName.set(name, point)
  }

  reconciliation.push(...proposePointMatches({points: [...points.values()], pointRows: realPointRows, lieux: [...lieux.values()], assignments, snapshot}))

  const candidates = []
  for (const {row, values: v} of epidropt.Préleveurs) {
    if (!clean(v[1])) continue
    const fullName = normalized(v[4] || [v[6], v[7]].filter(Boolean).join(' '))
    const siret = clean(v[3]).replaceAll(/\s/g, '')
    const agencyId = clean(v[9])
    const override = overrides.declarants?.[agencyId || siret || digest([fullName, v[10], v[13], v[14]])] ?? {}
    const key = override.key ?? (agencyId ? `epidropt:preleveur:aeag:${agencyId}` : /^\d{14}$/.test(siret) ? `epidropt:preleveur:siret:${siret}` : null)
    if (override.skip) continue
    if (!key || !fullName) {
      issue('PRELEVEUR_IDENTITY_MISSING', {sheet: 'Préleveurs', row})
      continue
    }

    const references = agencyId ? [{provider: 'epidropt', externalId: agencyId}]
      : /^\d{14}$/.test(siret) ? [{provider: 'epidropt', externalId: `siret:${siret}`}] : []
    candidates.push({key, row, fullName, id: override.id ?? stableId(key), emails: emails(v[2]), references,
      user: {role: 'DECLARANT', firstName: nullable(v[6]), lastName: nullable(v[7]), email: null},
      data: {declarantRole: 'PRELEVEUR', declarantType: clean(v[4]) || /^\d{14}$/.test(siret) ? 'LEGAL_PERSON' : 'NATURAL_PERSON', socialReason: nullable(v[4]), siret: /^\d{14}$/.test(siret) ? siret : null,
        preleveurType: normalized(v[1]) === 'irrigant' ? 'IRRIGANT' : 'AUTRE', addressLine1: nullable(v[10]), addressLine2: nullable(v[11]), poBox: nullable(v[12]), postalCode: nullable(v[13]), city: nullable(v[14]), phoneNumber: nullable(v[8]), declarationNotificationsEnabled: false}})
  }

  for (const [key, rows] of group(candidates, r => r.key)) {
    rows.sort((a, b) => digest({...a, row: null}).localeCompare(digest({...b, row: null})))
    if (new Set(rows.map(r => r.fullName)).size > 1 || new Set(rows.map(r => r.data.siret).filter(Boolean)).size > 1) {
      issue('PRELEVEUR_IDENTITY_CONFLICT', {sheet: 'Préleveurs', rows: rows.map(r => r.row)}, {key})
      continue
    }

    const first = rows[0]
    const references = [...new Map(rows.flatMap(r => r.references).map(ref => [`${ref.provider}:${ref.externalId}`, ref])).values()]
    const person = {...first, references, sourceId: `dropt-epidropt:preleveur:${digest(key).slice(0, 32)}`, emails: [...new Set(rows.flatMap(r => r.emails))].sort()}
    declarants.set(key, person)
    for (const email of person.emails) {
      const set = declarantsByEmail.get(email) ?? new Set()
      set.add(key)
      declarantsByEmail.set(email, set)
    }
  }

  const declarantsBySiret = group([...declarants.values()].filter(owner => owner.data.siret), owner => owner.data.siret)
  const storedDeclarants = snapshot?.tables?.declarants ?? []
  const storedBySiret = group(storedDeclarants.filter(owner => owner.siret), owner => owner.siret)
  const storedOwnerIds = new Set(storedDeclarants.filter(owner => !owner.deletedAt).map(owner => owner.userId))
  const resolvedRows = []

  const exploitationRowsByName = new Map()
  for (const {row, values: v, countingCode: rowCountingCode} of epidropt.Exploitations) {
    if (!clean(v[1])) continue
    const source = {sheet: 'Exploitations', row}
    const point = pointsByName.get(clean(v[1]))
    const owners = new Set(emails(v[2]).flatMap(email => [...(declarantsByEmail.get(email) ?? [])]))
    const siret = clean(v[2]).replaceAll(/\s/g, '')
    if (/^\d{14}$/.test(siret)) for (const owner of declarantsBySiret.get(siret) ?? []) owners.add(owner.key)
    const override = overrides.exploitations?.[digest(v)] ?? {}
    let ownerKey = override.declarantKey ?? (owners.size === 1 ? [...owners][0] : null)
    if (!ownerKey) {
      const contractNames = new Set((byName.get(clean(v[1])) ?? []).map(a => normalized(contracts.get(a.contractId)?.name)).filter(Boolean))
      const options = [...declarants.values()].filter(owner => contractNames.has(owner.fullName) && (!owners.size || owners.has(owner.key)))
      const candidate = options.length === 1 ? options[0] : null
      const sameSiret = candidate?.data.siret ? (storedBySiret.get(candidate.data.siret) ?? []) : []
      const sourceSiret = candidate?.data.siret ? (declarantsBySiret.get(candidate.data.siret) ?? []) : []
      const identityConflict = candidate && (sourceSiret.some(owner => owner.fullName !== candidate.fullName)
        || sameSiret.some(owner => owner.userId !== candidate.id))
      const accepted = candidate && owners.size > 1 && storedOwnerIds.has(candidate.id) && !identityConflict
      if (candidate) reconciliation.push({kind: 'DECLARANT', source, pointName: clean(v[1]), candidateId: candidate.id,
        method: owners.size ? 'EMAIL_INTERSECTION_EXACT_CONTRACT_NAME' : 'EXACT_CONTRACT_NAME_ONLY',
        status: accepted ? 'ACCEPTED' : 'REVIEW', reason: identityConflict ? 'SIRET_IDENTITY_CONFLICT' : !storedOwnerIds.has(candidate.id) ? 'IDENTITY_NOT_IN_SNAPSHOT' : owners.size ? null : 'NAME_ONLY'})
      if (accepted) ownerKey = candidate.key
    }
    const owner = declarants.get(ownerKey)
    const usageCode = usageCodes[normalized(v[3])]
    if (override.skip) continue
    resolvedRows.push({pointId: point?.id, pointName: clean(v[1]), ownerId: owner?.id ?? null, source})
    if (!point || !owner || !usageCode) {
      issue('EXPLOITATION_UNRESOLVED', source, {pointName: clean(v[1]), reason: !point ? 'POINT' : !owner ? 'PRELEVEUR' : 'USAGE'})
      continue
    }

    if (clean(v[4]) || clean(v[5])) {
      issue('EXPLOITATION_PERIOD_REQUIRES_MAPPING', source)
      continue
    }

    const countingCode = nullable(override.countingCode ?? rowCountingCode)
    const key = `exploitation:${point.key}:${owner.key}${countingCode ? `:counting:${countingCode}` : ''}`
    const previous = exploitations.get(key)
    if (previous && previous.usageCode !== usageCode) {
      previous.blocked = true
      issue('EXPLOITATION_USAGE_CONFLICT', source)
      continue
    }

    const exploitation = previous ?? {key, id: override.id ?? stableId(key), sourceId: `dropt-epidropt:exploitation:${digest(key).slice(0, 32)}`, pointId: point.id, declarantId: owner.id, countingCode, usageCode, aliases: [], source: []}
    exploitation.aliases = [...new Set([...exploitation.aliases, clean(v[1])])].sort()
    exploitation.source.push(source)
    exploitations.set(key, exploitation)
    const groupForName = exploitationRowsByName.get(clean(v[1])) ?? new Set()
    groupForName.add(key)
    exploitationRowsByName.set(clean(v[1]), groupForName)
  }

  for (const exploitation of exploitations.values()) {
    if (exploitation.countingCode) continue
    const point = [...points.values()].find(point => point.id === exploitation.pointId)
    const rows = resolvedRows.filter(row => row.pointId === exploitation.pointId)
    const owners = new Set(rows.map(row => row.ownerId))
    if (point.countingCodes.length === 1 && owners.size === 1 && owners.has(exploitation.declarantId)) {
      exploitation.countingCode = point.countingCodes[0]
      reconciliation.push({kind: 'COUNTING_CODE', exploitationId: exploitation.id, countingCode: exploitation.countingCode,
        status: 'ACCEPTED', method: 'UNIQUE_CODE_UNIQUE_SOURCE_OWNER', sources: rows.map(row => row.source)})
    } else if (point.countingCodes.length) {
      reconciliation.push({kind: 'COUNTING_CODE', exploitationId: exploitation.id, candidates: point.countingCodes,
        status: 'REVIEW', reason: point.countingCodes.length > 1 ? 'MULTIPLE_CODES' : 'MULTIPLE_OR_UNRESOLVED_OWNERS'})
    }
  }

  const clients = new Map()
  const clientIdentityConflicts = new Set()
  const declarantsById = new Map([...declarants.values()].map(person => [person.id, person]))
  for (const assignment of assignments) {
    const contract = contracts.get(assignment.contractId)
    const destinations = [...(exploitationRowsByName.get(assignment.pointName) ?? [])].map(key => exploitations.get(key)).filter(e => !e.blocked)
    if (contract?.clientId && destinations.length === 1) {
      const owner = declarantsById.get(destinations[0].declarantId)
      const owners = clients.get(contract.clientId) ?? new Set()
      if (owner.fullName === normalized(contract.name)) owners.add(owner.id)
      else clientIdentityConflicts.add(contract.clientId)
      clients.set(contract.clientId, owners)
    }
  }

  for (const clientId of new Set([...clients.keys(), ...Object.keys(overrides.rivesClients ?? {})])) {
    const override = overrides.rivesClients?.[clientId]
    if (override) {
      const owner = declarants.get(override.declarantKey)
      clients.set(clientId, new Set(owner ? [owner.id] : []))
      if (!owner) issue('RIVES_CLIENT_OVERRIDE_UNRESOLVED', {clientId})
    } else if (clientIdentityConflicts.has(clientId)) {
      clients.set(clientId, new Set())
      issue('RIVES_CLIENT_IDENTITY_UNRESOLVED', {clientId})
    }
  }

  const meters = []
  const allocations = []
  for (const [serial, rows] of group(assignments, a => a.serial)) {
    if (!serial) {
      issue('METER_SERIAL_MISSING', {rows: rows.map(a => a.row)})
      continue
    }
    const snapshot = []
    const resolved = []
    let valid = knownMeters.has(serial)
    if (!valid) issue('METER_MISSING_REFERENTIAL', {serial})
    for (const assignment of rows) {
      const contract = contracts.get(assignment.contractId)
      const ownerIds = clients.get(contract?.clientId) ?? new Set()
      const point = [...points.values()].find(p => p.key === `rives:lieu:${assignment.lieuId}` || p.references.some(ref => ref.provider === 'rives-et-eaux' && ref.externalId === assignment.lieuId))
      const ownerId = ownerIds.size === 1 ? [...ownerIds][0] : null
      const destinations = [...exploitations.values()].filter(e => !e.blocked && e.pointId === point?.id && e.declarantId === ownerId)
      const inScope = Boolean(point)
      const key = `dropt-rives:allocation:${digest([serial, assignment.contractId, assignment.lieuId]).slice(0, 32)}`
      snapshot.push({key, contractId: assignment.contractId, lieuId: assignment.lieuId, percentage: assignment.percentage, inScope})
      if (!contract?.clientId || !/^\d+(\.\d{1,4})?$/.test(assignment.percentage) || Number(assignment.percentage) > 100 || (inScope && destinations.length !== 1)) valid = false
      if (inScope && destinations.length === 1) resolved.push({sourceId: key, exploitationId: destinations[0].id, contractId: assignment.contractId, lieuId: assignment.lieuId, percentage: assignment.percentage})
    }

    if (!snapshot.some(a => a.inScope)) continue
    if (snapshot.reduce((sum, a) => sum + Math.round(Number(a.percentage) * 10_000), 0) !== 1_000_000 || new Set(snapshot.map(a => a.key)).size !== snapshot.length) valid = false
    if (!valid) issue('METER_ALLOCATION_UNRESOLVED', {serial}, {rows: rows.map(a => a.row)})
    const compteurId = stableId(`rives:meter:${serial}`)
    meters.push({id: compteurId, provider: 'rives-et-eaux', serial, scope: SCOPE, allocationSnapshot: snapshot.sort((a, b) => a.key.localeCompare(b.key)), allocationSnapshotValidated: valid, references: [{provider: 'rives-et-eaux', externalId: serial}]})
    allocations.push(...resolved.map(a => ({...a, compteurId, validated: valid, additive: overrides.additiveMeters?.includes(serial) === true})))
  }

  const rivesSerials = new Set(assignments.map(a => a.serial))
  const ordinaryMeters = new Map()
  for (const {row, values: v, countingCode} of epidropt['Points prélèvement']) {
    const point = pointsByName.get(clean(v[1]))
    if (!point || !clean(v[24])) continue
    for (const serial of clean(v[24]).split(';').map(clean).filter(Boolean)) {
      if (rivesSerials.has(serial)) {
        const meter = meters.find(item => item.serial === serial)
        const pointExploitationIds = new Set([...exploitations.values()].filter(e => !e.blocked && e.pointId === point.id).map(e => e.id))
        if (!meter || !allocations.some(a => a.compteurId === meter.id && pointExploitationIds.has(a.exploitationId))) {
          issue('EPIDROPT_METER_RIVES_LINK_UNRESOLVED', {sheet: 'Points prélèvement', row, serial})
        }

        continue
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9/_-]{1,70}$/.test(serial) || /^(0+|inconnu|aucun|neant|sans)$/i.test(serial)) {
        issue('EPIDROPT_METER_SERIAL_AMBIGUOUS', {sheet: 'Points prélèvement', row})
        continue
      }

      const compteurId = stableId(`epidropt:meter:${serial}`)
      ordinaryMeters.set(serial, {id: compteurId, provider: 'epidropt', serial, references: [{provider: 'epidropt', externalId: serial}]})
      const destinations = [...exploitations.values()].filter(e => !e.blocked && e.pointId === point.id
        && (!nullable(countingCode) || e.countingCode === nullable(countingCode)))
      if (destinations.length !== 1) {
        issue('EPIDROPT_METER_EXPLOITATION_UNRESOLVED', {sheet: 'Points prélèvement', row, serial})
        continue
      }
      for (const destination of destinations) {
        const sourceId = `dropt-epidropt:allocation:${digest([serial, destination.id]).slice(0, 32)}`
        if (!allocations.some(a => a.sourceId === sourceId)) allocations.push({sourceId, provider: 'epidropt', compteurId, exploitationId: destination.id, contractId: null, lieuId: null, percentage: null, validated: false, additive: false})
      }
    }
  }

  meters.push(...ordinaryMeters.values())

  for (const [clientId, owners] of clients) {
    if (owners.size !== 1) {
      if (owners.size > 1) issue('RIVES_CLIENT_MULTIPLE_PRELEVEURS', {clientId})
      continue
    }

    const person = [...declarants.values()].find(d => d.id === [...owners][0])
    person.references.push({provider: 'rives-et-eaux', externalId: clientId})
  }

  const manifest = {formatVersion: FORMAT_VERSION, scope: SCOPE, inputs, overridesHash: digest(overrides),
    points: [...points.values()].sort((a, b) => a.key.localeCompare(b.key)), declarants: [...declarants.values()].sort((a, b) => a.key.localeCompare(b.key)),
    exploitations: [...exploitations.values()].filter(e => !e.blocked).sort((a, b) => a.key.localeCompare(b.key)), meters: meters.sort((a, b) => a.serial.localeCompare(b.serial)), allocations: allocations.sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    contracts: [...contracts.values()], issues, reconciliation}
  const anchored = preserveManifestIdentities(manifest, {previousManifest, snapshot})
  return {...anchored, manifestHash: digest(anchored)}
}
