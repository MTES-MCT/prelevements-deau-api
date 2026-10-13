import {createHash} from 'node:crypto'
import {readFile, stat} from 'node:fs/promises'
import {basename} from 'node:path'
import ExcelJS from 'exceljs'
import proj4 from 'proj4'

const LAMBERT93 = '+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs'
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_ROWS = 10000
const SHA256 = /^[a-f\d]{64}$/
const clean = value => String(value ?? '').replaceAll(/[\u00A0\u202F]/g, ' ').trim()
const normalized = value => clean(value).normalize('NFD').replaceAll(/[\u0300-\u036f]/g, '').toLowerCase().replaceAll(/\s+/g, ' ')
const nullable = value => clean(value) || null
const unique = values => [...new Set(values)]

function fail(code) {
  throw Object.assign(new Error(code), {code})
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')

function identity(kind, key) {
  const hash = digest(`pe:dropt-aep:v1:${kind}:${key}`)
  return {
    id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
    sourceId: `dropt-aep:${kind}:${digest(key).slice(0, 32)}`
  }
}

// Match headers rather than relying on their position. The source's WGS84 label
// is erroneous: an explicit EPSG:2154 decision is required before projection.
const POINT_COLUMNS = {
  name: 'Nom du point *', x: 'Coordonnée X - longitude (WGS84) *', y: 'Coordonnée Y - latitude (WGS84) *',
  waterBodyType: 'Type de milieu *', nature: 'nature_prelevement_ou_rejet', siseaux: 'Code SISEAUX',
  aeag: 'Identifiant interne AEAG', ddt: 'identifiant interne DDT', depth: 'Profondeur (m)',
  isZre: 'Zone de répartition des eaux', isBiologicalReservoir: 'Réservoir biologique',
  managementUnit: "Nom de l'unité de gestion", managementCode: 'Code entité de gestion',
  managementSubUnit: 'Nom de la sous unité gestion', resourceName: "Nom de la masse d'eau",
  locationDescription: 'Description du lieu', codeBSS: 'Code BSS AEAG', codeBSSSage: 'Code BSS SAGE',
  codeBNPE: 'Code BNPE', codeAIOT: 'Code AIOT', codeEUMasseDEau: "Code EU Masse d'Eau", codePTP: 'Code PTP',
  codeOPR: 'Code OPR', codeBDLISA: 'Code BDLISA', aquiferName: 'libelle entité hydrogeol',
  codeBDCarthage: 'Code BDCarthage', codeBDTopage: 'Code BDTopage', comment: 'Commentaire'
}
const DECLARANT_COLUMNS = {
  type: 'Type de préleveur *', email: 'Email *', organization: 'Syndicat des eaux', delegate: 'Délégataire',
  sispea: 'Code SYSPEA', socialReason: 'Raison sociale', siret: 'SIRET', phoneNumber: 'Téléphone',
  addressLine1: 'Adresse', addressLine2: "Complément d'adresse", poBox: 'Boîte postale', postalCode: 'Code postal', city: 'Ville'
}
const EXPLOITATION_COLUMNS = {
  pointName: 'Point de prélèvement *', email: 'Préleveur *', usage: 'Usage principal *',
  startDate: 'Date de début', endDate: 'Date de fin', secondaryUsage1: 'Usage complémentaire 1',
  secondaryUsage2: 'Usage complémentaire 2', comment: 'Commentaire'
}

function cellValue(cell) {
  const value = cell.value
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  // Identity, dates and coordinates must be explicit, not cached formulas.
  if ('formula' in value || 'sharedFormula' in value || 'error' in value) fail('AEP_UNSUPPORTED_CELL')
  if (value.richText) return value.richText.map(part => part.text).join('')
  if ('text' in value) return value.text
  fail('AEP_UNSUPPORTED_CELL')
}

function sheetRows(workbook, name, columns, presenceField) {
  const sheet = workbook.getWorksheet(name)
  if (!sheet || sheet.rowCount > MAX_ROWS) fail('AEP_WORKSHEET_INVALID')
  const headers = new Map()
  sheet.getRow(1).eachCell(cell => {
    const label = normalized(cellValue(cell))
    if (headers.has(label)) fail('AEP_DUPLICATE_HEADER')
    headers.set(label, cell.col)
  })
  const indexes = Object.fromEntries(Object.entries(columns).map(([field, label]) => {
    const column = headers.get(normalized(label))
    if (!column) fail('AEP_REQUIRED_HEADER_MISSING')
    return [field, column]
  }))
  const rows = []
  // Row 2 is the workbook's example; the formula-only numbering column is ignored.
  for (let row = 3; row <= sheet.rowCount; row++) {
    const values = Object.fromEntries(Object.entries(indexes).map(([field, column]) => [field, cellValue(sheet.getCell(row, column))]))
    if (!Object.values(values).some(value => clean(value))) continue
    if (!clean(values[presenceField])) fail('AEP_REQUIRED_CELL_MISSING')
    rows.push({row, ...values})
  }
  return rows
}

function workbookRows(workbook, legacy = false) {
  if (!workbook || typeof workbook !== 'object') fail('AEP_WORKBOOK_INVALID')
  if (typeof workbook.getWorksheet === 'function') {
    return legacy ? {
      points: sheetRows(workbook, 'Points prélèvement', {name: 'Nom du point *', codeBSS: 'Code BSS'}, 'name'),
      exploitations: sheetRows(workbook, 'Exploitations', EXPLOITATION_COLUMNS, 'pointName')
    } : {
      points: sheetRows(workbook, 'Points prélèvement', POINT_COLUMNS, 'name'),
      declarants: sheetRows(workbook, 'Préleveurs', DECLARANT_COLUMNS, 'type'),
      exploitations: sheetRows(workbook, 'Exploitations', EXPLOITATION_COLUMNS, 'pointName')
    }
  }
  for (const field of legacy ? ['points', 'exploitations'] : ['points', 'declarants', 'exploitations']) {
    if (!Array.isArray(workbook[field]) || workbook[field].length > MAX_ROWS
      || workbook[field].some(row => !Number.isSafeInteger(row.row) || row.row < 3)) fail('AEP_ROWS_INVALID')
  }
  return workbook
}

function validateDecisions(decisions) {
  if (!decisions || decisions.version !== 1 || decisions.coordinateSystem !== 'EPSG:2154') fail('AEP_DECISIONS_INVALID')
  const allowed = ['version', 'coordinateSystem', 'additionalOperators', 'pointOverrides', 'heldExploitationPointNames', 'activePointKeys', 'retirementPointNames', 'expectedCounts']
  if (Object.keys(decisions).some(key => !allowed.includes(key))) fail('AEP_DECISION_UNKNOWN')
  for (const field of ['additionalOperators', 'heldExploitationPointNames', 'activePointKeys', 'retirementPointNames']) {
    if (!Array.isArray(decisions[field])) fail('AEP_DECISIONS_INVALID')
  }
  for (const field of ['heldExploitationPointNames', 'activePointKeys', 'retirementPointNames']) {
    if (decisions[field].some(value => typeof value !== 'string' || !clean(value))
      || unique(decisions[field].map(normalized)).length !== decisions[field].length) fail('AEP_DECISIONS_INVALID')
  }
  if (!decisions.pointOverrides || typeof decisions.pointOverrides !== 'object' || Array.isArray(decisions.pointOverrides)) fail('AEP_DECISIONS_INVALID')
  validateDecisionEntries(decisions)
}

function validateDecisionEntries(decisions) {
  for (const override of Object.values(decisions.pointOverrides)) {
    // Only the reviewed clearing of a contradictory BSS is supported.
    if (!override || override.codeBSS !== null || !clean(override.reason)
      || Object.keys(override).some(key => !['codeBSS', 'reason'].includes(key))) fail('AEP_POINT_OVERRIDE_INVALID')
  }
  for (const operator of decisions.additionalOperators) {
    if (!operator || !clean(operator.pointKey) || !/^\d{14}$/.test(operator.declarantSiret) || !clean(operator.reason)
      || Object.keys(operator).some(key => !['pointKey', 'declarantSiret', 'reason'].includes(key))) fail('AEP_OPERATOR_DECISION_INVALID')
  }
}

function validSiret(value) {
  if (!/^\d{14}$/.test(value)) return false
  return [...value].reduce((sum, digit, index) => {
    const n = Number(digit) * (index % 2 === 0 ? 2 : 1)
    return sum + (n > 9 ? n - 9 : n)
  }, 0) % 10 === 0
}

function numberValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const text = String(value ?? '').trim()
  if (!/^[+-]?(?:\d+|\d{1,3}(?:[ \u00A0\u202F]\d{3})+)(?:[.,]\d+)?$/.test(text)) return null
  const result = Number(text.replaceAll(/[ \u00A0\u202F]/g, '').replace(',', '.'))
  return Number.isFinite(result) ? result : null
}

