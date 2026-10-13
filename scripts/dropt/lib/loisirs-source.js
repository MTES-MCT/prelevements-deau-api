import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {buildManifest, digest, clean, normalized, readWorkbook, EPIDROPT_SHEETS, FORMAT_VERSION, SCOPE} from './epidropt.js'

export const LOISIRS_POLICY = Object.freeze({version: 1, kind: 'AUTONOMOUS_LEISURE', usageCode: '7',
  requireExistingPoints: true, requireExistingDeclarants: true, excludeFromQuickDeclaration: false,
  collectors: 'NONE', preserveCampaigns: true, createMeters: false})

const hashPattern = /^[a-f\d]{64}$/
const uuidPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const emptyRives = {Contrat: [], Compteur: [], Lieu: [], Affectation: []}
const sorted = records => [...records].sort((left, right) => left.id.localeCompare(right.id))

function requireCondition(condition, code) {
  if (!condition) throw Object.assign(new Error(code), {code})
}

function assertLegacyManifest(manifest) {
  requireCondition(manifest?.formatVersion === FORMAT_VERSION && manifest.scope === SCOPE
    && ['points', 'declarants', 'exploitations', 'meters', 'allocations', 'issues'].every(key => Array.isArray(manifest[key]))
    && hashPattern.test(manifest.manifestHash), 'LOISIRS_PREVIOUS_MANIFEST_INVALID')
  const {manifestHash, ...payload} = manifest
  requireCondition(digest(payload) === manifestHash, 'LOISIRS_PREVIOUS_MANIFEST_HASH_INVALID')
}

function validateDecisions(decisions) {
  requireCondition(decisions?.version === 1 && hashPattern.test(decisions.sourceSha256)
    && hashPattern.test(decisions.previousManifestHash) && Array.isArray(decisions.exploitations)
    && decisions.exploitations.length > 0
    && Object.keys(decisions).every(key => ['version', 'sourceSha256', 'previousManifestHash', 'exploitations'].includes(key)), 'LOISIRS_DECISIONS_INVALID')
  const seen = new Set()
  for (const row of decisions.exploitations) {
    requireCondition(Number.isSafeInteger(row.row) && row.row >= 3 && !seen.has(row.row)
      && hashPattern.test(row.rowHash) && typeof row.pointName === 'string' && row.pointName === clean(row.pointName) && row.pointName
      && typeof row.declarantKey === 'string' && row.declarantKey.startsWith('epidropt:preleveur:')
      && /^\d{14}$/.test(row.declarantSiret)
      && Object.keys(row).every(key => ['row', 'rowHash', 'pointName', 'declarantKey', 'declarantSiret'].includes(key)), 'LOISIRS_SELECTION_INVALID')
    seen.add(row.row)
  }
}

function assertRecords(records, kind) {
  const ids = new Set()
  const sources = new Set()
  const prefix = {points: 'point', declarants: 'preleveur', exploitations: 'exploitation'}[kind]
  for (const row of records) {
    requireCondition(uuidPattern.test(row.id) && !ids.has(row.id) && typeof row.key === 'string' && row.key
      && new RegExp(`^dropt-epidropt:${prefix}:[a-f\\d]{32}$`).test(row.sourceId) && !sources.has(row.sourceId), 'LOISIRS_IDENTITY_INVALID')
    if (kind !== 'exploitations') requireCondition(Array.isArray(row.references) && row.references.length > 0
      && row.references.some(reference => reference.provider === 'epidropt' && typeof reference.externalId === 'string' && reference.externalId), 'LOISIRS_LEGACY_REFERENCE_REQUIRED')
    ids.add(row.id)
    sources.add(row.sourceId)
  }
}

