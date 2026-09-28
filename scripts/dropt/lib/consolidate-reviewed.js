import {digest, stableId, SCOPE} from './epidropt.js'
import {assertRebuildTarget} from './rebuild-epidropt.js'
import {lockMeter} from '../../../lib/services/meter-publication.js'

const ALIAS_PROVIDER = 'pe-import-alias'
const RETIREMENT_PROVIDER = 'pe-import-retired'
const RESET_PROVIDER = 'pe-import-reset'
const POINT_PREFIX = 'dropt-epidropt:point:'
const EXPLOITATION_PREFIX = 'dropt-epidropt:exploitation:'
const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const unique = values => [...new Set(values)].sort()
const ids = rows => rows.map(row => row.id)
const inIds = values => ({in: values})
const json = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item))
const requireCondition = (condition, code) => { if (!condition) throw new Error(code) }
const emptyInventory = () => Object.fromEntries([
  'points', 'exploitations', 'zones', 'references', 'meters', 'allocations', 'versions', 'streams', 'publications',
  'sources', 'chunks', 'contributions', 'values', 'replacements', 'documents', 'documentLinks',
  'rules', 'connectors', 'responses', 'collecteurs', 'secondaryUsages'
].map(key => [key, []]))

export function normalizeReviewedConsolidationPlan(plan) {
  requireCondition(plan?.scope === SCOPE, 'CONSOLIDATION_SCOPE_INVALID')
  requireCondition(Array.isArray(plan.merges ?? []) && Array.isArray(plan.retirePointIds ?? [])
    && Array.isArray(plan.retireExploitationIds ?? []) && Array.isArray(plan.resetMeterIds ?? []), 'CONSOLIDATION_PLAN_INVALID')
  const checkId = value => {
    requireCondition(typeof value === 'string' && uuidPattern.test(value), 'CONSOLIDATION_UUID_REQUIRED')
    return value.toLowerCase()
  }
  const merges = (plan.merges ?? []).map(item => ({
    sourcePointId: checkId(item.sourcePointId), targetPointId: checkId(item.targetPointId),
    exploitationMerges: (item.exploitationMerges ?? []).map(pair => ({sourceId: checkId(pair.sourceId), targetId: checkId(pair.targetId)}))
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
  })).sort((a, b) => a.sourcePointId.localeCompare(b.sourcePointId))
  const retirePointIds = unique((plan.retirePointIds ?? []).map(checkId))
  const retireExploitationIds = unique((plan.retireExploitationIds ?? []).map(checkId))
  const resetMeterIds = unique((plan.resetMeterIds ?? []).map(checkId))
  const sources = merges.map(item => item.sourcePointId)
  requireCondition(unique(sources).length === sources.length, 'CONSOLIDATION_SOURCE_REPEATED')
  requireCondition(merges.every(item => item.sourcePointId !== item.targetPointId
    && !sources.includes(item.targetPointId) && !retirePointIds.includes(item.targetPointId)
    && !retirePointIds.includes(item.sourcePointId)), 'CONSOLIDATION_CHAIN_OR_RETIREMENT_CONFLICT')
  const exploitationMerges = merges.flatMap(item => item.exploitationMerges)
  requireCondition(unique(exploitationMerges.map(item => item.sourceId)).length === exploitationMerges.length
    && exploitationMerges.every(item => item.sourceId !== item.targetId && !retireExploitationIds.includes(item.sourceId)
      && !retireExploitationIds.includes(item.targetId) && !exploitationMerges.some(other => other.sourceId === item.targetId)),
  'CONSOLIDATION_EXPLOITATION_MAPPING_CONFLICT')
  return {scope: SCOPE, merges, retirePointIds, retireExploitationIds, resetMeterIds, discardMeterVolumes: plan.discardMeterVolumes === true}
}

function decimalVolume(values) {
  const total = values.reduce((sum, value) => {
    const [integer, fraction = ''] = String(value).split('.')
    requireCondition(/^\d+$/.test(integer) && /^\d{0,4}$/.test(fraction), 'CONSOLIDATION_VOLUME_INVALID')
    return sum + BigInt(integer) * 10_000n + BigInt(fraction.padEnd(4, '0'))
  }, 0n)
  return `${total / 10_000n}.${String(total % 10_000n).padStart(4, '0')}`
}

const sameScalar = (left, right, field) => digest(json(left[field] ?? null)) === digest(json(right[field] ?? null))
const aliasFor = (references, oldId) => references.find(ref => ref.provider === ALIAS_PROVIDER && ref.scope === SCOPE
  && ref.kind === 'POINT' && ref.externalId === oldId)
const retirementFor = (references, oldId) => references.find(ref => ref.provider === RETIREMENT_PROVIDER
  && ref.scope === SCOPE && ref.kind === 'POINT' && ref.externalId === oldId)
const resetFor = (references, meterId, planHash) => references.find(ref => ref.provider === RESET_PROVIDER
  && ref.scope === SCOPE && ref.kind === 'METER' && ref.externalId === `${planHash}:${meterId}`)
