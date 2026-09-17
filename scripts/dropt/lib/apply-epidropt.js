import {lockMeter, reprocessMeterStreamInTransaction} from '../../../lib/services/meter-publication.js'
import {validateAllocationSnapshot} from '../../../lib/services/meter-core.js'
import {digest, stableId, SCOPE, FORMAT_VERSION} from './epidropt.js'

const entityFields = {POINT: 'pointPrelevementId', DECLARANT: 'declarantUserId', METER: 'compteurId'}

async function referenceIdentity(client, record, kind) {
  const field = entityFields[kind]
  const references = await client.externalReference.findMany({where: {scope: SCOPE, kind, OR: record.references.map(ref => ({provider: ref.provider, externalId: ref.externalId}))}})
  const model = {POINT: 'pointPrelevement', DECLARANT: 'declarant', METER: 'compteur'}[kind]
  const idField = kind === 'DECLARANT' ? 'userId' : 'id'
  const candidates = await client[model].findMany({where: {OR: [
    {[idField]: record.id},
    ...(record.sourceId ? [{sourceId: record.sourceId}] : [])
  ]}, select: {[idField]: true}})
  const ids = [...new Set([...references.map(ref => ref[field]), ...candidates.map(candidate => candidate[idField])])]
  if (ids.length > 1) throw new Error('REFERENCES_INCOMPATIBLES')
  return {id: ids[0] ?? record.id, imported: references.find(ref => ref.metadata?.imported)?.metadata.imported}
}

async function recordReferences(client, record, kind, id, imported) {
  for (const ref of record.references) {
    const key = {provider: ref.provider, scope: SCOPE, kind, externalId: ref.externalId}
    const existing = await client.externalReference.findUnique({where: {provider_scope_kind_externalId: key}})
    if (existing && existing[entityFields[kind]] !== id) throw new Error('REFERENCE_DEJA_ATTRIBUEE')
    await client.externalReference.upsert({
      where: {provider_scope_kind_externalId: key},
      create: {id: stableId(`ref:${kind}:${ref.provider}:${ref.externalId}`), ...key, [entityFields[kind]]: id, metadata: {imported}},
      update: {metadata: {...(existing?.metadata ?? {}), imported}}
    })
  }
}

function managedChanges(current, imported, incoming) {
  if (!current) return incoming
  if (!imported) return {}
  return Object.fromEntries(Object.entries(incoming).filter(([key, value]) => digest(current[key] ?? null) === digest(imported[key] ?? null) && digest(current[key] ?? null) !== digest(value)))
}

function sameCoordinates(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === 2 && right.length === 2
    && left.every((value, index) => Number.isFinite(value) && Number.isFinite(right[index]) && Math.abs(value - right[index]) < 1e-10)
}

async function putPoint(client, record) {
  const identity = await referenceIdentity(client, record, 'POINT')
  const existing = await client.pointPrelevement.findUnique({where: {id: identity.id}})
  const sameName = await client.pointPrelevement.findUnique({where: {name: record.data.name}, select: {id: true}})
  if (sameName && sameName.id !== identity.id) throw new Error('NOM_POINT_EXISTANT_A_RAPPROCHER')
  if (existing?.deletedAt) throw new Error('POINT_SUPPRIME')
  const data = managedChanges(existing, identity.imported, record.data)
  if (!existing) await client.pointPrelevement.create({data: {id: identity.id, sourceId: record.sourceId, ...record.data}})
  else if (Object.keys(data).length) await client.pointPrelevement.update({where: {id: identity.id}, data})
  const stored = await client.$queryRaw`SELECT ST_X(coordinates) AS x, ST_Y(coordinates) AS y FROM "PointPrelevement" WHERE id = ${identity.id}::uuid`
  const previousCoordinates = stored[0]?.x == null || stored[0]?.y == null ? null : [stored[0].x, stored[0].y]
  if (!existing || (sameCoordinates(previousCoordinates, identity.imported?.coordinates) && !sameCoordinates(previousCoordinates, record.coordinates))) {
    const [longitude, latitude] = record.coordinates
    await client.$executeRaw`UPDATE "PointPrelevement" SET coordinates = ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326) WHERE id = ${identity.id}::uuid`
    const zones = await client.$queryRaw`SELECT z.id FROM "Zone" z JOIN "PointPrelevement" p ON p.id = ${identity.id}::uuid WHERE ST_Intersects(z.coordinates, p.coordinates)`
    await client.pointPrelevementZone.deleteMany({where: {pointPrelevementId: identity.id}})
    await client.pointPrelevementZone.createMany({data: zones.map(zone => ({pointPrelevementId: identity.id, zoneId: zone.id})), skipDuplicates: true})
  }

  await recordReferences(client, record, 'POINT', identity.id, {...record.data, coordinates: record.coordinates})
  return identity.id
}