function projectCoordinates(row) {
  const x = numberValue(row.x)
  const y = numberValue(row.y)
  if (x === null || y === null || x < 0 || x > 1300000 || y < 6000000 || y > 7200000) fail('AEP_COORDINATES_INVALID')
  const [lon, lat] = proj4(LAMBERT93, 'EPSG:4326', [x, y])
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -0.3 || lon > 1.3 || lat < 44.35 || lat > 45) fail('AEP_COORDINATES_OUTSIDE_DROPT')
  return [Number(lon.toFixed(8)), Number(lat.toFixed(8))]
}

function booleanValue(value) {
  if (!clean(value)) return null
  if (['oui', 'true', '1'].includes(normalized(value))) return true
  if (['non', 'false', '0'].includes(normalized(value))) return false
  fail('AEP_BOOLEAN_INVALID')
}

function addDeclarants(rows) {
  const declarants = []
  const sirets = new Set()
  const emails = new Set()
  for (const row of rows) {
    const siret = clean(row.siret).replaceAll(' ', '')
    const email = clean(row.email).toLowerCase()
    if (!validSiret(siret) || !clean(row.socialReason) || normalized(row.type) !== 'syndicat aep') fail('AEP_DECLARANT_IDENTITY_INVALID')
    if (!/^[^\s@;,]+@[^\s@;,.]+(?:\.[^\s@;,.]+)+$/.test(email)) fail('AEP_EMAIL_INVALID')
    if (sirets.has(siret) || emails.has(email)) fail('AEP_DECLARANT_DUPLICATE')
    sirets.add(siret)
    emails.add(email)
    const key = `siret:${siret}`
    declarants.push({key, ...identity('preleveur', key), email,
      references: [{provider: 'dropt-aep', scope: 'dropt-aep', kind: 'DECLARANT', externalId: key}],
      source: {sheet: 'Préleveurs', row: row.row},
      data: {declarantRole: 'PRELEVEUR', declarantType: 'LEGAL_PERSON', preleveurType: 'GESTIONNAIRE_AEP',
        siret, socialReason: clean(row.socialReason), addressLine1: nullable(row.addressLine1), addressLine2: nullable(row.addressLine2),
        poBox: nullable(row.poBox), postalCode: nullable(row.postalCode), city: nullable(row.city), phoneNumber: nullable(row.phoneNumber),
        quickDeclarationEnabled: true}})
  }
  return declarants
}