const isResetMarker = reference => reference.provider === RESET_PROVIDER && reference.scope === SCOPE
  && reference.kind === 'METER' && reference.externalId === `${reference.metadata?.planHash}:${reference.compteurId}`
  && /^[\da-f]{64}$/.test(reference.metadata?.planHash ?? '')

// Pure planning: reports contain identifiers/counts/hashes, never row payloads.
export function planReviewedConsolidation(plan, suppliedInventory) {
  plan = normalizeReviewedConsolidationPlan(plan)
  const planHash = digest(plan)
  const inventory = {...emptyInventory(), ...suppliedInventory}
  const blocked = []
  const warnings = []
  const block = (code, details = {}) => blocked.push({code, ...details})
  const pointById = new Map(inventory.points.map(point => [point.id, point]))
  const exploitationById = new Map(inventory.exploitations.map(item => [item.id, item]))
  const actions = {merges: [], retirePointIds: [], moveExploitations: [], mergeExploitations: [], retireExploitationIds: [], resetMeterIds: []}
  const checkPoint = (point, id) => {
    if (!point) block('POINT_MISSING', {id})
    else if (!point.sourceId?.startsWith(POINT_PREFIX)) block('POINT_OUTSIDE_DROPT_IMPORT', {id})
    return Boolean(point)
  }
  for (const merge of plan.merges) {
    const source = pointById.get(merge.sourcePointId)
    const target = pointById.get(merge.targetPointId)
    if (!checkPoint(source, merge.sourcePointId) || !checkPoint(target, merge.targetPointId)) continue
    const alias = aliasFor(inventory.references, source.id)
    const sourceExploitations = inventory.exploitations.filter(item => item.pointPrelevementId === source.id)
    if (alias && alias.pointPrelevementId !== target.id) block('POINT_ALIAS_CONFLICT', {id: source.id})
    if (source.deletedAt) {
      if (!alias || alias.pointPrelevementId !== target.id || sourceExploitations.length) block('POINT_ALREADY_DELETED_OUTSIDE_PLAN', {id: source.id})
      if (merge.exploitationMerges.some(pair => !alias?.metadata?.exploitationAliases?.some(previous => previous.sourceId === pair.sourceId && previous.targetId === pair.targetId))) {
        block('PREVIOUS_EXPLOITATION_MERGE_DIFFERS', {id: source.id})
      }
      continue
    }
    if (alias) block('POINT_ALIAS_ALREADY_SET_ON_ACTIVE_SOURCE', {id: source.id})
    if (target.deletedAt) block('CANONICAL_POINT_DELETED', {id: target.id})
    if (source.flowType !== target.flowType || source.waterBodyType !== target.waterBodyType) block('POINT_RESOURCE_CONFLICT', {id: source.id})
    const technicalFields = new Set(['id', 'name', 'sourceId', 'createdAt', 'updatedAt', 'deletedAt', 'otherNames', 'names'])
    const differentFields = Object.keys(source).filter(field => !technicalFields.has(field) && source[field] !== null
      && source[field] !== undefined && !sameScalar(source, target, field))
    if (differentFields.length) warnings.push({code: 'CANONICAL_FIELDS_PRESERVED_SOURCE_ARCHIVED', sourcePointId: source.id, targetPointId: target.id, fields: differentFields.sort()})
    const rivesRefs = inventory.references.filter(ref => ref.provider === 'rives-et-eaux' && ref.kind === 'POINT'
      && [source.id, target.id].includes(ref.pointPrelevementId))
    if (unique(rivesRefs.map(ref => ref.externalId)).length > 1) block('RIVES_PLACE_REFERENCES_CONFLICT', {id: source.id})
    if (rivesRefs.length && !rivesRefs.some(ref => ref.pointPrelevementId === target.id)) block('RIVES_ANCHOR_MUST_SURVIVE', {id: target.id})
    const targetZones = inventory.zones.filter(zone => zone.pointPrelevementId === target.id).map(zone => zone.zoneId)
    if (inventory.zones.some(zone => zone.pointPrelevementId === source.id && !targetZones.includes(zone.zoneId))) block('POINT_ZONES_REQUIRE_REVIEW', {id: source.id})
    actions.merges.push(merge)
    for (const pair of merge.exploitationMerges) {
      const from = exploitationById.get(pair.sourceId)
      const to = exploitationById.get(pair.targetId)
      if (!from || !to || from.pointPrelevementId !== source.id || to.pointPrelevementId !== target.id) {
        block('EXPLOITATION_MERGE_OUTSIDE_POINT_PAIR', {id: pair.sourceId})
        continue
      }
      if (from.declarantUserId !== to.declarantUserId) block('EXPLOITATION_OWNER_CHANGE_REQUIRES_EXPLICIT_RETIREMENT', {id: from.id})
      if (!to.sourceId?.startsWith(EXPLOITATION_PREFIX)) block('EXPLOITATION_MERGE_TARGET_OUTSIDE_DROPT', {id: to.id})
      const fields = ['countingCode', 'usageId', 'status', 'startDate', 'endDate', 'comment', 'abandonReason']
      if (fields.some(field => !sameScalar(from, to, field))) block('EXPLOITATION_MERGE_NOT_EQUIVALENT', {id: from.id})
      actions.mergeExploitations.push(pair)
    }
    for (const item of sourceExploitations) {
      if (merge.exploitationMerges.some(pair => pair.sourceId === item.id) || plan.retireExploitationIds.includes(item.id)) continue
      actions.moveExploitations.push({id: item.id, targetPointId: target.id})
    }
  }
  for (const id of plan.retirePointIds) {
    const point = pointById.get(id)
    if (!checkPoint(point, id)) continue
    if (point.deletedAt) {
      if (!retirementFor(inventory.references, id) || inventory.exploitations.some(item => item.pointPrelevementId === id)) block('POINT_ALREADY_DELETED_OUTSIDE_PLAN', {id})
    } else {
      actions.retirePointIds.push(id)
      actions.retireExploitationIds.push(...inventory.exploitations.filter(item => item.pointPrelevementId === id).map(item => item.id))
    }
  }
  for (const id of plan.retireExploitationIds) {
    if (exploitationById.has(id)) actions.retireExploitationIds.push(id)
    else if (!retirementFor(inventory.references, `exploitation:${id}`)) block('EXPLOITATION_MISSING', {id})
  }
  actions.retireExploitationIds = unique(actions.retireExploitationIds)
  const changedExploitationIds = unique([...actions.moveExploitations.map(item => item.id),
    ...actions.mergeExploitations.map(item => item.sourceId), ...actions.retireExploitationIds])
  const changingPoints = [...actions.merges.map(item => item.sourcePointId), ...actions.retirePointIds]
  for (const id of changedExploitationIds) {
    if (!exploitationById.get(id)?.sourceId?.startsWith(EXPLOITATION_PREFIX)) block('EXPLOITATION_OUTSIDE_DROPT_IMPORT', {id})
  }
  for (const [key, field] of [['documents', 'declarantPointPrelevementId'], ['documentLinks', 'declarantPointPrelevementId'],
    ['rules', 'declarantPointPrelevementId'], ['connectors', 'declarantPointPrelevementId'], ['responses', 'exploitationId']]) {
    const count = inventory[key].filter(item => changedExploitationIds.includes(item[field])).length
    if (count) block(`DEPENDENCY_${key.toUpperCase()}`, {count})
  }
  const retiredAccess = inventory.collecteurs.filter(item => actions.retireExploitationIds.includes(item.exploitationId))
  const retiredUsages = inventory.secondaryUsages.filter(item => actions.retireExploitationIds.includes(item.exploitationId))
  if (retiredUsages.length) block('RETIRED_EXPLOITATION_SECONDARY_USAGES_WITHOUT_REPLACEMENT', {count: retiredUsages.length})
  for (const meterId of plan.resetMeterIds) {
    if (!inventory.meters.some(item => item.id === meterId)) block('RESET_METER_MISSING', {id: meterId})
    const references = inventory.references.filter(item => item.compteurId === meterId)
    if (!references.some(item => item.scope === SCOPE && item.kind === 'METER' && ['epidropt', 'rives-et-eaux'].includes(item.provider))) block('RESET_METER_PROVENANCE_MISSING', {id: meterId})
    if (references.some(item => !isResetMarker(item)
      && (item.scope !== SCOPE || item.kind !== 'METER' || !['epidropt', 'rives-et-eaux'].includes(item.provider)))) block('RESET_METER_FOREIGN_REFERENCE', {id: meterId})
    const marker = resetFor(inventory.references, meterId, planHash)
    if (marker) {
      if (marker.compteurId !== meterId || !isResetMarker(marker)) block('RESET_METER_MARKER_CONFLICT', {id: meterId})
      const allocations = inventory.allocations.filter(item => item.compteurId === meterId)
      const allocationIds = ids(allocations)
      // A replay never deletes freshly reimported volumes or newly activated
      // allocations under an old approval. A different reviewed plan is needed.
      if (inventory.streams.some(item => item.compteurId === meterId && (item.enabled || item.activatedAt))
        || inventory.publications.some(item => item.compteurId === meterId)
        || inventory.versions.some(item => allocationIds.includes(item.allocationId) && (item.enabled || item.startDate || item.endDate))) {
        block('RESET_METER_ALREADY_RESET_STATE_CHANGED', {id: meterId})
      }
      if (allocations.some(item => changedExploitationIds.includes(item.exploitationId))) block('RESET_METER_REPLAY_CONFLICTING_ACTION', {id: meterId})
    } else actions.resetMeterIds.push(meterId)
  }
  const affectedAllocations = inventory.allocations.filter(item => changedExploitationIds.includes(item.exploitationId) || actions.resetMeterIds.includes(item.compteurId))
  const meterIds = unique([...affectedAllocations.map(item => item.compteurId), ...actions.resetMeterIds])
  const publications = inventory.publications.filter(item => meterIds.includes(item.compteurId))
  const publicationIds = ids(publications)
  const sourceIds = publications.map(item => item.sourceId)
  if (publications.length && !plan.discardMeterVolumes) block('METER_VOLUME_DELETION_NOT_AUTHORIZED', {count: publications.length})
  if (affectedAllocations.some(item => item.scope !== SCOPE || !['epidropt', 'rives-et-eaux'].includes(item.provider))) block('ALLOCATION_OUTSIDE_DROPT_IMPORT')
  const allResetAllocations = inventory.allocations.filter(item => plan.resetMeterIds.includes(item.compteurId))
  if (allResetAllocations.some(item => item.scope !== SCOPE || !['epidropt', 'rives-et-eaux'].includes(item.provider))) block('ALLOCATION_OUTSIDE_DROPT_IMPORT')
  const allResetAllocationIds = ids(allResetAllocations)
  const resetAllocationIds = inventory.allocations.filter(item => actions.resetMeterIds.includes(item.compteurId)).map(item => item.id)
  if (inventory.versions.some(item => allResetAllocationIds.includes(item.allocationId) && Object.hasOwn(item.metadata ?? {}, 'allocationEdit'))) block('RESET_METER_MANUAL_ALLOCATION_EDIT')
  if (inventory.streams.some(item => [...meterIds, ...plan.resetMeterIds].includes(item.compteurId) && (item.scope !== SCOPE || item.provider !== 'rives-et-eaux'))) block('METER_STREAM_OUTSIDE_DROPT_IMPORT')
  const removedChunks = inventory.chunks.filter(item => sourceIds.includes(item.sourceId))
  const scopeChunks = inventory.chunks.filter(item => changingPoints.includes(item.pointPrelevementId)
    || changedExploitationIds.includes(item.exploitationId))
  if (scopeChunks.some(item => item.calculationStrategy !== 'METER' || !sourceIds.includes(item.sourceId))) block('ORDINARY_OR_UNTRACKED_CHUNK_HISTORY')
  if (removedChunks.some(item => item.calculationStrategy !== 'METER' || !meterIds.includes(item.compteurId)
    || item.instructedByInstructorUserId || item.instructionComment || item.submittedByDeclarantUserId || item.collecteurUserId)) block('PUBLICATION_HAS_MANUAL_OR_FOREIGN_DATA')
  if (inventory.sources.filter(item => sourceIds.includes(item.id)).some(item => item.type !== 'API' || item.declarationId || item.apiImportId)) block('PUBLICATION_SOURCE_NOT_DERIVED')
  if (sourceIds.some(id => !inventory.sources.some(source => source.id === id))) block('PUBLICATION_SOURCE_MISSING')
  if (inventory.replacements.some(item => changingPoints.includes(item.pointPrelevementId)
    || sourceIds.includes(item.replacedSourceId) || sourceIds.includes(item.replacementSourceId))) block('ORDINARY_REPLACEMENT_HISTORY')
  // Report an obvious collision before relying on the database period guards.
  const nextExploitations = inventory.exploitations.filter(item => !actions.retireExploitationIds.includes(item.id)
    && !actions.mergeExploitations.some(pair => pair.sourceId === item.id)).map(item => ({...item,
    pointPrelevementId: actions.moveExploitations.find(move => move.id === item.id)?.targetPointId ?? item.pointPrelevementId}))
  for (const move of actions.moveExploitations) {
    const item = nextExploitations.find(row => row.id === move.id)
    if (!item || !['EN_ACTIVITE', 'NON_RENSEIGNE'].includes(item.status)) continue
    if (nextExploitations.some(other => other.id !== item.id && other.declarantUserId === item.declarantUserId
      && other.pointPrelevementId === item.pointPrelevementId && ['EN_ACTIVITE', 'NON_RENSEIGNE'].includes(other.status)
      && (!item.countingCode || !other.countingCode || item.countingCode === other.countingCode)
      && (!item.endDate || !other.startDate || new Date(item.endDate) >= new Date(other.startDate))
      && (!other.endDate || !item.startDate || new Date(other.endDate) >= new Date(item.startDate)))) block('EXPLOITATION_PERIOD_COLLISION', {id: item.id})
  }
  const contributions = inventory.contributions.filter(item => publicationIds.includes(item.publicationId))
  const affectedVersionIds = inventory.versions.filter(item => ids(affectedAllocations).includes(item.allocationId)).map(item => item.id)
  if (inventory.contributions.some(item => affectedVersionIds.includes(item.allocationVersionId) && !publicationIds.includes(item.publicationId))) block('ALLOCATION_CONTRIBUTION_OUTSIDE_SCOPE')
  if (contributions.some(item => {
    const value = inventory.values.find(value => value.id === item.chunkValueId)
    const chunk = value && inventory.chunks.find(chunk => chunk.id === value.chunkId)
    return !chunk || chunk.sourceId !== publications.find(publication => publication.id === item.publicationId)?.sourceId
  })) block('PUBLICATION_CONTRIBUTION_OUTSIDE_SOURCE')
  const removedChunkIds = ids(removedChunks)
  return {
    operation: 'consolidate-reviewed', scope: SCOPE, planHash, stateHash: digest(json(inventory)),
    complete: blocked.length === 0, blocked, warnings, actions, meterIds, publicationIds, sourceIds,
    allocationIds: ids(affectedAllocations), changedExploitationIds,
    counts: {pointsMerged: actions.merges.length, pointsRetired: actions.retirePointIds.length,
      exploitationsMoved: actions.moveExploitations.length, exploitationsMerged: actions.mergeExploitations.length,
      exploitationsRetired: actions.retireExploitationIds.length, metersPaused: meterIds.length,
      collectorLinksDeleted: retiredAccess.length, metersReset: actions.resetMeterIds.length,
      metersResetAlreadyApplied: plan.resetMeterIds.length - actions.resetMeterIds.length,
      allocationsReset: resetAllocationIds.length,
      allocationVersionsReset: inventory.versions.filter(item => resetAllocationIds.includes(item.allocationId)).length,
      publicationsDeleted: publications.length, chunksDeleted: removedChunks.length,
      valuesDeleted: inventory.values.filter(item => removedChunkIds.includes(item.chunkId)).length,
      contributionsDeleted: contributions.length, attributedVolumeDeleted: decimalVolume(contributions.map(item => item.volume))}
  }
}