async function putDeclarant(client, record) {
  const identity = await referenceIdentity(client, record, 'DECLARANT')
  const existing = await client.declarant.findUnique({where: {userId: identity.id}, include: {user: true}})
  if (existing?.user.deletedAt) throw new Error('PRELEVEUR_SUPPRIME')
  if (!existing && record.data.siret) {
    const matches = await client.declarant.count({where: {siret: record.data.siret}})
    if (matches > 0) throw new Error('SIRET_EXISTANT_A_RAPPROCHER')
  }

  if (!existing) {
    await client.user.create({data: {id: identity.id, ...record.user, declarant: {create: {sourceId: record.sourceId, ...record.data}}}})
  } else {
    const changes = managedChanges(existing, identity.imported, record.data)
    if (Object.keys(changes).length) await client.declarant.update({where: {userId: identity.id}, data: changes})
  }

  for (const email of record.emails) {
    await client.declarantContactEmail.upsert({where: {declarantUserId_email: {declarantUserId: identity.id, email}},
      create: {declarantUserId: identity.id, email, sourceId: `dropt-epidropt:contact:${digest([record.key, email])}`, isPrimary: false}, update: {}})
  }

  await recordReferences(client, record, 'DECLARANT', identity.id, record.data)
  return identity.id
}

async function putExploitation(client, record, pointId, declarantUserId) {
  if (!pointId || !declarantUserId) throw new Error('DEPENDANCE_NON_IMPORTEE')
  const matches = await client.declarantPointPrelevement.findMany({where: {OR: [{id: record.id}, {sourceId: record.sourceId}]}})
  if (matches.length > 1) throw new Error('REFERENCES_INCOMPATIBLES')
  const existing = matches[0]
  const usage = await client.sandreWaterUse.findUnique({where: {code: record.usageCode}})
  if (!usage) throw new Error('USAGE_ABSENT')
  if (existing) {
    if (existing.pointPrelevementId !== pointId || existing.declarantUserId !== declarantUserId) throw new Error('EXPLOITATION_EXISTANTE_DIFFERENTE')
    return existing.id
  }

  const candidates = await client.declarantPointPrelevement.findMany({where: {pointPrelevementId: pointId, declarantUserId, status: {in: ['EN_ACTIVITE', 'NON_RENSEIGNE']}}})
  if (candidates.length) throw new Error('PERIODE_EXPLOITATION_EXISTANTE_A_RAPPROCHER')
  await client.declarantPointPrelevement.create({data: {id: record.id, sourceId: record.sourceId, pointPrelevementId: pointId, declarantUserId, usageId: usage.id,
    status: 'NON_RENSEIGNE', pointPrelevementNameAliases: record.aliases}})
  const zones = await client.pointPrelevementZone.findMany({where: {pointPrelevementId: pointId}, select: {zoneId: true}})
  await client.declarantZone.createMany({data: zones.map(zone => ({declarantUserId, zoneId: zone.zoneId, source: 'MIGRATION'})), skipDuplicates: true})
  return record.id
}

