import {digest, stableId} from './epidropt.js'
import {validateLoisirsManifest} from './loisirs-source.js'

const provider = 'pe-import-loisirs'
const journalKey = record => `exploitation:${record.sourceId}`

// Read only the selected identities. Auth secrets are neither needed nor read.
export async function readLoisirsState(client, manifest) {
  validateLoisirsManifest(manifest)
  const pointIds = manifest.points.map(row => row.id)
  const ownerIds = manifest.declarants.map(row => row.id)
  const exploitationIds = manifest.exploitations.map(row => row.id)
  const sourceIds = manifest.exploitations.map(row => row.sourceId)
  const rows = async (sql, values) => (await client.query(sql, values)).rows.map(row => row.row)
  const tables = {}
  tables.PointPrelevement = await rows('SELECT to_jsonb(t) AS row FROM "PointPrelevement" t WHERE id=ANY($1::uuid[]) ORDER BY id', [pointIds])
  tables.Declarant = await rows('SELECT to_jsonb(t) AS row FROM "Declarant" t WHERE "userId"=ANY($1::uuid[]) ORDER BY "userId"', [ownerIds])
  tables.User = await rows('SELECT jsonb_build_object(\'id\',id,\'role\',role,\'deletedAt\',"deletedAt",\'quickLoginConfigured\',email IS NOT NULL) AS row FROM "User" WHERE id=ANY($1::uuid[]) ORDER BY id', [ownerIds])
  tables.DeclarantPointPrelevement = await rows('SELECT to_jsonb(t) AS row FROM "DeclarantPointPrelevement" t WHERE "pointPrelevementId"=ANY($1::uuid[]) OR "declarantUserId"=ANY($2::uuid[]) OR id=ANY($3::uuid[]) OR "sourceId"=ANY($4::text[]) ORDER BY id', [pointIds, ownerIds, exploitationIds, sourceIds])
  tables.ExternalReference = await rows('SELECT to_jsonb(t) AS row FROM "ExternalReference" t WHERE "pointPrelevementId"=ANY($1::uuid[]) OR "declarantUserId"=ANY($2::uuid[]) OR (provider=$3 AND scope=\'epidropt\' AND "externalId"=ANY($4::text[])) OR (scope=\'epidropt\' AND ((kind=\'POINT\' AND "externalId"=ANY($5::text[])) OR (kind=\'DECLARANT\' AND "externalId"=ANY($6::text[])))) ORDER BY id', [pointIds, ownerIds, provider, manifest.exploitations.map(journalKey), manifest.points.flatMap(row => row.references.map(ref => ref.externalId)), manifest.declarants.flatMap(row => row.references.map(ref => ref.externalId))])
  tables.PointPrelevementZone = await rows('SELECT to_jsonb(t) AS row FROM "PointPrelevementZone" t WHERE "pointPrelevementId"=ANY($1::uuid[]) ORDER BY id', [pointIds])
  tables.DeclarantZone = await rows('SELECT to_jsonb(t) AS row FROM "DeclarantZone" t WHERE "declarantUserId"=ANY($1::uuid[]) ORDER BY id', [ownerIds])
  tables.SandreWaterUse = await rows('SELECT to_jsonb(t) AS row FROM "SandreWaterUse" t WHERE code=\'7\' ORDER BY id')
  const allIds = [...new Set([...exploitationIds, ...tables.DeclarantPointPrelevement.map(row => row.id)])]
  for (const table of ['DeclarantCollecteurExploitation', 'CollectionResponse', 'DeclarantPointPrelevementConnector', 'MeterAllocation', 'DeclarantPointPrelevementSecondaryUsage']) {
    const field = table === 'DeclarantPointPrelevementConnector' ? 'declarantPointPrelevementId' : 'exploitationId'
    const order = table === 'DeclarantPointPrelevementSecondaryUsage' ? '"exploitationId","usageId"' : 'id'
    tables[table] = await rows(`SELECT to_jsonb(t) AS row FROM "${table}" t WHERE "${field}"=ANY($1::uuid[]) ORDER BY ${order}`, [allIds])
  }
  return {tables, stateHash: digest(tables)}
}