async function rawFingerprint(tx, table, predicate, parameters) {
  const [result] = await tx.$queryRawUnsafe(`SELECT count(*)::int AS count,
    md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t.id), '')) AS hash
    FROM "${table}" t WHERE ${predicate}`, ...parameters)
  return result
}

async function protectedFingerprints(tx, meterIds, ownerIds) {
  const result = {}
  for (const [table, predicate, parameters] of [
    ['Compteur', 't.id = ANY($1::uuid[])', [meterIds]],
    ['MeterReading', 't."compteurId" = ANY($1::uuid[])', [meterIds]],
    ['MeterReadingRevision', 't."readingId" IN (SELECT id FROM "MeterReading" WHERE "compteurId" = ANY($1::uuid[]))', [meterIds]],
    ['MeterIngestion', 't.id IN (SELECT r."ingestionId" FROM "MeterReadingRevision" r JOIN "MeterReading" m ON m.id = r."readingId" WHERE m."compteurId" = ANY($1::uuid[]))', [meterIds]],
    ['User', 't.id = ANY($1::uuid[])', [ownerIds]]
  ]) result[table] = await rawFingerprint(tx, table, predicate, parameters)
  return result
}

async function loadInventory(tx, plan) {
  const inventory = emptyInventory()
  const explicitlyRetired = await tx.declarantPointPrelevement.findMany({where: {id: inIds(plan.retireExploitationIds)}})
  let pointIds = unique([...plan.merges.flatMap(item => [item.sourcePointId, item.targetPointId]),
    ...plan.retirePointIds, ...explicitlyRetired.map(item => item.pointPrelevementId)])
  inventory.points = await tx.pointPrelevement.findMany({where: {id: inIds(pointIds)}, orderBy: {id: 'asc'}})
  inventory.coordinates = await tx.$queryRaw`SELECT id, ST_X(coordinates) AS x, ST_Y(coordinates) AS y FROM "PointPrelevement" WHERE id = ANY(${pointIds}::uuid[]) ORDER BY id`
  inventory.exploitations = await tx.declarantPointPrelevement.findMany({where: {pointPrelevementId: inIds(pointIds)}, orderBy: {id: 'asc'}})
  const changingPoints = [...plan.merges.map(item => item.sourcePointId), ...plan.retirePointIds]
  const changedIds = unique([...plan.retireExploitationIds, ...inventory.exploitations.filter(item => changingPoints.includes(item.pointPrelevementId)).map(item => item.id)])
  const initialAllocations = await tx.meterAllocation.findMany({where: {exploitationId: inIds(changedIds)}})
  const meterIds = unique([...initialAllocations.map(item => item.compteurId), ...plan.resetMeterIds])
  inventory.meters = await tx.compteur.findMany({where: {id: inIds(meterIds)}, select: {id: true}, orderBy: {id: 'asc'}})
  inventory.allocations = await tx.meterAllocation.findMany({where: {compteurId: inIds(meterIds)}, orderBy: {id: 'asc'}})
  const otherExploitations = await tx.declarantPointPrelevement.findMany({where: {id: inIds(unique(inventory.allocations.map(item => item.exploitationId))), pointPrelevementId: {notIn: pointIds}}, orderBy: {id: 'asc'}})
  inventory.exploitations.push(...otherExploitations)
  inventory.exploitations.sort((a, b) => a.id.localeCompare(b.id))
  const missingPointIds = unique(otherExploitations.map(item => item.pointPrelevementId).filter(id => !pointIds.includes(id)))
  if (missingPointIds.length) {
    pointIds = unique([...pointIds, ...missingPointIds])
    inventory.points.push(...await tx.pointPrelevement.findMany({where: {id: inIds(missingPointIds)}, orderBy: {id: 'asc'}}))
    inventory.points.sort((a, b) => a.id.localeCompare(b.id))
    inventory.coordinates = await tx.$queryRaw`SELECT id, ST_X(coordinates) AS x, ST_Y(coordinates) AS y FROM "PointPrelevement" WHERE id = ANY(${pointIds}::uuid[]) ORDER BY id`
  }
  const allExploitationIds = ids(inventory.exploitations)
  inventory.zones = await tx.pointPrelevementZone.findMany({where: {pointPrelevementId: inIds(pointIds)}, orderBy: {id: 'asc'}})
  inventory.references = await tx.externalReference.findMany({where: {OR: [{pointPrelevementId: inIds(pointIds)}, {compteurId: inIds(meterIds)},
    {scope: SCOPE, provider: {in: [ALIAS_PROVIDER, RETIREMENT_PROVIDER]}, externalId: {in: [...pointIds, ...plan.retireExploitationIds.map(id => `exploitation:${id}`)]}},
    {scope: SCOPE, provider: RESET_PROVIDER, kind: 'METER', externalId: inIds(plan.resetMeterIds.map(id => `${digest(plan)}:${id}`))}]}, orderBy: {id: 'asc'}})
  for (const [key, model, where] of [
    ['versions', 'meterAllocationVersion', {allocationId: inIds(ids(inventory.allocations))}],
    ['streams', 'meterStream', {compteurId: inIds(meterIds)}],
    ['publications', 'meterPublication', {compteurId: inIds(meterIds)}],
    ['documents', 'resourceDocument', {declarantPointPrelevementId: inIds(changedIds)}],
    ['documentLinks', 'resourceDocumentExploitation', {declarantPointPrelevementId: inIds(changedIds)}],
    ['rules', 'resourceRuleExploitation', {declarantPointPrelevementId: inIds(changedIds)}],
    ['connectors', 'declarantPointPrelevementConnector', {declarantPointPrelevementId: inIds(changedIds)}],
    ['responses', 'collectionResponse', {exploitationId: inIds(changedIds)}],
    ['collecteurs', 'declarantCollecteurExploitation', {exploitationId: inIds(allExploitationIds)}]
  ]) inventory[key] = await tx[model].findMany({where, orderBy: {id: 'asc'}})
  inventory.secondaryUsages = await tx.declarantPointPrelevementSecondaryUsage.findMany({where: {exploitationId: inIds(allExploitationIds)}, orderBy: [{exploitationId: 'asc'}, {usageId: 'asc'}]})
  const sourceIds = inventory.publications.map(item => item.sourceId)
  inventory.sources = await tx.source.findMany({where: {id: inIds(sourceIds)}, orderBy: {id: 'asc'}})
  inventory.chunks = await tx.chunk.findMany({where: {OR: [{pointPrelevementId: inIds(pointIds)}, {exploitationId: inIds(changedIds)}, {sourceId: inIds(sourceIds)}]}, orderBy: {id: 'asc'}})
  inventory.values = await tx.chunkValue.findMany({where: {chunkId: inIds(ids(inventory.chunks))}, orderBy: {id: 'asc'}})
  inventory.contributions = await tx.meterVolumeContribution.findMany({where: {OR: [{publicationId: inIds(ids(inventory.publications))}, {allocationVersionId: inIds(ids(inventory.versions))}]}, orderBy: {id: 'asc'}})
  inventory.replacements = await tx.chunkValueReplacement.findMany({where: {OR: [{pointPrelevementId: inIds(pointIds)}, {replacedSourceId: inIds(sourceIds)}, {replacementSourceId: inIds(sourceIds)}]}, orderBy: {id: 'asc'}})
  inventory.protected = await protectedFingerprints(tx, meterIds, unique(inventory.exploitations.map(item => item.declarantUserId)))
  return inventory
}