async function putAllocation(client, item, record, compteurId, exploitationIds) {
  const exploitationId = exploitationIds.get(item.exploitationId)
  if (!exploitationId) throw new Error('DEPENDANCE_NON_IMPORTEE')
  const metadata = {contractId: item.contractId ?? null, lieuId: item.lieuId ?? null}
  const allocation = await client.meterAllocation.upsert({where: {sourceId: item.sourceId}, create: {
    id: stableId(item.sourceId), sourceId: item.sourceId, provider: record.provider, scope: SCOPE,
    compteurId, exploitationId, metadata
  }, update: {}})
  if (allocation.compteurId !== compteurId || allocation.exploitationId !== exploitationId
    || allocation.provider !== record.provider || allocation.scope !== SCOPE) throw new Error('AFFECTATION_EXISTANTE_DIFFERENTE')
  if ((allocation.metadata?.contractId ?? null) !== metadata.contractId
    || (allocation.metadata?.lieuId ?? null) !== metadata.lieuId) throw new Error('AFFECTATION_IDENTIFIANTS_DIFFERENTS')
  return allocation
}

function versionMatches(version, desired, metadata, datedCorrection) {
  return version && String(version.percentage ?? '') === String(desired.percentage === null ? '' : Number(desired.percentage))
    && version.enabled === desired.enabled && version.additive === desired.additive
    && ((version.startDate?.toISOString() ?? null) === (desired.startDate?.toISOString() ?? null)
      || (datedCorrection && version.startDate && version.startDate < desired.startDate))
    && version.endDate === null
    && digest(version.metadata?.allocationSnapshot ?? null) === digest(metadata.allocationSnapshot ?? null)
}

async function appendAllocationVersion(client, allocation, desired, metadata, {datedCorrection = false, preserveExisting = false} = {}) {
  const versions = await client.meterAllocationVersion.findMany({where: {allocationId: allocation.id}, orderBy: {version: 'desc'}})
  const latest = versions[0]
  if ((preserveExisting && latest) || versionMatches(latest, desired, metadata, datedCorrection)) return false
  if (datedCorrection) {
    if (versions.some(version => version.startDate && version.startDate >= desired.startDate)) throw new Error('CORRECTION_NON_CHRONOLOGIQUE')
    for (const version of versions.filter(version => version.enabled && (!version.endDate || version.endDate > desired.startDate))) {
      // Keep the old version enabled over its historical interval, never mutate its snapshot.
      await client.meterAllocationVersion.update({where: {id: version.id}, data: {endDate: desired.startDate}})
    }
  } else if (versions.some(version => version.enabled && !version.endDate)) {
    throw new Error('AFFECTATION_ACTIVE_CORRECTION_DATEE_REQUISE')
  }
  await client.meterAllocationVersion.create({data: {allocationId: allocation.id, version: (latest?.version ?? 0) + 1, ...desired, metadata}})
  return true
}

function allocationPercentage(value) {
  return /^\d+(\.\d{1,4})?$/.test(String(value)) && Number(value) <= 100 ? String(value) : null
}