function pointIdentity(row, issues) {
  const rawSiseaux = clean(row.siseaux)
  const tokens = rawSiseaux.split(/[,;]/).map(clean).filter(Boolean)
  const codes = unique(tokens.filter(token => /^\d{8}$/.test(token)))
  if (codes.length > 1 || (rawSiseaux && codes.length !== 1)) fail('AEP_SISEAUX_INVALID')
  if (tokens.length > 1) issues.push({code: 'AEP_SISEAUX_MIXED_VALUE', sheet: 'Points prélèvement', row: row.row, rawValue: rawSiseaux})
  const aeag = clean(row.aeag).toUpperCase()
  if (aeag && !/^C[A-Z\d]+$/.test(aeag)) fail('AEP_AEAG_INVALID')
  if (!aeag && !codes[0]) fail('AEP_POINT_IDENTITY_MISSING')
  return {key: aeag ? `aeag:${aeag}` : `siseaux:${codes[0]}`, aeag, siseaux: codes[0] ?? null}
}

function pointData(row, key, decisions, issues) {
  if (normalized(row.waterBodyType) !== 'eaux souterraines') fail('AEP_WATER_BODY_TYPE_INVALID')
  const nature = {nappe: 'NAPPE', source: 'SOURCE'}[normalized(row.nature)]
  if (!nature) fail('AEP_NATURE_INVALID')
  const data = {name: clean(row.name), waterBodyType: 'SOUTERRAIN', flowType: 'PRELEVEMENT', pointKind: 'PHYSIQUE', collectionMode: 'MANUAL', nature,
    depth: clean(row.depth) ? numberValue(row.depth) : null, isZre: booleanValue(row.isZre), isBiologicalReservoir: booleanValue(row.isBiologicalReservoir)}
  if (!data.name || (clean(row.depth) && (data.depth === null || data.depth < 0))) fail('AEP_POINT_DATA_INVALID')
  const textFields = ['managementUnit', 'managementSubUnit', 'resourceName', 'locationDescription', 'aquiferName',
    'codeBSS', 'codeBNPE', 'codeAIOT', 'codeEUMasseDEau', 'codePTP', 'codeOPR', 'codeBDLISA', 'codeBDCarthage', 'codeBDTopage', 'comment']
  for (const field of textFields) data[field] = nullable(row[field])
  if (data.codeBSS && !/^BSS[A-Z\d]+$/.test(data.codeBSS)) fail('AEP_BSS_INVALID')
  if (decisions.pointOverrides[key]) {
    if (!data.codeBSS) fail('AEP_UNUSED_POINT_OVERRIDE')
    issues.push({code: 'AEP_BSS_CLEARED_BY_DECISION', pointKey: key, row: row.row, previousValue: data.codeBSS, reason: decisions.pointOverrides[key].reason})
    data.codeBSS = null
  }
  if (/abandon|ferm|inactif/.test(normalized(row.comment)) && !decisions.activePointKeys.includes(key)) fail('AEP_POINT_ACTIVITY_DECISION_REQUIRED')
  if (decisions.activePointKeys.includes(key)) issues.push({code: 'AEP_ACTIVE_POINT_CONFIRMED', pointKey: key, row: row.row})
  return data
}