function validPoint(current, point) {
  return current && !current.deletedAt && current.sourceId === point.sourceId && current.collectionMode !== 'EXTERNAL'
    && current.waterBodyType === point.data.waterBodyType
}

function validOwner(current, user, owner) {
  return current && current.sourceId === owner.sourceId && current.siret === owner.data.siret
    && current.declarantType === 'LEGAL_PERSON' && current.declarantRole === 'PRELEVEUR'
    && current.quickDeclarationEnabled === true && user && !user.deletedAt && user.role === 'DECLARANT'
}

function validReferences(tables, record, kind, field) {
  return record.references.every(reference => {
    const matches = tables.ExternalReference.filter(row => row.provider === reference.provider && row.scope === 'epidropt'
      && row.kind === kind && row.externalId === reference.externalId)
    return matches.length === 1 && matches[0][field] === record.id
  })
}

function hasAllZones(tables, record) {
  return tables.PointPrelevementZone.filter(row => row.pointPrelevementId === record.pointId)
    .every(zone => tables.DeclarantZone.some(row => row.declarantUserId === record.declarantId && row.zoneId === zone.zoneId))
}

function matchingExploitation(current, record, usage) {
  return current.id === record.id && current.sourceId === record.sourceId
    && current.pointPrelevementId === record.pointId && current.declarantUserId === record.declarantId
    && current.usageId === usage?.id && ['NON_RENSEIGNE', 'EN_ACTIVITE'].includes(current.status)
    && !current.startDate && !current.endDate && (current.countingCode ?? null) === (record.countingCode ?? null)
}

function hasExternalLinks(tables, id) {
  return tables.DeclarantCollecteurExploitation.some(row => row.exploitationId === id)
    || tables.DeclarantPointPrelevementConnector.some(row => row.declarantPointPrelevementId === id)
    || tables.MeterAllocation.some(row => row.exploitationId === id)
}

function matchingJournal(journal, current, record, manifest) {
  return journal.kind === 'POINT' && journal.pointPrelevementId === record.pointId
    && journal.metadata?.exploitationId === record.id && journal.metadata?.manifestHash === manifest.manifestHash
    && current && !current.excludeFromQuickDeclaration
}

function appendInitialChanges(changes, tables, current, record, {usage, manifest}) {
  if (!current) changes.push({action: 'CREATE_EXPLOITATION', id: record.id, sourceId: record.sourceId,
    pointPrelevementId: record.pointId, declarantUserId: record.declarantId, usageId: usage?.id,
    countingCode: record.countingCode ?? null, aliases: record.aliases ?? []})
  else if (current.excludeFromQuickDeclaration) changes.push({action: 'ENABLE_QUICK_DECLARATION', id: record.id})
  for (const zone of tables.PointPrelevementZone.filter(row => row.pointPrelevementId === record.pointId)) {
    if (!tables.DeclarantZone.some(row => row.declarantUserId === record.declarantId && row.zoneId === zone.zoneId)
      && !changes.some(row => row.action === 'ADD_ZONE' && row.declarantUserId === record.declarantId && row.zoneId === zone.zoneId)) {
      changes.push({action: 'ADD_ZONE', id: stableId(`loisirs-zone:${record.declarantId}:${zone.zoneId}`), declarantUserId: record.declarantId, zoneId: zone.zoneId})
    }
  }
  changes.push({action: 'JOURNAL', id: stableId(`loisirs-journal:${record.sourceId}`), pointPrelevementId: record.pointId,
    externalId: journalKey(record), metadata: {exploitationId: record.id, manifestHash: manifest.manifestHash,
      createdExploitation: !current, previousQuickExclusion: current?.excludeFromQuickDeclaration ?? null}})
}