async function putMeter(client, record, allocations, exploitationIds, options) {
  const identity = await referenceIdentity(client, record, 'METER')
  await lockMeter(client, identity.id)
  const existing = await client.compteur.findUnique({where: {id: identity.id}})
  const serialMatch = await client.compteur.findUnique({where: {serialNumber: record.serial}})
  if (serialMatch && serialMatch.id !== identity.id) throw new Error('NUMERO_COMPTEUR_EXISTANT_A_RAPPROCHER')
  if (existing?.deletedAt) throw new Error('COMPTEUR_SUPPRIME')
  if (existing && existing.serialNumber !== record.serial) throw new Error('NUMERO_COMPTEUR_EXISTANT_DIFFERENT')
  if (!existing) await client.compteur.create({data: {id: identity.id, serialNumber: record.serial}})
  await recordReferences(client, record, 'METER', identity.id, {serialNumber: record.serial})
  const available = allocations.filter(item => exploitationIds.has(item.exploitationId))
  if (record.provider === 'epidropt') {
    for (const item of available) {
      const allocation = await putAllocation(client, item, record, identity.id, exploitationIds)
      await appendAllocationVersion(client, allocation, {percentage: null, enabled: false, additive: false, startDate: null},
        {manifestHash: options.manifestHash}, {preserveExisting: true})
    }
    return identity.id
  }

  const validated = record.allocationSnapshotValidated && available.length === allocations.length
    && record.allocationSnapshot.filter(item => item.inScope).every(item => available.some(allocation => allocation.sourceId === item.key))
  if (validated) validateAllocationSnapshot(record.allocationSnapshot, true)
  const streamKey = {provider: 'rives-et-eaux', scope: SCOPE, externalId: record.serial}
  const oldStream = await client.meterStream.findUnique({where: {provider_scope_externalId: streamKey}})
  if (oldStream && oldStream.compteurId !== identity.id) throw new Error('FLUX_COMPTEUR_DIFFERENT')
  if (oldStream?.serviceAccountId && options.serviceAccountId && oldStream.serviceAccountId !== options.serviceAccountId) throw new Error('COMPTE_SERVICE_DIFFERENT')
  const snapshotChanged = oldStream && digest(oldStream.allocationSnapshot) !== digest(record.allocationSnapshot)
  if (oldStream?.activatedAt && snapshotChanged && !options.effectiveAt) throw new Error('REPARTITION_MODIFIEE_NOUVELLE_VERSION_REQUISE')
  if (options.effectiveAt && (!oldStream?.activatedAt || !validated)) throw new Error('CORRECTION_COMPTEUR_NON_ACTIVE_OU_NON_VALIDEE')
  if (options.effectiveAt && options.effectiveAt < oldStream.activatedAt) throw new Error('CORRECTION_AVANT_ACTIVATION')
  const serviceAccountId = oldStream?.serviceAccountId ?? options.serviceAccountId ?? null
  const activating = !oldStream?.activatedAt && Boolean(options.activateAt && validated)
  if (activating && !serviceAccountId) throw new Error('COMPTE_SERVICE_ACTIVATION_REQUIS')
  const activatedAt = oldStream?.activatedAt ?? (activating ? options.activateAt : null)
  const metadata = {manifestHash: options.manifestHash, allocationSnapshot: record.allocationSnapshot, allocationSnapshotValidated: validated}
  const stream = await client.meterStream.upsert({where: {provider_scope_externalId: streamKey}, create: {
    id: stableId(`stream:${record.serial}`), ...streamKey, compteurId: identity.id, serviceAccountId,
    allocationSnapshot: record.allocationSnapshot, allocationSnapshotValidated: validated,
    enabled: activating, activatedAt, supersedeSameMeter: true
  }, update: {
    ...(!oldStream?.activatedAt || options.effectiveAt ? {allocationSnapshot: record.allocationSnapshot, allocationSnapshotValidated: validated} : {}),
    ...(activating ? {enabled: true, activatedAt, serviceAccountId} : {})
  }})
  let changed = activating || Boolean(snapshotChanged)
  for (const item of available) {
    const allocation = await putAllocation(client, item, record, identity.id, exploitationIds)
    const desired = {
      percentage: allocationPercentage(item.percentage), enabled: Boolean(activatedAt && validated),
      additive: item.additive === true, startDate: options.effectiveAt ?? activatedAt
    }
    const updated = await appendAllocationVersion(client, allocation, desired, {...metadata, rawPercentage: item.percentage}, {
      datedCorrection: Boolean(options.effectiveAt),
      preserveExisting: Boolean(oldStream?.activatedAt && !options.effectiveAt)
    })
    changed ||= updated
  }
  // Only a complete, explicitly dated snapshot authorizes closing an omitted assignment.
  if (options.effectiveAt) {
    const omitted = await client.meterAllocation.findMany({where: {
      compteurId: identity.id, provider: record.provider, scope: SCOPE, sourceId: {notIn: available.map(item => item.sourceId)}
    }})
    for (const allocation of omitted) {
      const updated = await appendAllocationVersion(client, allocation,
        {percentage: null, enabled: false, additive: false, startDate: options.effectiveAt}, metadata, {datedCorrection: true})
      changed ||= updated
    }
  }
  if (changed && stream.activatedAt) {
    const recalculation = await reprocessMeterStreamInTransaction(client, stream.id)
    await client.meterStream.update({where: {id: stream.id}, data: {lastIssue: recalculation.issues.join(',') || null}})
  }
  return identity.id
}