function addPoints(rows, decisions, issues) {
  const points = []
  const keys = new Set()
  const names = new Set()
  for (const row of rows) {
    const {key, aeag, siseaux} = pointIdentity(row, issues)
    const name = normalized(row.name)
    if (keys.has(key) || names.has(name)) fail('AEP_POINT_DUPLICATE')
    keys.add(key)
    names.add(name)
    points.push({key, ...identity('point', key), coordinates: projectCoordinates(row),
      references: [{provider: 'dropt-aep', scope: 'dropt-aep', kind: 'POINT', externalId: key}],
      source: {sheet: 'Points prélèvement', row: row.row, rawIdentifiers: {siseaux: nullable(row.siseaux), codeBSSSage: nullable(row.codeBSSSage), ddt: nullable(row.ddt), managementCode: nullable(row.managementCode)}},
      data: {...pointData(row, key, decisions, issues), codeSISEAUX: siseaux, waterAgencyInternalIdentifier: aeag || null}})
  }
  if ([...Object.keys(decisions.pointOverrides), ...decisions.activePointKeys].some(key => !keys.has(key))) fail('AEP_POINT_DECISION_NOT_FOUND')
  const bss = points.map(point => point.data.codeBSS).filter(Boolean)
  if (unique(bss).length !== bss.length) fail('AEP_BSS_CONFLICT')
  for (const field of ['coordinates', 'codeOPR']) {
    const groups = new Map()
    for (const point of points) {
      const value = field === 'coordinates' ? JSON.stringify(point.coordinates) : point.data.codeOPR
      if (!value) continue
      groups.set(value, [...(groups.get(value) ?? []), point.key])
    }
    for (const pointKeys of groups.values()) {
      if (pointKeys.length > 1) issues.push({code: field === 'coordinates' ? 'AEP_SHARED_COORDINATES' : 'AEP_SHARED_OPR', pointKeys: pointKeys.sort()})
    }
  }
  return points
}

function isAepUsage(value) {
  return ['aep', 'alimentation en eau potable (aep)'].includes(normalized(value))
}