function validateAnchors(manifest, evidence) {
  for (const kind of ['points', 'declarants', 'exploitations']) {
    assertRecords(manifest[kind], kind)
    requireCondition(Array.isArray(evidence.anchors?.[kind])
      && evidence.anchors[kind].length === manifest[kind].length
      && new Set(evidence.anchors[kind].map(row => row.id)).size === manifest[kind].length
      && manifest[kind].every(record => evidence.anchors[kind].some(anchor => anchor.id === record.id
        && anchor.recordHash === digest(record) && (kind === 'exploitations' ? typeof anchor.existedBefore === 'boolean' : anchor.existedBefore === true))), 'LOISIRS_ANCHOR_INVALID')
  }
}

function validateSelection(manifest, evidence) {
  requireCondition(manifest.exploitations.length === evidence.decisions.exploitations.length, 'LOISIRS_SELECTION_INCOMPLETE')
  const points = new Map(manifest.points.map(row => [row.id, row]))
  const owners = new Map(manifest.declarants.map(row => [row.id, row]))
  const selectedRows = new Set()
  for (const row of manifest.exploitations) {
    const point = points.get(row.pointId)
    const owner = owners.get(row.declarantId)
    const selection = evidence.decisions.exploitations.filter(selected => row.source?.some(source => source.sheet === 'Exploitations' && source.row === selected.row))
    requireCondition(row.usageCode === '7' && selection.length === 1 && row.source.length === 1
      && !selectedRows.has(selection[0].row) && point?.data.name === selection[0].pointName
      && owner?.key === selection[0].declarantKey && owner?.data.siret === selection[0].declarantSiret,
    'LOISIRS_EXPLOITATION_INVALID')
    requireCondition(owner.data.declarantRole === 'PRELEVEUR' && owner.data.declarantType === 'LEGAL_PERSON'
      && owner.data.preleveurType === 'AUTRE' && owner.user?.role === 'DECLARANT'
      && Array.isArray(owner.emails), 'LOISIRS_DECLARANT_INVALID')
    requireCondition(['SUPERFICIELLE', 'SOUTERRAIN'].includes(point.data.waterBodyType)
      && point.data.collectionMode !== 'EXTERNAL', 'LOISIRS_POINT_NOT_MANUAL')
    selectedRows.add(selection[0].row)
  }
  requireCondition(points.size === new Set(manifest.exploitations.map(row => row.pointId)).size
    && owners.size === new Set(manifest.exploitations.map(row => row.declarantId)).size, 'LOISIRS_EXTRA_OBJECT')
}

export function validateLoisirsManifest(manifest) {
  assertLegacyManifest(manifest)
  requireCondition(digest(manifest.loisirsPolicy) === digest(LOISIRS_POLICY)
    && ['meters', 'allocations', 'contracts'].every(key => Array.isArray(manifest[key]) && manifest[key].length === 0)
    && !Object.hasOwn(manifest, 'retirements') && manifest.issues.length === 0, 'LOISIRS_POLICY_INVALID')
  const evidence = manifest.loisirsEvidence
  validateDecisions(evidence?.decisions)
  requireCondition(manifest.inputs?.epidropt?.sha256 === evidence.decisions.sourceSha256
    && manifest.inputs.previousManifestHash === evidence.decisions.previousManifestHash
    && manifest.inputs.loisirsDecisionsHash === digest(evidence.decisions), 'LOISIRS_PROVENANCE_INVALID')
  validateAnchors(manifest, evidence)
  validateSelection(manifest, evidence)
  return manifest
}