function validateManifest(manifest) {
  if (!manifest || manifest.formatVersion !== FORMAT_VERSION || manifest.scope !== SCOPE
    || !/^[a-f\d]{64}$/.test(manifest.manifestHash ?? '')
    || ['points', 'declarants', 'exploitations', 'meters', 'allocations', 'issues'].some(kind => !Array.isArray(manifest[kind]))) {
    throw new Error('Format du manifeste invalide ; relancer prepare.')
  }
  const {manifestHash, ...payload} = manifest
  if (digest(payload) !== manifestHash) throw new Error('Empreinte du manifeste invalide ; relancer prepare.')
}

function explicitInstant(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw new Error('Une date ISO explicite avec fuseau est obligatoire.')
  return new Date(value)
}

async function lockImportMeters(client, records, pointIds) {
  const ids = new Set()
  for (const record of records) {
    try {
      ids.add((await referenceIdentity(client, record, 'METER')).id)
    } catch {
      // The per-object savepoint reports this identity conflict later.
    }
  }
  for (const id of [...ids].sort()) await lockMeter(client, id)
  const allocations = await client.meterAllocation.findMany({where: {compteurId: {in: [...ids]}}, select: {exploitation: {select: {pointPrelevementId: true}}}})
  const allPoints = new Set([...pointIds, ...allocations.map(item => item.exploitation.pointPrelevementId)])
  for (const id of [...allPoints].sort()) await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('volumes-from-index'), hashtext(${id}))`
}

export async function applyManifest(client, manifest, {apply = false, activateAt, effectiveAt, serviceAccountId} = {}) {
  validateManifest(manifest)
  const {manifestHash} = manifest
  activateAt = explicitInstant(activateAt)
  effectiveAt = explicitInstant(effectiveAt)
  if (serviceAccountId && !await client.serviceAccount.findUnique({where: {id: serviceAccountId}})) throw new Error('Compte de service absent.')
  const result = {manifestHash, applied: apply, counts: {}, issues: [...manifest.issues], objectIds: {points: [], declarants: [], exploitations: [], meters: []}, mappings: {points: [], declarants: [], exploitations: [], meters: []}}
  const pointIds = new Map()
  const declarantIds = new Map()
  const exploitationIds = new Map()
  const execute = async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dropt-referential'), hashtext(${SCOPE}))`
    for (const [kind, rows, fn, idMap] of [
      ['points', manifest.points, (db, r) => putPoint(db, r), pointIds],
      ['declarants', manifest.declarants, (db, r) => putDeclarant(db, r), declarantIds],
      ['exploitations', manifest.exploitations, (db, r) => putExploitation(db, r, pointIds.get(r.pointId), declarantIds.get(r.declarantId)), exploitationIds],
      ['meters', manifest.meters, (db, r) => putMeter(db, r, manifest.allocations.filter(a => a.compteurId === r.id), exploitationIds, {activateAt, effectiveAt, serviceAccountId, manifestHash}), new Map()]
    ]) {
      if (kind === 'meters') await lockImportMeters(tx, rows, pointIds.values())
      result.counts[kind] = 0
      for (const row of rows) {
        await tx.$executeRawUnsafe('SAVEPOINT dropt_object')
        try {
          const id = await fn(tx, row)
          idMap.set(row.id, id)
          result.objectIds[kind].push(id)
          result.mappings[kind].push({manifestId: row.id, id})
          result.counts[kind]++
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT dropt_object')
        } catch (error) {
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT dropt_object')
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT dropt_object')
          const code = /^[A-Z_]+$/.test(error.message) ? error.message : `DATABASE_${error.code ?? 'ERROR'}`
          result.issues.push({code, source: {kind, id: row.id}})
        }
      }
    }

    if (!apply) throw Object.assign(new Error('DRY_RUN_ROLLBACK'), {dryRunResult: result})
    return result
  }

  try {
    return await client.$transaction(execute, {maxWait: 10_000, timeout: 180_000})
  } catch (error) {
    if (error.dryRunResult) return error.dryRunResult
    throw error
  }
}