function addExploitations(rows, points, declarants, decisions, issues) {
  const byName = new Map(points.map(point => [normalized(point.data.name), point]))
  const byEmail = new Map(declarants.map(owner => [owner.email, owner]))
  const held = new Set(decisions.heldExploitationPointNames.map(normalized))
  const seenHolds = new Set()
  const result = new Map()
  function add(point, owner, source) {
    const key = `${point.key}|${owner.key}|5`
    if (result.has(key)) fail('AEP_EXPLOITATION_DUPLICATE')
    result.set(key, {key, ...identity('exploitation', key), pointId: point.id, declarantId: owner.id, usageCode: '5', source,
      data: {status: 'EN_ACTIVITE', excludeFromQuickDeclaration: false, startDate: null, endDate: null}})
  }
  for (const row of rows) {
    if (!isAepUsage(row.usage) || [row.startDate, row.endDate, row.secondaryUsage1, row.secondaryUsage2].some(value => clean(value))) fail('AEP_EXPLOITATION_DATA_INVALID')
    const point = byName.get(normalized(row.pointName))
    const owner = byEmail.get(clean(row.email).toLowerCase())
    if (!owner) fail('AEP_EXPLOITATION_DECLARANT_NOT_FOUND')
    if (held.has(normalized(row.pointName))) {
      if (point) fail('AEP_HOLD_HAS_POINT')
      seenHolds.add(normalized(row.pointName))
      issues.push({code: 'AEP_EXPLOITATION_HELD', sheet: 'Exploitations', row: row.row, pointName: clean(row.pointName)})
      continue
    }
    if (!point) fail('AEP_EXPLOITATION_POINT_NOT_FOUND')
    add(point, owner, {sheet: 'Exploitations', row: row.row, comment: nullable(row.comment)})
  }
  if (seenHolds.size !== held.size) fail('AEP_HOLD_NOT_FOUND')
  for (const decision of decisions.additionalOperators) {
    const point = points.find(point => point.key === decision.pointKey)
    const owner = declarants.find(owner => owner.data.siret === decision.declarantSiret)
    if (!point || !owner) fail('AEP_OPERATOR_DECISION_NOT_FOUND')
    add(point, owner, {decision: 'additionalOperators', reason: decision.reason})
    issues.push({code: 'AEP_ADDITIONAL_OPERATOR', pointKey: point.key, declarantKey: owner.key, reason: decision.reason})
  }
  if (points.some(point => ![...result.values()].some(exploitation => exploitation.pointId === point.id))) fail('AEP_POINT_WITHOUT_EXPLOITATION')
  return [...result.values()]
}

function addRetirements(legacy, points, decisions) {
  return decisions.retirementPointNames.map(name => {
    const matches = legacy.points.filter(point => clean(point.name) === name)
    const usages = legacy.exploitations.filter(row => clean(row.pointName) === name)
    if (matches.length !== 1 || !usages.length || usages.some(row => !isAepUsage(row.usage))) fail('AEP_RETIREMENT_NOT_EXCLUSIVELY_AEP')
    const codeBSS = clean(matches[0].codeBSS)
    const replacements = points.filter(point => point.data.codeBSS === codeBSS)
    if (!codeBSS || replacements.length !== 1) fail('AEP_RETIREMENT_REPLACEMENT_AMBIGUOUS')
    return {name, codeBSS, sourcePrefix: 'dropt-epidropt:point:', replacementKey: replacements[0].key,
      source: {sheet: 'Points prélèvement', row: matches[0].row, exploitationRows: usages.map(row => row.row).sort((a, b) => a - b)}}
  })
}

function validateSources(sources) {
  if (!Array.isArray(sources) || sources.length !== 2 || sources.some(source => !source || !clean(source.name)
    || basename(source.name) !== source.name || !SHA256.test(source.sha256))
    || unique(sources.map(source => source.name)).length !== sources.length) fail('AEP_SOURCES_INVALID')
}

/** Accepts ExcelJS workbooks or semantic row arrays (each record includes row). */
export function buildAepManifest({aepWorkbook, legacyWorkbook, decisions, sources}) {
  validateDecisions(decisions)
  validateSources(sources)
  const aep = workbookRows(aepWorkbook)
  const legacy = workbookRows(legacyWorkbook, true)
  if (!aep.points.length || !aep.declarants.length || !aep.exploitations.length) fail('AEP_SOURCE_EMPTY')
  const issues = []
  const declarants = addDeclarants(aep.declarants)
  const points = addPoints(aep.points, decisions, issues)
  const exploitations = addExploitations(aep.exploitations, points, declarants, decisions, issues)
  const retirements = addRetirements(legacy, points, decisions)
  if (decisions.expectedCounts) {
    const actual = {declarants: declarants.length, points: points.length, exploitations: exploitations.length, retirements: retirements.length}
    if (digest(actual) !== digest(decisions.expectedCounts)) fail('AEP_EXPECTED_COUNTS_MISMATCH')
  }
  const ordered = values => values.sort((a, b) => (a.key ?? a.name).localeCompare(b.key ?? b.name, 'en'))
  const manifest = {version: 1, kind: 'dropt-aep', sources: structuredClone(sources), decisions: structuredClone(decisions),
    issues: issues.sort((a, b) => digest(a).localeCompare(digest(b), 'en')),
    declarants: ordered(declarants), points: ordered(points), exploitations: ordered(exploitations), retirements: ordered(retirements)}
  manifest.manifestHash = digest(manifest)
  return validateAepManifest(manifest)
}

