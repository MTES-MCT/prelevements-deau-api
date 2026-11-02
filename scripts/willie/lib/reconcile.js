import {Prisma} from '@prisma/client'
import {digest} from './history.js'

export {digest}
export const check = (condition, code) => { if (!condition) throw new Error(`WILLIE_RECONCILE_${code}`) }
export const unique = values => [...new Set(values)].sort()
export const stableId = key => {
  const hash = digest(`willie-reconcile:${key}`)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const sha = /^[a-f\d]{64}$/
const DAY = 86_400_000
const instant = value => new Date(value).getTime()
const decimal = value => new Prisma.Decimal(value).toFixed()
const isVolume = value => ['volume', 'volume_preleve', 'volume_rejete'].includes(value.metricTypeCode)
export const rows = async (client, sql, parameters = []) => (await client.query(sql, parameters)).rows
export const normalizeRow = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)
    ? new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`).toISOString() : value]))
export const TABLES = Object.freeze({
  points: ['PointPrelevement', 'id'], users: ['User', 'id'], declarants: ['Declarant', 'userId'],
  exploitations: ['DeclarantPointPrelevement', 'id'], connectors: ['DeclarantPointPrelevementConnector', 'id'],
  sources: ['Source', 'id'], chunks: ['Chunk', 'id'], values: ['ChunkValue', 'id'],
  replacements: ['ChunkValueReplacement', 'id'], summaries: ['ChunkValueSummary', 'chunkId'],
  collectorLinks: ['DeclarantCollecteurExploitation', 'id'], meterAllocations: ['MeterAllocation', 'id'],
  collectionResponses: ['CollectionResponse', 'id'], identityLocks: ['ExploitationIdentityLock', null]
})
export const writableTables = ['exploitations', 'connectors', 'sources', 'chunks', 'values', 'replacements']
export const pointIds = manifest => unique([...manifest.entries, ...manifest.retireConnectors, ...manifest.transfers].map(row => row.pointId))
export const ownerIds = manifest => unique([...manifest.entries.map(row => row.preleveurId), ...manifest.retireConnectors.map(row => row.preleveurId),
  ...manifest.transfers.flatMap(row => [row.fromPreleveurId, row.toPreleveurId])])

function validateBinding(row) {
  check(['connectorId', 'sourcePointId', 'exploitationId', 'pointId', 'preleveurId'].every(key => uuid.test(row[key]))
    && Number.isFinite(row.rate) && row.rate > 0 && row.rate <= 100, 'BINDING_INVALID')
}

export function validateManifest(manifest, payload) {
  const {manifestHash, ...body} = manifest ?? {}
  const {payloadHash, ...data} = payload ?? {}
  check(manifest?.version === 1 && manifest.operation === 'willie-reconcile' && manifestHash === digest(body)
    && manifest.conflictPolicy === 'ARCHIVE_WHOLE_ROW' && Number.isFinite(instant(manifest.createdAt))
    && sha.test(manifest.sourceHashes?.workbook ?? '') && Array.isArray(manifest.entries) && manifest.entries.length > 0
    && manifest.entries.length <= 100 && Array.isArray(manifest.retireConnectors) && Array.isArray(manifest.transfers), 'MANIFEST_INVALID')
  check(payload?.version === 1 && payload.provider === 'willie' && payloadHash === digest(data)
    && manifest.payloadHash === payloadHash && digest(manifest.window) === digest(payload.window)
    && Array.isArray(payload.stations), 'PAYLOAD_INVALID')
  const start = `${manifest.window?.start}T00:00:00.000Z`
  const end = `${manifest.window?.end}T00:00:00.000Z`
  check(/^\d{4}-\d{2}-\d{2}$/.test(manifest.window?.start) && /^\d{4}-\d{2}-\d{2}$/.test(manifest.window?.end)
    && instant(end) > instant(start) && instant(end) - instant(start) <= 366 * DAY
    && instant(end) <= instant(manifest.createdAt), 'WINDOW_INVALID')
  const bindings = [...manifest.entries, ...manifest.retireConnectors]
  bindings.forEach(validateBinding)
  check(unique(bindings.map(row => row.connectorId)).length === bindings.length
    && unique(manifest.entries.map(row => row.sourcePointId)).length === manifest.entries.length
    && unique(payload.stations.map(row => row.sourcePointId)).length === payload.stations.length
    && payload.stations.length === manifest.entries.length, 'DUPLICATE_BINDING')
  for (const row of manifest.retireConnectors) check(typeof row.archiveValues === 'boolean', 'RETIREMENT_INVALID')
  for (const row of manifest.transfers) {
    check(['exploitationId', 'pointId', 'fromPreleveurId', 'toPreleveurId'].every(key => uuid.test(row[key]))
      && row.fromPreleveurId !== row.toPreleveurId && Array.isArray(row.chunkIds) && row.chunkIds.every(id => uuid.test(id))
      && unique(row.chunkIds).length === row.chunkIds.length, 'TRANSFER_INVALID')
  }
  check(unique(manifest.transfers.map(row => row.exploitationId)).length === manifest.transfers.length, 'TRANSFER_INVALID')
  for (const station of payload.stations) {
    check(manifest.entries.some(row => row.sourcePointId === station.sourcePointId) && sha.test(station.rawSha256)
      && Array.isArray(station.values) && station.values.length <= 366, 'STATION_INVALID')
    let previous = null
    for (const value of station.values) {
      check(typeof value.value === 'number' && Number.isFinite(value.value) && value.value >= 0
        && /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(value.periodStart)
        && /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(value.periodEnd)
        && instant(value.periodEnd) - instant(value.periodStart) === DAY
        && value.periodStart >= start && value.periodEnd <= end
        && (!previous || previous < value.periodStart), 'VALUE_INVALID')
      previous = value.periodStart
    }
  }
}

async function readTable(client, name, predicate, parameters) {
  const [table, key] = TABLES[name]
  const decimalField = ['values', 'replacements'].includes(name) ? ' || jsonb_build_object(\'value\',t.value::text)' : ''
  // jsonb_populate_record maps JSON null to SQL NULL; preserve the distinct JSON-null case explicitly.
  const jsonNull = name === 'sources' ? ' || jsonb_build_object(\'__jsonNullFields\',CASE WHEN t.metadata IS NOT NULL AND t.metadata::jsonb=\'null\'::jsonb THEN \'[["metadata"]]\'::jsonb->0 ELSE \'[]\'::jsonb END)' : ''
  return (await rows(client, `SELECT to_jsonb(t)${decimalField}${jsonNull} AS row FROM "${table}" t
    WHERE ${predicate} ORDER BY ${key ? `t."${key}"` : 't."declarantUserId",t."pointPrelevementId"'}`, parameters)).map(row => {
    const result = normalizeRow(row.row)
    if (decimalField) result.value = decimal(result.value)
    return result
  })
}

export async function readReconcileState(client, manifest) {
  const points = pointIds(manifest)
  const owners = ownerIds(manifest)
  const tables = {}
  tables.points = await readTable(client, 'points', 't.id=ANY($1::uuid[])', [points])
  tables.users = await readTable(client, 'users', 't.id=ANY($1::uuid[])', [owners])
  tables.declarants = await readTable(client, 'declarants', 't."userId"=ANY($1::uuid[])', [owners])
  tables.exploitations = await readTable(client, 'exploitations', 't."pointPrelevementId"=ANY($1::uuid[])', [points])
  const exploitations = tables.exploitations.map(row => row.id)
  tables.connectors = await readTable(client, 'connectors', 't."declarantPointPrelevementId"=ANY($1::uuid[])', [exploitations])
  tables.chunks = await readTable(client, 'chunks', 't."pointPrelevementId"=ANY($1::uuid[])', [points])
  const chunks = tables.chunks.map(row => row.id)
  const sources = unique(tables.chunks.map(row => row.sourceId))
  tables.sources = await readTable(client, 'sources', 't.id=ANY($1::uuid[])', [sources])
  tables.values = await readTable(client, 'values', 't."chunkId"=ANY($1::uuid[])', [chunks])
  tables.replacements = await readTable(client, 'replacements', 't."pointPrelevementId"=ANY($1::uuid[]) OR t."replacedChunkId"=ANY($2::uuid[]) OR t."replacementChunkId"=ANY($2::uuid[])', [points, chunks])
  tables.summaries = await readTable(client, 'summaries', 't."chunkId"=ANY($1::uuid[])', [chunks])
  for (const name of ['collectorLinks', 'meterAllocations', 'collectionResponses']) {
    tables[name] = await readTable(client, name, 't."exploitationId"=ANY($1::uuid[])', [exploitations])
  }
  tables.identityLocks = await readTable(client, 'identityLocks', 't."pointPrelevementId"=ANY($1::uuid[])', [points])
  const siblingChunks = (await rows(client, `SELECT to_jsonb(c) AS row FROM "Chunk" c
    WHERE c."sourceId"=ANY($1::uuid[]) AND NOT(c.id=ANY($2::uuid[])) ORDER BY c.id`, [sources, chunks])).map(row => row.row)
  const [siblingValues] = await rows(client, `SELECT count(*)::int AS count,
    md5(coalesce(string_agg(md5(to_jsonb(v)::text),'' ORDER BY v.id),'')) AS hash
    FROM "ChunkValue" v JOIN "Chunk" c ON c.id=v."chunkId"
    WHERE c."sourceId"=ANY($1::uuid[]) AND NOT(c.id=ANY($2::uuid[]))`, [sources, chunks])
  const declarations = (await rows(client, `SELECT to_jsonb(d) AS row FROM "Declaration" d
    WHERE d.id IN (SELECT "declarationId" FROM "Source" WHERE id=ANY($1::uuid[])) ORDER BY d.id`, [sources])).map(row => row.row)
  return {tables, outside: {siblingChunks, siblingValues, declarations}}
}

function identityGuard(manifest, state, blocked) {
  const block = (code, details = {}) => blocked.push({code: `WILLIE_RECONCILE_${code}`, ...details})
  const {tables} = state
  for (const row of [...manifest.entries, ...manifest.retireConnectors]) {
    const exploitation = tables.exploitations.find(item => item.id === row.exploitationId)
    const transfer = manifest.transfers.find(item => item.exploitationId === row.exploitationId)
    if (!exploitation || exploitation.pointPrelevementId !== row.pointId
      || ![row.preleveurId, transfer?.fromPreleveurId].includes(exploitation.declarantUserId)) block('EXPLOITATION_IDENTITY', {exploitationId: row.exploitationId})
    const point = tables.points.find(item => item.id === row.pointId)
    const user = tables.users.find(item => item.id === row.preleveurId)
    const declarant = tables.declarants.find(item => item.userId === row.preleveurId)
    if (!point || point.deletedAt || !user || user.deletedAt || user.role !== 'DECLARANT' || declarant?.declarantRole !== 'PRELEVEUR') block('INACTIVE_IDENTITY', {connectorId: row.connectorId})
    const connector = tables.connectors.find(item => item.id === row.connectorId)
    if (connector && (connector.connectorType !== 'willie' || connector.declarantPointPrelevementId !== row.exploitationId
      || connector.connectorParameters?.sourcePointId !== row.sourcePointId)) block('CONNECTOR_IDENTITY', {connectorId: row.connectorId})
  }
  for (const transfer of manifest.transfers) {
    if (tables.exploitations.some(item => item.id !== transfer.exploitationId && item.pointPrelevementId === transfer.pointId
      && item.declarantUserId === transfer.toPreleveurId)) block('TRANSFER_COLLISION')
    if (tables.meterAllocations.some(row => row.exploitationId === transfer.exploitationId)
      || tables.collectionResponses.some(row => row.exploitationId === transfer.exploitationId)) block('TRANSFER_PROTECTED_HISTORY')
    const candidates = tables.chunks.filter(row => row.pointPrelevementId === transfer.pointId
      && (row.exploitationId === transfer.exploitationId || (row.exploitationId === null && [transfer.fromPreleveurId, transfer.toPreleveurId].includes(row.preleveurUserId))))
    const originalIds = candidates.filter(row => !row.metadata?.willieReconciliation).map(row => row.id)
    if (digest(unique(originalIds)) !== digest(unique(transfer.chunkIds))) block('TRANSFER_SCOPE_CHANGED')
    for (const chunk of candidates) if (chunk.calculationStrategy !== 'GENERIC' || chunk.compteurId
      || ![transfer.fromPreleveurId, transfer.toPreleveurId].includes(chunk.preleveurUserId)) block('TRANSFER_CHUNK_IDENTITY', {chunkId: chunk.id})
  }
  for (const chunk of tables.chunks) {
    if (![...manifest.entries, ...manifest.retireConnectors].some(row => row.pointId === chunk.pointPrelevementId
      && (row.preleveurId === chunk.preleveurUserId || row.exploitationId === chunk.exploitationId))) continue
    const source = tables.sources.find(row => row.id === chunk.sourceId)
    if (source && ['PENDING', 'PROCESSING'].includes(source.status)) block('SOURCE_IN_PROGRESS', {sourceId: source.id})
  }
  return block
}

const overlap = (left, right) => instant(left.periodStart) < instant(right.periodEnd) && instant(right.periodStart) < instant(left.periodEnd)
const samePeriod = (left, right) => instant(left.periodStart) === instant(right.periodStart) && instant(left.periodEnd) === instant(right.periodEnd)
const metadataConnector = (chunk, source) => chunk.metadata?.connectorId ?? chunk.parsingInfo?.connectorId ?? source?.metadata?.connectorId
const provider = (chunk, source) => chunk.metadata?.connector ?? chunk.parsingInfo?.connector ?? source?.metadata?.connector

export function buildReconcilePlan(manifest, payload, state) {
  validateManifest(manifest, payload)
  const blocked = []
  const block = identityGuard(manifest, state, blocked)
  const after = structuredClone(state.tables)
  const now = manifest.createdAt
  const chunksById = new Map(after.chunks.map(row => [row.id, row]))
  const sourcesById = new Map(after.sources.map(row => [row.id, row]))
  const changes = []
  const touchedChunks = new Set()
  const touchedSources = new Set()
  const archived = new Map()
  let insertedValues = 0
  let transferredChunks = 0
  for (const transfer of manifest.transfers) {
    const exploitation = after.exploitations.find(row => row.id === transfer.exploitationId)
    if (!exploitation) continue
    if (exploitation.declarantUserId !== transfer.toPreleveurId) {
      exploitation.declarantUserId = transfer.toPreleveurId
      exploitation.updatedAt = now
    }
    for (const id of transfer.chunkIds) {
      const chunk = chunksById.get(id)
      if (!chunk || chunk.pointPrelevementId !== transfer.pointId) continue
      if (chunk.preleveurUserId === transfer.toPreleveurId && chunk.exploitationId === transfer.exploitationId) continue
      chunk.preleveurUserId = transfer.toPreleveurId
      chunk.exploitationId = transfer.exploitationId
      const source = sourcesById.get(chunk.sourceId)
      if (provider(chunk, source) === 'willie' && chunk.submittedByDeclarantUserId === transfer.fromPreleveurId) chunk.submittedByDeclarantUserId = transfer.toPreleveurId
      chunk.seriesKey = null
      chunk.contentHash = null
      chunk.updatedAt = now
      touchedChunks.add(id)
      transferredChunks++
      // Provider provenance remains original; only Willie routing metadata is updated.
      if (provider(chunk, source) === 'willie') {
        if (state.outside.siblingChunks.some(row => row.sourceId === chunk.sourceId)
          || after.chunks.some(row => row.sourceId === chunk.sourceId && row.pointPrelevementId !== transfer.pointId)) block('SHARED_WILLIE_SOURCE', {sourceId: chunk.sourceId})
        else if (source) {
          source.metadata = {...source.metadata, declarantId: transfer.toPreleveurId}
          source.__jsonNullFields = []
          source.updatedAt = now
          touchedSources.add(source.id)
        }
      }
    }
  }
  const archive = (value, reason, replacement = null) => {
    if (archived.has(value.id)) return
    const chunk = chunksById.get(value.chunkId)
    if (chunk.calculationStrategy !== 'GENERIC' || chunk.compteurId) { block('PROTECTED_VALUE', {valueId: value.id}); return }
    archived.set(value.id, value)
    touchedChunks.add(chunk.id)
    touchedSources.add(chunk.sourceId)
    after.replacements.push({id: stableId(`${manifest.manifestHash}:archive:${value.id}`), replacedChunkValueId: value.id,
      replacedChunkId: chunk.id, replacedSourceId: chunk.sourceId, replacementChunkValueId: replacement?.id ?? null,
      replacementChunkId: replacement?.chunkId ?? null, replacementSourceId: replacement?.sourceId ?? null,
      pointPrelevementId: chunk.pointPrelevementId, metricTypeCode: value.metricTypeCode, unit: value.unit,
      frequency: value.frequency, periodStart: value.periodStart, periodEnd: value.periodEnd, valueKind: value.valueKind,
      value: value.value, conflictPolicy: 'REPLACE_EXISTING', replaceComment: 'WILLIE_RECONCILIATION',
      metadata: {manifestHash: manifest.manifestHash, reason, wholeRow: true,
        originalValue: value, originalChunk: state.tables.chunks.find(row => row.id === chunk.id)}, createdAt: now})
  }
  for (const retired of manifest.retireConnectors) {
    after.connectors = after.connectors.filter(row => row.id !== retired.connectorId)
    if (!retired.archiveValues) continue
    for (const value of after.values) {
      const chunk = chunksById.get(value.chunkId)
      const source = sourcesById.get(chunk.sourceId)
      if (metadataConnector(chunk, source) !== retired.connectorId || provider(chunk, source) !== 'willie') continue
      if (chunk.pointPrelevementId !== retired.pointId || chunk.preleveurUserId !== retired.preleveurId) {
        block('RETIRED_HISTORY_IDENTITY', {chunkId: chunk.id}); continue
      }
      if (isVolume(value) && instant(value.periodStart) < instant(`${manifest.window.end}T00:00:00Z`)
        && instant(value.periodEnd) > instant(`${manifest.window.start}T00:00:00Z`)) archive(value, 'RETIRED_CONNECTOR')
    }
  }
  for (const entry of manifest.entries) {
    const exploitation = after.exploitations.find(row => row.id === entry.exploitationId)
    const point = after.points.find(row => row.id === entry.pointId)
    if (!exploitation || !point) continue
    let connector = after.connectors.find(row => row.id === entry.connectorId)
    if (!connector) {
      connector = {id: entry.connectorId, declarantPointPrelevementId: entry.exploitationId, connectorType: 'willie',
        connectorParameters: {sourcePointId: entry.sourcePointId}, rate: entry.rate, createdAt: now, updatedAt: now}
      after.connectors.push(connector)
    } else if (connector.rate !== entry.rate) { connector.rate = entry.rate; connector.updatedAt = now }
    const station = payload.stations.find(row => row.sourcePointId === entry.sourcePointId)
    const sourceId = stableId(`${manifest.manifestHash}:source:${entry.connectorId}`)
    const chunkId = stableId(`${manifest.manifestHash}:chunk:${entry.connectorId}`)
    const inserts = []
    for (const raw of station.values) {
      const value = {...raw, value: new Prisma.Decimal(raw.value).times(entry.rate).div(100).toFixed()}
      const matching = after.values.filter(existing => {
        if (archived.has(existing.id) || !isVolume(existing) || !overlap(existing, value)) return false
        const chunk = chunksById.get(existing.chunkId)
        const source = sourcesById.get(chunk?.sourceId)
        if (!chunk || chunk.instructionStatus === 'REJECTED' || source?.status !== 'COMPLETED'
          || chunk.pointPrelevementId !== entry.pointId || chunk.preleveurUserId !== entry.preleveurId) return false
        if (chunk.exploitationId && chunk.exploitationId !== entry.exploitationId) return false
        const other = metadataConnector(chunk, source)
        // Different, identified Willie modules are additive; all other conflicts are replaced.
        if (provider(chunk, source) === 'willie' && other !== entry.connectorId) {
          const binding = manifest.entries.find(row => row.connectorId === other)
          if (binding && binding.exploitationId === entry.exploitationId && binding.sourcePointId !== entry.sourcePointId) return false
          block('UNIDENTIFIED_WILLIE_CONFLICT', {chunkId: chunk.id}); return false
        }
        return true
      })
      const equal = matching.filter(existing => {
        const chunk = chunksById.get(existing.chunkId)
        return provider(chunk, sourcesById.get(chunk.sourceId)) === 'willie'
          && metadataConnector(chunk, sourcesById.get(chunk.sourceId)) === entry.connectorId
          && chunk.instructionStatus === 'VALIDATED'
          && samePeriod(existing, value) && decimal(existing.value) === value.value && existing.unit === 'm3'
          && existing.frequency === '1 day' && existing.valueKind === 'DECLARED'
      }).sort((a, b) => a.id.localeCompare(b.id))[0]
      const replacement = equal ? {...equal, sourceId: chunksById.get(equal.chunkId).sourceId}
        : {id: stableId(`${manifest.manifestHash}:value:${entry.connectorId}:${value.periodStart}`), chunkId, sourceId}
      for (const conflict of matching) if (conflict.id !== equal?.id) archive(conflict, 'PROVIDER_PRIORITY', replacement)
      if (equal) {
        const chunk = chunksById.get(equal.chunkId)
        if (!chunk.exploitationId) { chunk.exploitationId = entry.exploitationId; chunk.updatedAt = now; touchedChunks.add(chunk.id) }
      } else inserts.push({id: replacement.id, chunkId, metricTypeCode: 'volume', unit: 'm3', frequency: '1 day',
        periodStart: value.periodStart, periodEnd: value.periodEnd, valueKind: 'DECLARED', value: value.value,
        remark: null, metadata: {}, createdAt: now, updatedAt: now})
    }
    if (!inserts.length) continue
    if (sourcesById.has(sourceId) || chunksById.has(chunkId)) { block('PARTIAL_RECONCILIATION_STATE'); continue }
    const identity = {connector: 'willie', connectorId: entry.connectorId, connectorRate: entry.rate,
      sourcePointId: entry.sourcePointId, pointId: entry.pointId, declarantId: entry.preleveurId}
    const source = {id: sourceId, type: 'API', status: 'COMPLETED', globalInstructionStatus: 'VALIDATED',
      metadata: {...identity, sourceMetadata: {provider: 'willie', resolution: 'day', station_id: entry.sourcePointId,
        rawSha256: station.rawSha256}, willieReconciliation: manifest.manifestHash}, declarationId: null, apiImportId: null,
      createdAt: now, updatedAt: now, __jsonNullFields: []}
    const chunk = {id: chunkId, sourceId, pointPrelevementId: entry.pointId, pointPrelevementName: point.name,
      exploitationId: entry.exploitationId, preleveurUserId: entry.preleveurId, submittedByDeclarantUserId: entry.preleveurId,
      collecteurUserId: null, usageId: exploitation.usageId, flowType: point.flowType, calculationStrategy: 'GENERIC',
      compteurId: null, autoCalculateVolumes: false, instructionStatus: 'VALIDATED', instructedAt: null,
      instructedByInstructorUserId: null, instructionComment: null, minDate: inserts[0].periodStart.slice(0, 10),
      maxDate: inserts.at(-1).periodEnd.slice(0, 10), metadata: {...identity, willieReconciliation: manifest.manifestHash},
      parsingInfo: {...identity, case: 1, reason: 'SERVICE_ACCOUNT_API_CONNECTOR', pointAssociationOrigin: 'AUTOMATIC'},
      seriesKey: null, contentHash: null, createdAt: now, updatedAt: now}
    after.sources.push(source); sourcesById.set(sourceId, source)
    after.chunks.push(chunk); chunksById.set(chunkId, chunk)
    after.values.push(...inserts)
    insertedValues += inserts.length
    touchedChunks.add(chunkId); touchedSources.add(sourceId)
  }
  after.values = after.values.filter(row => !archived.has(row.id))
  for (const id of touchedChunks) {
    const chunk = chunksById.get(id)
    const values = after.values.filter(row => row.chunkId === id)
    if (archived.size && state.tables.values.some(row => row.chunkId === id && archived.has(row.id))) {
      chunk.contentHash = null; chunk.seriesKey = null; chunk.updatedAt = now
      if (!values.length) { chunk.instructionStatus = 'REJECTED'; chunk.instructionComment = 'WILLIE_RECONCILIATION'; chunk.instructedAt = now; chunk.instructedByInstructorUserId = null }
      else { chunk.minDate = new Date(Math.min(...values.map(row => instant(row.periodStart)))).toISOString().slice(0, 10)
        chunk.maxDate = new Date(Math.max(...values.map(row => instant(row.periodEnd)))).toISOString().slice(0, 10) }
    }
  }
  for (const table of writableTables) {
    const [, key] = TABLES[table]
    const previous = new Map(state.tables[table].map(row => [row[key], row]))
    const next = new Map(after[table].map(row => [row[key], row]))
    for (const id of unique([...previous.keys(), ...next.keys()])) {
      const before = previous.get(id) ?? null
      const result = next.get(id) ?? null
      if (digest(before) !== digest(result)) changes.push({table, key: id, before, after: result})
    }
  }
  return {changes, blocked, touchedChunks: [...touchedChunks].sort(), touchedSources: [...touchedSources].sort(),
    summary: {changes: changes.length, archivedValues: archived.size, insertedValues, transferredChunks}}
}

export async function reviewReconcile(client, manifest, payload) {
  validateManifest(manifest, payload)
  const before = await readReconcileState(client, manifest)
  const plan = buildReconcilePlan(manifest, payload, before)
  const stateHash = digest(before)
  return {operation: 'willie-reconcile', manifestHash: manifest.manifestHash, payloadHash: payload.payloadHash,
    before, stateHash, ...plan, planHash: digest({manifestHash: manifest.manifestHash, stateHash, plan}),
    complete: plan.blocked.length === 0, applied: false}
}

export async function lockReconcileBeforeTransaction(client, manifest) {
  for (const id of pointIds(manifest)) await client.query("SELECT pg_advisory_lock(hashtext('volumes-from-index'),hashtext($1))", [id])
}

export {applyReconcile, rollbackReconcile} from './reconcile-apply.js'