export async function verifyManifest(client, manifest, {report} = {}) {
  validateManifest(manifest)
  if (report && (report.manifestHash !== manifest.manifestHash || !report.objectIds || !report.mappings)) throw new Error('Rapport incompatible avec le manifeste.')
  const counts = {}
  const issues = []
  const mappings = {points: [], declarants: [], exploitations: [], meters: []}
  const resolved = new Map()
  for (const [kind, model, entityKind, field] of [
    ['points', 'pointPrelevement', 'POINT', 'id'],
    ['declarants', 'declarant', 'DECLARANT', 'userId'],
    ['exploitations', 'declarantPointPrelevement', null, 'id'],
    ['meters', 'compteur', 'METER', 'id']
  ]) {
    counts[kind] = {expected: manifest[kind].length, actual: 0}
    for (const record of manifest[kind]) {
      try {
        const id = entityKind ? (await referenceIdentity(client, record, entityKind)).id
          : (await client[model].findMany({where: {OR: [{id: record.id}, {sourceId: record.sourceId}]}})).reduce((result, row) => {
            if (result && result !== row.id) throw new Error('REFERENCES_INCOMPATIBLES')
            return row.id
          }, null)
        const entity = id ? await client[model].findUnique({where: {[field]: id}}) : null
        if (!entity || entity.deletedAt) throw new Error('OBJET_ABSENT_OU_SUPPRIME')
        if (entityKind) {
          for (const reference of record.references) {
            const stored = await client.externalReference.findUnique({where: {provider_scope_kind_externalId: {
              provider: reference.provider, scope: SCOPE, kind: entityKind, externalId: reference.externalId
            }}})
            if (stored?.[entityFields[entityKind]] !== id) throw new Error('REFERENCE_ABSENTE_OU_DIFFERENTE')
          }
        }
        if (kind === 'meters' && entity.serialNumber !== record.serial) throw new Error('NUMERO_COMPTEUR_EXISTANT_DIFFERENT')
        if (kind === 'exploitations' && (entity.pointPrelevementId !== resolved.get(record.pointId)
          || entity.declarantUserId !== resolved.get(record.declarantId))) throw new Error('EXPLOITATION_EXISTANTE_DIFFERENTE')
        if (report && report.mappings[kind]?.find(item => item.manifestId === record.id)?.id !== id) throw new Error('RAPPORT_IDENTITE_DIFFERENTE')
        mappings[kind].push({manifestId: record.id, id})
        resolved.set(record.id, id)
        counts[kind].actual++
      } catch (error) {
        issues.push({code: /^[A-Z_]+$/.test(error.message) ? error.message : `DATABASE_${error.code ?? 'ERROR'}`, source: {kind, id: record.id}})
      }
    }
    if (report && digest([...report.objectIds[kind]].sort()) !== digest(mappings[kind].map(item => item.id).sort())) issues.push({code: 'RAPPORT_IDENTITES_DIFFERENTES', source: {kind}})
  }
  const streams = manifest.meters.filter(record => record.provider === 'rives-et-eaux')
  counts.streams = {expected: streams.length, actual: 0}
  for (const record of streams) {
    const stream = await client.meterStream.findUnique({where: {provider_scope_externalId: {provider: record.provider, scope: SCOPE, externalId: record.serial}}})
    if (stream?.compteurId === resolved.get(record.id)) counts.streams.actual++
    else issues.push({code: 'FLUX_ABSENT_OU_DIFFERENT', source: {kind: 'streams', id: record.id}})
  }
  counts.allocations = {expected: manifest.allocations.length, actual: 0}
  for (const record of manifest.allocations) {
    const allocation = await client.meterAllocation.findUnique({where: {sourceId: record.sourceId}, include: {versions: {select: {id: true}}}})
    if (allocation && allocation.compteurId === resolved.get(record.compteurId) && allocation.exploitationId === resolved.get(record.exploitationId)
      && allocation.versions.length > 0) counts.allocations.actual++
    else issues.push({code: 'AFFECTATION_ABSENTE_OU_DIFFERENTE', source: {kind: 'allocations', id: record.sourceId}})
  }
  return {manifestHash: manifest.manifestHash, counts, mappings, objectIds: Object.fromEntries(Object.entries(mappings).map(([kind, rows]) => [kind, rows.map(row => row.id)])),
    issues, complete: issues.length === 0 && Object.values(counts).every(({expected, actual}) => expected === actual)}
}