/** Rejects altered receipts/manifests as well as invalid cross-entity references. */
export function validateAepManifest(manifest) {
  if (!manifest || manifest.version !== 1 || manifest.kind !== 'dropt-aep') fail('AEP_MANIFEST_INVALID')
  const {manifestHash, ...content} = manifest
  if (!SHA256.test(manifestHash) || digest(content) !== manifestHash) fail('AEP_MANIFEST_HASH_MISMATCH')
  validateSources(manifest.sources)
  validateDecisions(manifest.decisions)
  for (const field of ['declarants', 'points', 'exploitations', 'retirements', 'issues']) {
    if (!Array.isArray(manifest[field])) fail('AEP_MANIFEST_INVALID')
  }
  for (const [field, kind] of [['declarants', 'preleveur'], ['points', 'point'], ['exploitations', 'exploitation']]) {
    const records = manifest[field]
    if (!records.length || unique(records.map(record => record.id)).length !== records.length) fail('AEP_MANIFEST_IDENTITY_INVALID')
    for (const record of records) {
      const expected = identity(kind, record.key)
      if (!record.key || expected.id !== record.id || expected.sourceId !== record.sourceId) fail('AEP_MANIFEST_IDENTITY_INVALID')
    }
  }
  manifest.declarants.forEach(validateManifestDeclarant)
  manifest.points.forEach(validateManifestPoint)
  manifest.exploitations.forEach(exploitation => validateManifestExploitation(exploitation, manifest))
  manifest.retirements.forEach(retirement => validateManifestRetirement(retirement, manifest))
  if (unique(manifest.retirements.map(retirement => retirement.name)).length !== manifest.retirements.length
    || manifest.retirements.length !== manifest.decisions.retirementPointNames.length) fail('AEP_MANIFEST_RETIREMENT_INVALID')
  return manifest
}

function validateManifestDeclarant(owner) {
  if (!validSiret(owner.data?.siret) || owner.key !== `siret:${owner.data.siret}` || owner.data.declarantRole !== 'PRELEVEUR'
    || owner.data.declarantType !== 'LEGAL_PERSON' || owner.data.preleveurType !== 'GESTIONNAIRE_AEP'
    || owner.data.quickDeclarationEnabled !== true) fail('AEP_MANIFEST_DECLARANT_INVALID')
}

function validateManifestPoint(point) {
  if (point.data?.waterBodyType !== 'SOUTERRAIN' || point.data.flowType !== 'PRELEVEMENT' || point.data.pointKind !== 'PHYSIQUE'
    || point.data.collectionMode !== 'MANUAL' || !Array.isArray(point.coordinates) || point.coordinates.length !== 2
    || point.coordinates.some(value => !Number.isFinite(value))) fail('AEP_MANIFEST_POINT_INVALID')
}

function validateManifestExploitation(exploitation, manifest) {
  const point = manifest.points.find(point => point.id === exploitation.pointId)
  const owner = manifest.declarants.find(owner => owner.id === exploitation.declarantId)
  if (!point || !owner || exploitation.key !== `${point.key}|${owner.key}|5` || exploitation.usageCode !== '5'
    || exploitation.data?.status !== 'EN_ACTIVITE' || exploitation.data.excludeFromQuickDeclaration !== false
    || exploitation.data.startDate !== null || exploitation.data.endDate !== null) fail('AEP_MANIFEST_EXPLOITATION_INVALID')
}

function validateManifestRetirement(retirement, manifest) {
  const replacement = manifest.points.find(point => point.key === retirement.replacementKey)
  if (!replacement || !retirement.codeBSS || retirement.codeBSS !== replacement.data.codeBSS
    || retirement.sourcePrefix !== 'dropt-epidropt:point:' || !manifest.decisions.retirementPointNames.includes(retirement.name)) fail('AEP_MANIFEST_RETIREMENT_INVALID')
}

export async function prepareAepManifest({aepFile, legacyFile, decisions}) {
  const files = [aepFile, legacyFile]
  const inputs = await Promise.all(files.map(async filename => {
    const details = await stat(filename)
    if (!details.isFile() || details.size > MAX_FILE_BYTES) fail('AEP_FILE_INVALID')
    const buffer = await readFile(filename)
    if (buffer.length > MAX_FILE_BYTES) fail('AEP_FILE_INVALID')
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(buffer)
    return {workbook, source: {name: basename(filename), sha256: createHash('sha256').update(buffer).digest('hex')}}
  }))
  return buildAepManifest({aepWorkbook: inputs[0].workbook, legacyWorkbook: inputs[1].workbook, decisions, sources: inputs.map(input => input.source)})
}