export async function inspectReviewedConsolidation(tx, plan, {target} = {}) {
  await assertRebuildTarget(tx, target)
  plan = normalizeReviewedConsolidationPlan(plan)
  return planReviewedConsolidation(plan, await loadInventory(tx, plan))
}

async function marker(tx, {provider, externalId, pointPrelevementId, metadata}) {
  const identity = {provider, scope: SCOPE, kind: 'POINT', externalId}
  const existing = await tx.externalReference.findUnique({where: {provider_scope_kind_externalId: identity}})
  requireCondition(!existing || existing.pointPrelevementId === pointPrelevementId, 'CONSOLIDATION_MARKER_CONFLICT')
  if (!existing) await tx.externalReference.create({data: {id: stableId(`reviewed:${provider}:${externalId}`), ...identity, pointPrelevementId, metadata: json(metadata)}})
}

// The caller MUST keep this inside its dry-run/apply transaction. This function
// neither opens nor commits a transaction, never reprocesses or enables streams.
export async function consolidateReviewedInTransaction(tx, plan, {target, expectedReport} = {}) {
  await assertRebuildTarget(tx, target)
  plan = normalizeReviewedConsolidationPlan(plan)
  requireCondition(expectedReport?.operation === 'consolidate-reviewed' && expectedReport.complete
    && expectedReport.planHash === digest(plan) && expectedReport.stateHash, 'CONSOLIDATION_APPROVED_PLAN_REQUIRED')
  await tx.$executeRaw`SET LOCAL lock_timeout = '10s'`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dropt-referential'), hashtext(${SCOPE}))`
  const beforeLocks = await loadInventory(tx, plan)
  const lockedMeters = unique([...beforeLocks.allocations.map(item => item.compteurId), ...plan.resetMeterIds])
  for (const id of lockedMeters) await lockMeter(tx, id)
  await tx.$queryRaw`SELECT id FROM "Compteur" WHERE id = ANY(${lockedMeters}::uuid[]) ORDER BY id FOR UPDATE`
  const pointIds = unique([...ids(beforeLocks.points), ...beforeLocks.exploitations.map(item => item.pointPrelevementId)])
  for (const id of pointIds) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('volumes-from-index'), hashtext(${id}))`
  await tx.$queryRaw`SELECT id FROM "PointPrelevement" WHERE id = ANY(${pointIds}::uuid[]) ORDER BY id FOR UPDATE`
  await tx.$queryRaw`SELECT id FROM "DeclarantPointPrelevement" WHERE "pointPrelevementId" = ANY(${pointIds}::uuid[]) ORDER BY id FOR UPDATE`
  const exploitationIds = ids(beforeLocks.exploitations)
  const sourceIds = unique(beforeLocks.publications.map(item => item.sourceId))
  // Parent row locks stop new FK dependants; these locks also protect edits or
  // deletes of already-existing links, including writers without advisory locks.
  for (const [table, predicate, values, orderBy] of [
    ['ExternalReference', '"pointPrelevementId" = ANY($1::uuid[])', pointIds, 'id'],
    ['ExternalReference', '"compteurId" = ANY($1::uuid[])', lockedMeters, 'id'],
    ['MeterAllocation', '"compteurId" = ANY($1::uuid[])', lockedMeters, 'id'],
    ['MeterAllocationVersion', '"allocationId" IN (SELECT id FROM "MeterAllocation" WHERE "compteurId" = ANY($1::uuid[]))', lockedMeters, 'id'],
    ['MeterStream', '"compteurId" = ANY($1::uuid[])', lockedMeters, 'id'],
    ['MeterPublication', '"compteurId" = ANY($1::uuid[])', lockedMeters, 'id'],
    ['Source', 'id = ANY($1::uuid[])', sourceIds, 'id'],
    ['Chunk', '"sourceId" = ANY($1::uuid[])', sourceIds, 'id'],
    ['ChunkValue', '"chunkId" IN (SELECT id FROM "Chunk" WHERE "sourceId" = ANY($1::uuid[]))', sourceIds, 'id'],
    ['DeclarantCollecteurExploitation', '"exploitationId" = ANY($1::uuid[])', exploitationIds, 'id'],
    ['DeclarantPointPrelevementSecondaryUsage', '"exploitationId" = ANY($1::uuid[])', exploitationIds, '"exploitationId", "usageId"']
  ]) await tx.$queryRawUnsafe(`SELECT 1 FROM "${table}" WHERE ${predicate} ORDER BY ${orderBy} FOR UPDATE`, values)
  const inventory = await loadInventory(tx, plan)
  requireCondition(inventory.allocations.every(item => lockedMeters.includes(item.compteurId)), 'CONSOLIDATION_SCOPE_CHANGED_RETRY')
  const report = planReviewedConsolidation(plan, inventory)
  requireCondition(report.complete, `CONSOLIDATION_BLOCKED:${unique(report.blocked.map(item => item.code)).join(',')}`)
  requireCondition(report.stateHash === expectedReport.stateHash, 'CONSOLIDATION_STATE_CHANGED_SINCE_REVIEW')
  const {actions} = report
  const byId = new Map(inventory.exploitations.map(item => [item.id, item]))
  const mergeTargets = new Map(actions.mergeExploitations.map(item => [item.sourceId, item.targetId]))
  const retiredIds = new Set(actions.retireExploitationIds)
  if (report.meterIds.length) await tx.meterStream.updateMany({where: {compteurId: inIds(report.meterIds)}, data: {enabled: false}})
  if (actions.resetMeterIds.length) await tx.meterStream.updateMany({where: {compteurId: inIds(actions.resetMeterIds)},
    data: {enabled: false, activatedAt: null, allocationSnapshotValidated: false, allocationSnapshot: []}})
  await tx.meterVolumeContribution.deleteMany({where: {publicationId: inIds(report.publicationIds)}})
  await tx.meterPublication.deleteMany({where: {id: inIds(report.publicationIds)}})
  // Source deletion cascades only to the METER chunks/values proven above.
  await tx.source.deleteMany({where: {id: inIds(report.sourceIds)}})
  const allocations = inventory.allocations.filter(item => report.allocationIds.includes(item.id))
  const versions = inventory.versions.filter(item => report.allocationIds.includes(item.allocationId))
  await tx.meterAllocationVersion.deleteMany({where: {allocationId: inIds(report.allocationIds)}})
  await tx.meterAllocation.deleteMany({where: {id: inIds(report.allocationIds)}})
  for (const pair of actions.mergeExploitations) {
    const from = byId.get(pair.sourceId)
    const to = byId.get(pair.targetId)
    const collectors = inventory.collecteurs.filter(item => item.exploitationId === from.id)
    for (const link of collectors) {
      const existing = inventory.collecteurs.find(item => item.exploitationId === to.id && item.collecteurUserId === link.collecteurUserId)
      if (existing) await tx.declarantCollecteurExploitation.delete({where: {id: link.id}})
      else {
        await tx.declarantCollecteurExploitation.update({where: {id: link.id}, data: {exploitationId: to.id}})
        link.exploitationId = to.id
      }
    }
    const secondary = inventory.secondaryUsages.filter(item => item.exploitationId === from.id)
    if (secondary.length) await tx.declarantPointPrelevementSecondaryUsage.createMany({data: secondary.map(item => ({...item, exploitationId: to.id})), skipDuplicates: true})
    const oldPointName = inventory.points.find(point => point.id === from.pointPrelevementId)?.name
    const aliases = unique([...(to.pointPrelevementNameAliases ?? []), ...(from.pointPrelevementNameAliases ?? []), oldPointName].filter(Boolean))
    await tx.declarantPointPrelevement.update({where: {id: to.id}, data: {pointPrelevementNameAliases: aliases}})
    to.pointPrelevementNameAliases = aliases
  }
  for (const id of actions.retireExploitationIds) {
    const row = byId.get(id)
    await marker(tx, {provider: RETIREMENT_PROVIDER, externalId: `exploitation:${id}`, pointPrelevementId: row.pointPrelevementId,
      metadata: {planHash: report.planHash, sourceId: row.sourceId, retiredExploitationId: id}})
  }
  await tx.declarantPointPrelevement.deleteMany({where: {id: inIds([...mergeTargets.keys(), ...retiredIds])}})
  for (const move of actions.moveExploitations) {
    const row = byId.get(move.id)
    const oldPointName = inventory.points.find(point => point.id === row.pointPrelevementId)?.name
    await tx.declarantPointPrelevement.update({where: {id: move.id}, data: {pointPrelevementId: move.targetPointId,
      pointPrelevementNameAliases: unique([...(row.pointPrelevementNameAliases ?? []), oldPointName].filter(Boolean))}})
  }
  const restoredAllocations = allocations.filter(item => !retiredIds.has(item.exploitationId) && !actions.resetMeterIds.includes(item.compteurId))
    .map(item => ({...item, exploitationId: mergeTargets.get(item.exploitationId) ?? item.exploitationId}))
  if (restoredAllocations.length) await tx.meterAllocation.createMany({data: restoredAllocations})
  const restoredIds = ids(restoredAllocations)
  const restoredVersions = versions.filter(item => restoredIds.includes(item.allocationId))
  if (restoredVersions.length) await tx.meterAllocationVersion.createMany({data: restoredVersions})
  const now = new Date()
  for (const merge of actions.merges) {
    const source = inventory.points.find(item => item.id === merge.sourcePointId)
    for (const reference of inventory.references.filter(item => item.pointPrelevementId === source.id)) {
      await tx.externalReference.update({where: {id: reference.id}, data: {pointPrelevementId: merge.targetPointId,
        metadata: {...(reference.metadata ?? {}), mergedFromPointId: reference.metadata?.mergedFromPointId ?? source.id}}})
    }
    await marker(tx, {provider: ALIAS_PROVIDER, externalId: source.id, pointPrelevementId: merge.targetPointId,
      metadata: {planHash: report.planHash, mergedAt: now, previousName: source.name, previousSourceId: source.sourceId,
        exploitationAliases: merge.exploitationMerges.map(pair => ({...pair, sourceSourceId: byId.get(pair.sourceId).sourceId}))}})
    await tx.pointPrelevementZone.deleteMany({where: {pointPrelevementId: source.id}})
    await tx.pointPrelevement.update({where: {id: source.id}, data: {deletedAt: now, name: `merged:${source.id}`}})
  }
  for (const id of actions.retirePointIds) {
    const source = inventory.points.find(item => item.id === id)
    await marker(tx, {provider: RETIREMENT_PROVIDER, externalId: id, pointPrelevementId: id,
      metadata: {planHash: report.planHash, retiredAt: now, previousName: source.name, previousSourceId: source.sourceId}})
    await tx.pointPrelevementZone.deleteMany({where: {pointPrelevementId: id}})
    await tx.pointPrelevement.update({where: {id}, data: {deletedAt: now, name: `retired:${id}`}})
  }
  const protectedAfter = await protectedFingerprints(tx, lockedMeters, unique(inventory.exploitations.map(item => item.declarantUserId)))
  requireCondition(digest(protectedAfter) === digest(inventory.protected), 'CONSOLIDATION_PROTECTED_DATA_CHANGED')
  // This ledger commits only if the caller's subsequent manifest import also
  // commits. Replaying the same reviewed plan must keep the recreated versions.
  for (const compteurId of actions.resetMeterIds) {
    const externalId = `${report.planHash}:${compteurId}`
    await tx.externalReference.create({data: {id: stableId(`reviewed:${RESET_PROVIDER}:${externalId}`),
      provider: RESET_PROVIDER, scope: SCOPE, kind: 'METER', externalId, compteurId,
      metadata: {planHash: report.planHash, resetAt: now.toISOString()}}})
  }
  return {...report, appliedInTransaction: true, protectedDataPreserved: true}
}