export function planLoisirs(manifest, state) {
  validateLoisirsManifest(manifest)
  const {tables} = state
  const changes = []
  const blocked = []
  const fail = (id, code) => blocked.push({id, code})
  const usage = tables.SandreWaterUse.find(row => row.code === '7' && row.kind === 'USAGE')
  if (!usage || tables.SandreWaterUse.length !== 1) fail(null, 'LOISIRS_USAGE_MISSING')
  for (const point of manifest.points) {
    const current = tables.PointPrelevement.find(row => row.id === point.id)
    if (!validPoint(current, point) || !validReferences(tables, point, 'POINT', 'pointPrelevementId')) fail(point.id, 'LOISIRS_POINT_ANCHOR_REQUIRED')
  }
  for (const owner of manifest.declarants) {
    const current = tables.Declarant.find(row => row.userId === owner.id)
    const user = tables.User.find(row => row.id === owner.id)
    if (!validOwner(current, user, owner) || !validReferences(tables, owner, 'DECLARANT', 'declarantUserId')) fail(owner.id, 'LOISIRS_DECLARANT_ANCHOR_REQUIRED')
  }
  for (const record of manifest.exploitations) {
    const candidates = tables.DeclarantPointPrelevement.filter(row => row.id === record.id || row.sourceId === record.sourceId
      || (row.pointPrelevementId === record.pointId && row.declarantUserId === record.declarantId))
    const current = candidates[0]
    const journal = tables.ExternalReference.find(row => row.provider === provider && row.scope === 'epidropt' && row.externalId === journalKey(record))
    if (candidates.length > 1 || (current && !matchingExploitation(current, record, usage))) {
      fail(record.id, 'LOISIRS_EXPLOITATION_COLLISION')
      continue
    }
    if (hasExternalLinks(tables, record.id)) {
      fail(record.id, 'LOISIRS_EXTERNAL_LINK_REVIEW_REQUIRED')
      continue
    }
    if (journal) {
      if (!matchingJournal(journal, current, record, manifest) || !hasAllZones(tables, record)) fail(record.id, 'LOISIRS_MANUAL_CHANGE_PRESERVED')
      continue
    }
    appendInitialChanges(changes, tables, current, record, {usage, manifest})
  }
  return {changes, blocked, planHash: digest({manifestHash: manifest.manifestHash, changes, blocked})}
}

export async function applyLoisirsPlan(client, plan) {
  if (plan.blocked.length) throw new Error('LOISIRS_PLAN_BLOCKED')
  for (const change of plan.changes) {
    let result
    if (change.action === 'CREATE_EXPLOITATION') {
      // The database multiplicity trigger remains enabled and serializes the pair.
      result = await client.query('INSERT INTO "DeclarantPointPrelevement" (id,"sourceId","pointPrelevementId","declarantUserId","usageId","countingCode","pointPrelevementNameAliases",status,"excludeFromQuickDeclaration","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,\'EN_ACTIVITE\',false,now())', [change.id, change.sourceId, change.pointPrelevementId, change.declarantUserId, change.usageId, change.countingCode, change.aliases])
    } else if (change.action === 'ENABLE_QUICK_DECLARATION') {
      result = await client.query('UPDATE "DeclarantPointPrelevement" SET "excludeFromQuickDeclaration"=false,"updatedAt"=now() WHERE id=$1 AND "excludeFromQuickDeclaration"=true', [change.id])
    } else if (change.action === 'ADD_ZONE') {
      result = await client.query('INSERT INTO "DeclarantZone" (id,"declarantUserId","zoneId",source,"updatedAt") VALUES ($1,$2,$3,\'MIGRATION\',now())', [change.id, change.declarantUserId, change.zoneId])
    } else if (change.action === 'JOURNAL') {
      result = await client.query('INSERT INTO "ExternalReference" (id,provider,scope,kind,"externalId","pointPrelevementId",metadata) VALUES ($1,$2,\'epidropt\',\'POINT\',$3,$4,$5::jsonb)', [change.id, provider, change.externalId, change.pointPrelevementId, JSON.stringify(change.metadata)])
    } else throw new Error('LOISIRS_UNKNOWN_ACTION')
    if (result.rowCount !== 1) throw new Error('LOISIRS_CONCURRENT_CHANGE')
  }
}