// Build a bounded companion to the historical import. Existing PP and account
// records are anchors, not replacement profiles or a new import namespace.
export function buildLoisirsManifest({epidropt, previousManifest, decisions, source}) {
  assertLegacyManifest(previousManifest)
  validateDecisions(decisions)
  requireCondition(source?.sha256 === decisions.sourceSha256 && typeof source.name === 'string'
    && source.name === path.basename(source.name) && source.name
    && previousManifest.manifestHash === decisions.previousManifestHash, 'LOISIRS_SOURCE_CHANGED')
  const overrides = {exploitations: {}}
  const selected = [...decisions.exploitations].sort((left, right) => left.row - right.row)
  for (const decision of selected) {
    const rows = epidropt?.Exploitations?.filter(row => row.row === decision.row) ?? []
    requireCondition(rows.length === 1 && digest(rows[0].values) === decision.rowHash
      && clean(rows[0].values[1]) === decision.pointName && normalized(rows[0].values[3]) === 'loisirs', 'LOISIRS_SOURCE_ROW_CHANGED')
    requireCondition(previousManifest.declarants.some(owner => owner.key === decision.declarantKey
      && owner.data.siret === decision.declarantSiret), 'LOISIRS_EXISTING_DECLARANT_REQUIRED')
    overrides.exploitations[decision.rowHash] = {declarantKey: decision.declarantKey}
  }
  const prepared = buildManifest({epidropt, rives: emptyRives, overrides, previousManifest})
  const exploitations = selected.map(decision => {
    const rows = prepared.exploitations.filter(row => row.source.some(source => source.sheet === 'Exploitations' && source.row === decision.row))
    requireCondition(rows.length === 1 && rows[0].source.length === 1 && rows[0].usageCode === '7', 'LOISIRS_SOURCE_UNRESOLVED')
    const previous = previousManifest.exploitations.find(row => row.id === rows[0].id)
    requireCondition(!previous || (previous.pointId === rows[0].pointId && previous.declarantId === rows[0].declarantId
      && previous.usageCode === '7' && previous.sourceId === rows[0].sourceId), 'LOISIRS_EXISTING_EXPLOITATION_CHANGED')
    return rows[0]
  })
  const dependencies = (kind, idKey) => sorted([...new Set(exploitations.map(row => row[idKey]))].map(id => {
    const matches = previousManifest[kind].filter(row => row.id === id)
    const incoming = prepared[kind].find(row => row.id === id)
    requireCondition(matches.length === 1 && incoming?.sourceId === matches[0].sourceId
      && incoming.key === matches[0].key && digest(incoming.references) === digest(matches[0].references), 'LOISIRS_EXISTING_IDENTITY_REQUIRED')
    return structuredClone(matches[0])
  }))
  const records = {points: dependencies('points', 'pointId'), declarants: dependencies('declarants', 'declarantId'), exploitations: sorted(exploitations)}
  const anchors = Object.fromEntries(Object.entries(records).map(([kind, rows]) => [kind, rows.map(row => ({id: row.id, recordHash: digest(row),
    existedBefore: previousManifest[kind].some(previous => previous.id === row.id)}))]))
  const normalizedDecisions = {...structuredClone(decisions), exploitations: selected}
  const payload = {formatVersion: FORMAT_VERSION, scope: SCOPE,
    inputs: {epidropt: {...source}, previousManifestHash: previousManifest.manifestHash, loisirsDecisionsHash: digest(normalizedDecisions)},
    overridesHash: digest(overrides), ...records, meters: [], allocations: [], contracts: [], issues: [],
    reconciliation: selected.map(row => ({kind: 'LOISIRS_SOURCE_REVIEW', status: 'ACCEPTED', source: {sheet: 'Exploitations', row: row.row}, rowHash: row.rowHash, declarantKey: row.declarantKey})),
    loisirsPolicy: {...LOISIRS_POLICY}, loisirsEvidence: {decisions: normalizedDecisions, anchors}}
  return validateLoisirsManifest({...payload, manifestHash: digest(payload)})
}

export async function prepareLoisirsManifest({epidroptFile, previousManifestFile, decisions}) {
  const source = {name: path.basename(epidroptFile), sha256: createHash('sha256').update(await readFile(epidroptFile)).digest('hex')}
  const previousManifest = JSON.parse(await readFile(previousManifestFile, 'utf8'))
  return buildLoisirsManifest({epidropt: await readWorkbook(epidroptFile, EPIDROPT_SHEETS), previousManifest, decisions, source})
}
