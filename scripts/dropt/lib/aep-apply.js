import {createHash} from 'node:crypto'
import {digest as sourceDigest} from './aep-source.js'
import {normalizeEmail} from '../../../lib/util/email.js'
import {selectPointZones} from '../../../lib/services/zone-resource-types.js'

const NAMESPACE = 'dropt-aep'
const PREFIX = `${NAMESPACE}:`
const json = value => JSON.parse(JSON.stringify(value))
const digest = value => sourceDigest(json(value))
const stableId = key => {
  const hash = createHash('sha256').update(`${PREFIX}${key}`).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}
const unique = values => [...new Set(values.filter(value => value !== null && value !== undefined))].sort()
const same = (a, b) => digest(a ?? null) === digest(b ?? null)
const assert = (condition, code) => { if (!condition) throw new Error(code) }
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const declarantFields = new Set(['siret', 'socialReason', 'addressLine1', 'addressLine2', 'poBox', 'postalCode', 'city', 'phoneNumber', 'declarantRole', 'declarantType', 'preleveurType', 'quickDeclarationEnabled', 'declarationNotificationsEnabled'])
const pointFields = new Set(['name', 'waterBodyType', 'flowType', 'pointKind', 'collectionMode', 'nature', 'withdrawalType', 'codeBSS', 'codeBNPE', 'codeSISEAUX', 'waterAgencyInternalIdentifier', 'codeEUMasseDEau', 'codePTP', 'codeOPR', 'codeBDLISA', 'codeAIOT', 'codeBDCarthage', 'codeBDTopage', 'locationDescription', 'otherNames', 'depth', 'geometryPrecision', 'comment', 'communeCode', 'communeName', 'isZre', 'isBiologicalReservoir', 'managementUnit', 'managementSubUnit', 'resourceName', 'aquiferName'])
const exploitationFields = new Set(['status', 'excludeFromQuickDeclaration', 'startDate', 'endDate', 'countingCode', 'pointPrelevementNameAliases'])
const markerKey = 'droptAepRetirement'
const tableNames = ['User', 'Declarant', 'DeclarantContactEmail', 'UserEmailIdentity', 'UserEmailAlias', 'UserEmailVerification', 'PointPrelevement', 'PointPrelevementZone', 'DeclarantPointPrelevement', 'DeclarantZone', 'ExternalReference', 'Zone']

function validate(manifest) {
  const {manifestHash, ...payload} = manifest ?? {}
  assert(manifestHash === digest(payload), 'AEP_MANIFEST_HASH_INVALID')
  for (const kind of ['declarants', 'points', 'exploitations', 'retirements']) assert(Array.isArray(manifest[kind]), 'AEP_MANIFEST_INVALID')
  for (const kind of ['declarants', 'points', 'exploitations']) {
    assert(unique(manifest[kind].map(row => row.id)).length === manifest[kind].length, 'AEP_DUPLICATE_ID')
    assert(unique(manifest[kind].map(row => row.sourceId)).length === manifest[kind].length, 'AEP_DUPLICATE_SOURCE')
    for (const row of manifest[kind]) {
      assert(uuid.test(row.id) && typeof row.sourceId === 'string' && row.sourceId.startsWith(PREFIX), 'AEP_IDENTITY_INVALID')
      const allowed = kind === 'declarants' ? declarantFields : kind === 'points' ? pointFields : exploitationFields
      assert(row.data && Object.keys(row.data).every(field => allowed.has(field)), 'AEP_UNEXPECTED_FIELD')
    }
  }
  assert(unique([...manifest.declarants, ...manifest.points, ...manifest.exploitations].map(row => row.id)).length
    === manifest.declarants.length + manifest.points.length + manifest.exploitations.length, 'AEP_DUPLICATE_ID')
  validateOwners(manifest)
  validatePoints(manifest)
  for (const row of manifest.exploitations) assert(row.usageCode === '5' && manifest.points.some(point => point.id === row.pointId)
    && manifest.declarants.some(owner => owner.id === row.declarantId) && row.data.status === 'EN_ACTIVITE'
    && row.data.excludeFromQuickDeclaration === false && row.data.startDate === null && row.data.endDate === null,
  'AEP_EXPLOITATION_INVALID')
  assert(manifest.points.every(point => manifest.exploitations.some(row => row.pointId === point.id))
    && manifest.declarants.every(owner => manifest.exploitations.some(row => row.declarantId === owner.id)), 'AEP_ORPHAN_RESOURCE')
  validateRetirements(manifest)
}

function validateRetirements(manifest) {
  assert(unique(manifest.retirements.map(row => row.name)).length === manifest.retirements.length, 'AEP_DUPLICATE_RETIREMENT')
  for (const row of manifest.retirements) assert(row.name && row.codeBSS && row.sourcePrefix === 'dropt-epidropt:point:'
    && manifest.points.some(point => point.key === row.replacementKey), 'AEP_RETIREMENT_INVALID')
}

function validateOwners(manifest) {
  for (const row of manifest.declarants) {
    assert(row.key && normalizeEmail(row.email) === row.email && /^\d{14}$/.test(row.data.siret), 'AEP_DECLARANT_IDENTITY_INVALID')
    assert(row.data.declarantRole === 'PRELEVEUR' && row.data.declarantType === 'LEGAL_PERSON'
      && row.data.preleveurType === 'GESTIONNAIRE_AEP' && row.data.quickDeclarationEnabled === true, 'AEP_DECLARANT_POLICY_INVALID')
  }
  assert(unique(manifest.declarants.map(row => row.email)).length === manifest.declarants.length
    && unique(manifest.declarants.map(row => row.data.siret)).length === manifest.declarants.length, 'AEP_DUPLICATE_ACCOUNT_IDENTITY')
}

function validatePoints(manifest) {
  for (const row of manifest.points) {
    assert(row.key && row.data.name && row.coordinates?.length === 2 && row.coordinates.every(Number.isFinite)
      && row.coordinates[0] >= -6 && row.coordinates[0] <= 10 && row.coordinates[1] >= 41 && row.coordinates[1] <= 52,
    'AEP_POINT_INVALID')
    assert(row.data.waterBodyType === 'SOUTERRAIN' && row.data.flowType === 'PRELEVEMENT'
      && row.data.pointKind === 'PHYSIQUE' && row.data.collectionMode === 'MANUAL', 'AEP_POINT_POLICY_INVALID')
  }
  assert(unique(manifest.points.map(row => row.data.name.toLowerCase())).length === manifest.points.length, 'AEP_DUPLICATE_POINT_NAME')
}

const rows = async (client, sql, parameters = []) => (await client.query(sql, parameters)).rows
const rawRows = async (client, table, where, parameters) => (await rows(client,
  `SELECT to_jsonb(t) AS row FROM "${table}" t WHERE ${where} ORDER BY to_jsonb(t)::text`, parameters)).map(result => result.row)
const normalizedIdentifier = value => String(value ?? '').replaceAll(/\s/g, '').toUpperCase()
const scalarDifferences = (current, expected) => Object.keys(expected).filter(field => !same(current[field], expected[field]))
const refFor = (kind, record) => ({id: stableId(`ref:${kind}:${record.key}`), provider: NAMESPACE, scope: NAMESPACE,
  kind, externalId: record.key, ...(kind === 'POINT' ? {pointPrelevementId: record.id} : {declarantUserId: record.id}), metadata: {sourceId: record.sourceId}})

async function inventory(client, manifest) {
  const tables = Object.fromEntries(tableNames.map(name => [name, []]))
  const ids = {points: manifest.points.map(row => row.id), users: manifest.declarants.map(row => row.id)}
  tables.PointPrelevement = (await rows(client, `SELECT to_jsonb(p)-'coordinates' || jsonb_build_object('coordinatesEWKB',encode(ST_AsEWKB(p.coordinates),'hex'),'coordinateValues',CASE WHEN p.coordinates IS NULL THEN NULL ELSE jsonb_build_array(ST_X(p.coordinates),ST_Y(p.coordinates)) END) AS row
    FROM "PointPrelevement" p WHERE p.id=ANY($1::uuid[]) OR p."sourceId" LIKE $2 OR p."sourceId"=ANY($3::text[])
    OR lower(p.name)=ANY($4::text[]) OR upper(regexp_replace(coalesce(p."codeBSS",''),'\\s','','g'))=ANY($5::text[])
    OR (p."waterAgencyInternalIdentifier" IS NOT NULL AND p."waterAgencyInternalIdentifier"=ANY($6::text[]))
    OR upper(regexp_replace(coalesce(p."codeSISEAUX",''),'\\s','','g'))=ANY($7::text[]) ORDER BY p.id`,
  [ids.points, `${PREFIX}%`, manifest.points.map(row => row.sourceId), unique([...manifest.points.map(row => row.data.name.toLowerCase()), ...manifest.retirements.map(row => row.name.toLowerCase())]),
    unique([...manifest.points.map(row => row.data.codeBSS), ...manifest.retirements.map(row => row.codeBSS)].filter(Boolean).map(normalizedIdentifier)),
    unique(manifest.points.map(row => row.data.waterAgencyInternalIdentifier)), unique(manifest.points.map(row => row.data.codeSISEAUX).filter(Boolean).map(normalizedIdentifier))])).map(result => result.row)
  ids.points = unique([...ids.points, ...tables.PointPrelevement.map(row => row.id)])
  tables.Declarant = await rawRows(client, 'Declarant', 't."userId"=ANY($1::uuid[]) OR t."sourceId" LIKE $2 OR regexp_replace(coalesce(t.siret,\'\'),\'\\s\',\'\',\'g\')=ANY($3::text[])', [ids.users, `${PREFIX}%`, manifest.declarants.map(row => row.data.siret)])
  ids.users = unique([...ids.users, ...tables.Declarant.map(row => row.userId)])
  const emails = manifest.declarants.map(row => row.email)
  tables.User = await rawRows(client, 'User', 't.id=ANY($1::uuid[]) OR lower(t.email::text)=ANY($2::text[])', [ids.users, emails])
  tables.UserEmailAlias = await rawRows(client, 'UserEmailAlias', 't."userId"=ANY($1::uuid[]) OR lower(t.email::text)=ANY($2::text[])', [ids.users, emails])
  tables.UserEmailIdentity = await rawRows(client, 'UserEmailIdentity', 't."primaryUserId"=ANY($1::uuid[]) OR t."aliasUserId"=ANY($1::uuid[]) OR t."verificationUserId"=ANY($1::uuid[]) OR lower(t.email::text)=ANY($2::text[])', [ids.users, emails])
  tables.UserEmailVerification = (await rows(client, 'SELECT to_jsonb(t)-\'tokenHash\' AS row FROM "UserEmailVerification" t WHERE t."userId"=ANY($1::uuid[]) OR (lower(t.email::text)=ANY($2::text[]) AND status IN (\'PENDING\',\'SEND_FAILED\')) ORDER BY t.id', [ids.users, emails])).map(result => result.row)
  tables.DeclarantContactEmail = await rawRows(client, 'DeclarantContactEmail', 't."declarantUserId"=ANY($1::uuid[]) OR lower(t.email::text)=ANY($2::text[])', [ids.users, emails])
  tables.DeclarantPointPrelevement = await rawRows(client, 'DeclarantPointPrelevement', 't."pointPrelevementId"=ANY($1::uuid[]) OR t."declarantUserId"=ANY($2::uuid[]) OR t."sourceId" LIKE $3 OR t.id=ANY($4::uuid[])', [ids.points, ids.users, `${PREFIX}%`, manifest.exploitations.map(row => row.id)])
  tables.PointPrelevementZone = await rawRows(client, 'PointPrelevementZone', 't."pointPrelevementId"=ANY($1::uuid[])', [ids.points])
  tables.DeclarantZone = await rawRows(client, 'DeclarantZone', 't."declarantUserId"=ANY($1::uuid[])', [ids.users])
  tables.ExternalReference = await rawRows(client, 'ExternalReference', 't."pointPrelevementId"=ANY($1::uuid[]) OR t."declarantUserId"=ANY($2::uuid[]) OR t.provider=$3 OR t.scope=$3 OR t.id=ANY($4::uuid[])', [ids.points, ids.users, NAMESPACE, [...manifest.points.map(row => refFor('POINT', row).id), ...manifest.declarants.map(row => refFor('DECLARANT', row).id)]])
  const zones = []
  for (const point of manifest.points) {
    const candidates = await rows(client, 'SELECT z.id,z.code,z.type,z.name,z."managedResourceType",encode(ST_AsEWKB(z.coordinates),\'hex\') AS "coordinatesEWKB" FROM "Zone" z WHERE ST_Intersects(z.coordinates,ST_SetSRID(ST_MakePoint($1,$2),4326)) ORDER BY z.id', point.coordinates)
    zones.push({pointId: point.id, candidates})
  }
  const zoneIds = unique([...zones.flatMap(point => point.candidates.map(zone => zone.id)), ...tables.PointPrelevementZone.map(row => row.zoneId), ...tables.DeclarantZone.map(row => row.zoneId)])
  tables.Zone = (await rows(client, 'SELECT to_jsonb(z)-\'coordinates\'||jsonb_build_object(\'coordinatesEWKB\',encode(ST_AsEWKB(z.coordinates),\'hex\')) AS row FROM "Zone" z WHERE id=ANY($1::uuid[]) ORDER BY id', [zoneIds])).map(result => result.row)
  const exploitationIds = unique([...tables.DeclarantPointPrelevement.map(row => row.id), ...manifest.exploitations.map(row => row.id)])
  const dependencies = await rows(client, `SELECT p.id,
    (SELECT count(*)::int FROM "Chunk" c WHERE c."pointPrelevementId"=p.id) AS chunks,
    (SELECT count(*)::int FROM "ChunkValueReplacement" c WHERE c."pointPrelevementId"=p.id) AS replacements
    FROM "PointPrelevement" p WHERE p.id=ANY($1::uuid[]) ORDER BY p.id`, [ids.points])
  const extras = {}
  for (const [table, predicate, values] of [
    ['DeclarantCollecteurExploitation', '"exploitationId"=ANY($1::uuid[])', exploitationIds],
    ['CollectionResponse', '"exploitationId"=ANY($1::uuid[])', exploitationIds],
    ['MeterAllocation', '"exploitationId"=ANY($1::uuid[])', exploitationIds],
    ['DeclarantPointPrelevementConnector', '"declarantPointPrelevementId"=ANY($1::uuid[])', exploitationIds],
    ['DeclarantPointPrelevementSecondaryUsage', '"exploitationId"=ANY($1::uuid[])', exploitationIds],
    ['ResourceDocument', '"declarantPointPrelevementId"=ANY($1::uuid[])', exploitationIds],
    ['ResourceDocumentExploitation', '"declarantPointPrelevementId"=ANY($1::uuid[])', exploitationIds],
    ['ResourceRuleExploitation', '"declarantPointPrelevementId"=ANY($1::uuid[])', exploitationIds]
  ]) extras[table] = await rawRows(client, table, predicate, [values])
  extras.Chunk = await rawRows(client, 'Chunk', 't."pointPrelevementId"=ANY($1::uuid[]) OR t."exploitationId"=ANY($2::uuid[]) OR t."preleveurUserId"=ANY($3::uuid[])', [ids.points, exploitationIds, ids.users])
  extras.Declaration = await rawRows(client, 'Declaration', 't."declarantUserId"=ANY($1::uuid[]) OR t."createdByDeclarantUserId"=ANY($1::uuid[])', [ids.users])
  extras.ResourceDocument = await rawRows(client, 'ResourceDocument', 't."declarantPointPrelevementId"=ANY($1::uuid[]) OR t."declarantUserId"=ANY($2::uuid[])', [exploitationIds, ids.users])
  extras.ResourceRule = await rawRows(client, 'ResourceRule', 't."declarantUserId"=ANY($1::uuid[])', [ids.users])
  const authentication = await rows(client, `SELECT u.id,
    (SELECT count(*)::int FROM "AuthToken" t WHERE t."userId"=u.id) AS tokens,
    (SELECT count(*)::int FROM "SessionToken" t WHERE t."userId"=u.id OR t."impersonatedByUserId"=u.id) AS sessions,
    (SELECT count(*)::int FROM "PasswordCredential" t WHERE t."userId"=u.id) AS credentials,
    (SELECT count(*)::int FROM "PasswordActivation" t WHERE t."userId"=u.id OR t."createdByUserId"=u.id) AS activations
    FROM "User" u WHERE u.id=ANY($1::uuid[]) ORDER BY u.id`, [ids.users])
  for (const record of authentication) {
    record.fingerprints = {}
    for (const [table, predicate] of [['AuthToken', 't."userId"=$1'], ['SessionToken', 't."userId"=$1 OR t."impersonatedByUserId"=$1'],
      ['PasswordCredential', 't."userId"=$1'], ['PasswordActivation', 't."userId"=$1 OR t."createdByUserId"=$1'], ['UserEmailVerification', 't."userId"=$1']]) {
      const [fingerprint] = await rows(client, `SELECT count(*)::int AS count,md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]')) AS hash FROM "${table}" t WHERE ${predicate}`, [record.id])
      record.fingerprints[table] = fingerprint
    }
  }
  const usage = await rawRows(client, 'SandreWaterUse', 't.code=$1', ['5'])
  const identityLocks = await rawRows(client, 'ExploitationIdentityLock', 't."declarantUserId"=ANY($1::uuid[]) AND t."pointPrelevementId"=ANY($2::uuid[])', [manifest.declarants.map(row => row.id), manifest.points.map(row => row.id)])
  return {tables, zones, dependencies, extras, authentication, identityLocks, usage}
}

function retirementMarker(point, row, refs, manifest, {block, changes}) {
  const expectedMarker = {manifestHash: manifest.manifestHash, replacementKey: row.replacementKey, sourceId: point.sourceId}
  if (point.deletedAt) {
    const previousMarker = refs[0]?.metadata?.[markerKey]
    if (!previousMarker || previousMarker.sourceId !== point.sourceId || previousMarker.replacementKey !== row.replacementKey
    || !/^[a-f\d]{64}$/.test(previousMarker.manifestHash ?? '')) block('AEP_RETIREMENT_ALREADY_DELETED', {id: point.id})
    else Object.assign(expectedMarker, previousMarker)
  } else if (refs[0]?.metadata?.[markerKey]) block('AEP_RETIREMENT_MARKER_CONFLICT', {id: point.id})
  else changes.push({kind: 'retirements', id: point.id, action: 'RETIRE'})
  return expectedMarker
}

function reviewRetirements(manifest, before, {pins, block, changes}) {
  const {tables, dependencies} = before
  for (const row of manifest.retirements) {
    const matches = tables.PointPrelevement.filter(point => point.name === row.name && normalizedIdentifier(point.codeBSS) === normalizedIdentifier(row.codeBSS) && point.sourceId?.startsWith(row.sourcePrefix))
    if (matches.length !== 1) { block('AEP_RETIREMENT_IDENTITY', {name: row.name}); continue }
    const point = matches[0]
    const refs = tables.ExternalReference.filter(ref => ref.pointPrelevementId === point.id)
    const links = tables.PointPrelevementZone.filter(link => link.pointPrelevementId === point.id)
    const currentZones = links.map(link => tables.Zone.find(zone => zone.id === link.zoneId))
    if (refs.length !== 1 || scalarDifferences(refs[0], {provider: 'epidropt', scope: 'epidropt', kind: 'POINT', externalId: row.name}).length) block('AEP_RETIREMENT_REFERENCE', {id: point.id})
    if (currentZones.length !== 3 || currentZones.some(zone => !zone) || new Set(currentZones.map(zone => zone.type)).size !== 3
      || !same(currentZones.map(zone => zone?.code).sort(), [...(manifest.decisions?.retirementExpectedZoneCodes ?? ['reg-75', 'dep-33', 'sage-SAGE05003'])].sort())) block('AEP_RETIREMENT_ZONES', {id: point.id})
    if (tables.DeclarantPointPrelevement.some(exploitation => exploitation.pointPrelevementId === point.id)
      || dependencies.some(item => item.id === point.id && (item.chunks || item.replacements))) block('AEP_RETIREMENT_DEPENDENCY', {id: point.id})
    const expectedMarker = retirementMarker(point, row, refs, manifest, {block, changes})
    pins.retirements.push({id: point.id, sourceId: point.sourceId, name: point.name, referenceId: refs[0]?.id, marker: expectedMarker, zoneIds: links.map(link => link.zoneId).sort()})
  }
}

function reviewContact(tables, row, user, block) {
  const contacts = tables.DeclarantContactEmail.filter(contact => contact.declarantUserId === row.id)
  if (user && (contacts.length !== 1 || contacts[0].email !== row.email || !contacts[0].isPrimary || contacts[0].sourceId !== `${row.sourceId}:email`)) block('AEP_CONTACT_CHANGED', {id: row.id})
}

function reviewDeclarants(manifest, before, {block, create}) {
  const {tables} = before
  for (const row of manifest.declarants) {
    const owners = tables.Declarant.filter(owner => owner.userId === row.id || owner.sourceId === row.sourceId || normalizedIdentifier(owner.siret) === row.data.siret)
    const user = tables.User.find(user => user.id === row.id)
    if (owners.some(owner => owner.userId !== row.id) || owners.length > 1 || (owners[0] && owners[0].sourceId !== row.sourceId)) block('AEP_DECLARANT_COLLISION', {id: row.id})
    if (user) {
      if (!owners[0] || scalarDifferences(user, {deletedAt: null, role: 'DECLARANT', email: row.email, firstName: null, lastName: null}).length
        || scalarDifferences(owners[0], row.data).length) block('AEP_DECLARANT_CHANGED', {id: row.id})
    } else if (owners.length) block('AEP_DECLARANT_WITHOUT_USER', {id: row.id})
    else create('declarants', row.id)
    if (tables.User.some(user => user.email?.toLowerCase() === row.email && user.id !== row.id)
      || tables.UserEmailAlias.some(alias => alias.email?.toLowerCase() === row.email)
      || tables.UserEmailVerification.some(verification => verification.email?.toLowerCase() === row.email && ['PENDING', 'SEND_FAILED'].includes(verification.status))
      || tables.UserEmailIdentity.some(identity => identity.email?.toLowerCase() === row.email && (identity.aliasUserId || identity.verificationUserId || (identity.primaryUserId && identity.primaryUserId !== row.id)))
      || tables.DeclarantContactEmail.some(contact => contact.email?.toLowerCase() === row.email && contact.declarantUserId !== row.id)) block('AEP_EMAIL_COLLISION', {id: row.id})
    if (user && !tables.UserEmailIdentity.some(identity => identity.email === row.email && identity.primaryUserId === row.id && !identity.aliasUserId && !identity.verificationUserId)) block('AEP_EMAIL_REGISTRY_INVALID', {id: row.id})
    reviewContact(tables, row, user, block)
  }
}

function reviewPoints(manifest, before, {pins, block, create}) {
  const {tables} = before
  for (const row of manifest.points) {
    const matches = tables.PointPrelevement.filter(point => point.id === row.id || point.sourceId === row.sourceId || point.name.toLowerCase() === row.data.name.toLowerCase()
      || (row.data.codeBSS && normalizedIdentifier(point.codeBSS) === normalizedIdentifier(row.data.codeBSS))
      || (row.data.waterAgencyInternalIdentifier && point.waterAgencyInternalIdentifier === row.data.waterAgencyInternalIdentifier)
      || (row.data.codeSISEAUX && normalizedIdentifier(point.codeSISEAUX) === normalizedIdentifier(row.data.codeSISEAUX)))
    const retiredIds = pins.retirements.filter(pin => pin.marker.replacementKey === row.key).map(pin => pin.id)
    if (matches.some(point => point.id !== row.id && !retiredIds.includes(point.id))) block('AEP_POINT_COLLISION', {id: row.id})
    const existing = matches.find(point => point.id === row.id)
    if (existing) {
      if (existing.sourceId !== row.sourceId || existing.deletedAt || scalarDifferences(existing, row.data).length
        || !existing.coordinateValues?.every((value, index) => Math.abs(value - row.coordinates[index]) <= 1e-10)) block('AEP_POINT_CHANGED', {id: row.id})
    } else create('points', row.id)
    const candidates = before.zones.find(item => item.pointId === row.id).candidates
    let selected = []
    try { selected = selectPointZones(candidates, row.data.waterBodyType) } catch { block('AEP_POINT_ZONE_AMBIGUOUS', {id: row.id}) }
    if (selected.length !== 3 || new Set(selected.map(zone => zone.type)).size !== 3) block('AEP_POINT_ZONES_INCOMPLETE', {id: row.id})
    const zoneIds = selected.map(zone => zone.id).sort()
    pins.zones.push({pointId: row.id, zoneIds, codes: selected.map(zone => zone.code).sort()})
    if (existing && !same(zoneIds, tables.PointPrelevementZone.filter(link => link.pointPrelevementId === row.id).map(link => link.zoneId).sort())) block('AEP_POINT_ZONES_CHANGED', {id: row.id})
  }
}

function reviewReferences(manifest, before, {block}) {
  const {tables} = before
  for (const kind of ['points', 'declarants']) for (const row of manifest[kind]) {
    const expected = refFor(kind === 'points' ? 'POINT' : 'DECLARANT', row)
    const refs = tables.ExternalReference.filter(ref => ref.id === expected.id || (ref.provider === NAMESPACE && ref.scope === NAMESPACE && ref.kind === expected.kind && ref.externalId === expected.externalId))
    const existing = kind === 'points' ? tables.PointPrelevement.some(point => point.id === row.id) : tables.User.some(user => user.id === row.id)
    const attached = tables.ExternalReference.filter(ref => kind === 'points' ? ref.pointPrelevementId === row.id : ref.declarantUserId === row.id)
    if (attached.some(ref => ref.id !== expected.id)) block('AEP_EXTRA_REFERENCE', {id: row.id})
    if (refs.length > 1 || (refs[0] && scalarDifferences(refs[0], expected).length) || (existing && refs.length !== 1) || (!existing && refs.length)) block('AEP_REFERENCE_COLLISION', {id: row.id})
  }
}

function reviewExploitations(manifest, before, {pins, block, create}) {
  const {tables} = before
  for (const row of manifest.exploitations) {
    const matches = tables.DeclarantPointPrelevement.filter(exploitation => exploitation.id === row.id || exploitation.sourceId === row.sourceId
      || (exploitation.pointPrelevementId === row.pointId && exploitation.declarantUserId === row.declarantId))
    if (matches.length > 1 || (matches[0] && (matches[0].id !== row.id || matches[0].sourceId !== row.sourceId || matches[0].pointPrelevementId !== row.pointId
      || matches[0].declarantUserId !== row.declarantId || matches[0].usageId !== pins.usage?.id || scalarDifferences(matches[0], row.data).length))) block('AEP_EXPLOITATION_CHANGED', {id: row.id})
    if (!matches.length) create('exploitations', row.id)
  }
}

function reviewDeclarantZones(manifest, before, {pins, block}) {
  const {tables} = before
  for (const row of manifest.declarants) {
    const expectedIds = unique(manifest.exploitations.filter(exploitation => exploitation.declarantId === row.id).flatMap(exploitation => pins.zones.find(zone => zone.pointId === exploitation.pointId)?.zoneIds ?? []))
    if (tables.User.some(user => user.id === row.id) && !same(expectedIds, tables.DeclarantZone.filter(link => link.declarantUserId === row.id).map(link => link.zoneId).sort())) block('AEP_DECLARANT_ZONES_CHANGED', {id: row.id})
  }
}

function reviewExtras(manifest, before, {block}) {
  const {tables, extras} = before
  for (const [kind, table, key] of [['points', 'PointPrelevement', 'id'], ['declarants', 'Declarant', 'userId'], ['exploitations', 'DeclarantPointPrelevement', 'id']]) {
    if (tables[table].some(row => row.sourceId?.startsWith(PREFIX) && !manifest[kind].some(expected => expected.id === row[key]))) block('AEP_EXTRA_IMPORTED_OBJECT', {kind})
  }
  if (tables.DeclarantPointPrelevement.some(row => !manifest.exploitations.some(expected => expected.id === row.id)
    && (manifest.points.some(point => point.id === row.pointPrelevementId) || manifest.declarants.some(owner => owner.id === row.declarantUserId)))) block('AEP_EXTRA_EXPLOITATION')
  for (const [table, records] of Object.entries(extras)) if (records.length) block('AEP_UNEXPECTED_DEPENDENCY', {table, count: records.length})
}

function buildReview(manifest, before) {
  const blocked = []
  const changes = []
  const block = (code, details = {}) => blocked.push({code, ...details})
  const create = (kind, id) => changes.push({kind, id, action: 'CREATE'})
  const pins = {retirements: [], zones: [], usage: before.usage[0] ?? null}
  if (before.usage.length !== 1 || before.usage[0].kind !== 'USAGE') block('AEP_USAGE_INVALID')
  const context = {pins, block, create, changes}
  reviewRetirements(manifest, before, context)
  reviewDeclarants(manifest, before, context)
  reviewPoints(manifest, before, context)
  reviewReferences(manifest, before, context)
  reviewExploitations(manifest, before, context)
  reviewDeclarantZones(manifest, before, context)
  reviewExtras(manifest, before, context)
  const summary = {declarantsCreated: changes.filter(change => change.kind === 'declarants').length, pointsCreated: changes.filter(change => change.kind === 'points').length,
    exploitationsCreated: changes.filter(change => change.kind === 'exploitations').length, pointsRetired: changes.filter(change => change.kind === 'retirements').length, changes: changes.length}
  const stateHash = digest(before)
  return {operation: 'import-dropt-aep', manifestHash: manifest.manifestHash, complete: blocked.length === 0, blocked, summary, before, pins, stateHash,
    planHash: digest({manifestHash: manifest.manifestHash, stateHash, pins, changes}), changes}
}

export async function reviewAep(client, manifest) {
  validate(manifest)
  return buildReview(manifest, await inventory(client, manifest))
}

async function insert(client, table, data) {
  const columns = Object.keys(data)
  await client.query(`INSERT INTO "${table}" (${columns.map(column => `"${column}"`).join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`, columns.map(column => data[column]))
}

async function audit(client, manifest, change, before, after) {
  const id = stableId(`audit:${manifest.manifestHash}:${change.kind}:${change.id}`)
  const mutationId = stableId(`mutation:${id}`)
  const type = {points: 'PointPrelevement', retirements: 'PointPrelevement', declarants: 'Declarant', exploitations: 'DeclarantPointPrelevement'}[change.kind]
  await client.query(`INSERT INTO "AuditEvent" (id,"occurredAt","completedAt","updatedAt",outcome,"actionType","actionCategory","actorType","actorLabel","targetType","targetId","requestId","httpMethod",route,"statusCode",metadata)
    VALUES ($1,now(),now(),now(),'SUCCESS',$2,'IMPORT','ANONYMOUS','Maintenance import AEP',$3,$4,$5,'CLI','scripts/dropt/import-aep',200,$6::jsonb)`,
  [id, change.action === 'RETIRE' ? 'POINT_PRELEVEMENT.DELETED' : 'AEP.IMPORTED', type, change.id, `dropt-aep:${manifest.manifestHash}`, JSON.stringify({manifestHash: manifest.manifestHash, maintenance: true})])
  await client.query(`INSERT INTO "AuditMutation" (id,"auditEventId",operation,"entityType","entityId",before,after,"changedFields","redactedFields",metadata)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::text[],ARRAY[]::text[],$9::jsonb)`,
  [mutationId, id, change.action === 'RETIRE' ? 'UPDATE' : 'CREATE', type, change.id, JSON.stringify(before), JSON.stringify(after), change.action === 'RETIRE' ? ['deletedAt'] : Object.keys(after), JSON.stringify({manifestHash: manifest.manifestHash})])
}

export async function applyAep(client, manifest, expectedReview) {
  const [transaction] = await rows(client, 'SELECT current_setting(\'transaction_isolation\') AS isolation,current_setting(\'transaction_read_only\') AS "readOnly",now() < statement_timestamp() AS "explicitTransaction"')
  assert(transaction.isolation === 'serializable' && transaction.readOnly === 'off' && transaction.explicitTransaction, 'AEP_SERIALIZABLE_TRANSACTION_REQUIRED')
  await client.query('SELECT pg_advisory_xact_lock(hashtext(\'dropt-referential\'),hashtext(\'epidropt\'))')
  assert(expectedReview?.complete && expectedReview.operation === 'import-dropt-aep' && expectedReview.manifestHash === manifest.manifestHash, 'AEP_REVIEW_REQUIRED')
  // Row locks also serialize edits and new foreign-key attachments to retired PPs.
  await client.query('SELECT id FROM "PointPrelevement" WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [expectedReview.pins.retirements.map(row => row.id)])
  await client.query('SELECT id FROM "ExternalReference" WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [expectedReview.pins.retirements.map(row => row.referenceId)])
  const current = await reviewAep(client, manifest)
  assert(current.complete && current.stateHash === expectedReview.stateHash && current.planHash === expectedReview.planHash, 'AEP_STATE_CHANGED')
  if (!current.changes.length) return {...current, applied: true, verification: await verifyAep(client, manifest)}
  await client.query('SAVEPOINT dropt_aep_apply')
  try {
    const result = await executeChanges(client, manifest, current)
    await client.query('RELEASE SAVEPOINT dropt_aep_apply')
    return result
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT dropt_aep_apply')
    await client.query('RELEASE SAVEPOINT dropt_aep_apply')
    throw error
  }
}

async function executeChanges(client, manifest, current) {
  const shouldCreate = (kind, id) => current.changes.some(change => change.kind === kind && change.id === id)
  for (const retirement of current.pins.retirements.filter(row => shouldCreate('retirements', row.id))) {
    const result = await client.query('UPDATE "PointPrelevement" SET "deletedAt"=now(),"updatedAt"=now() WHERE id=$1 AND "sourceId"=$2 AND "deletedAt" IS NULL', [retirement.id, retirement.sourceId])
    assert(result.rowCount === 1, 'AEP_RETIREMENT_CHANGED')
    const reference = await client.query('UPDATE "ExternalReference" SET metadata=metadata||jsonb_build_object($2::text,$3::jsonb) WHERE id=$1', [retirement.referenceId, markerKey, JSON.stringify(retirement.marker)])
    assert(reference.rowCount === 1, 'AEP_RETIREMENT_REFERENCE_CHANGED')
  }
  for (const row of manifest.declarants.filter(row => shouldCreate('declarants', row.id))) {
    await client.query('INSERT INTO "User" (id,email,role,"firstName","lastName","updatedAt") VALUES ($1,$2,\'DECLARANT\',NULL,NULL,now())', [row.id, row.email])
    await insert(client, 'Declarant', {userId: row.id, sourceId: row.sourceId, ...row.data})
    await client.query('INSERT INTO "DeclarantContactEmail" (id,"declarantUserId",email,"isPrimary","sourceId","updatedAt") VALUES ($1,$2,$3,true,$4,now())', [stableId(`contact:${row.key}`), row.id, row.email, `${row.sourceId}:email`])
    const reference = refFor('DECLARANT', row)
    await insert(client, 'ExternalReference', {...reference, metadata: JSON.stringify(reference.metadata)})
  }
  for (const row of manifest.points.filter(row => shouldCreate('points', row.id))) {
    await insert(client, 'PointPrelevement', {id: row.id, sourceId: row.sourceId, ...row.data, updatedAt: new Date()})
    await client.query('UPDATE "PointPrelevement" SET coordinates=ST_SetSRID(ST_MakePoint($2,$3),4326) WHERE id=$1', [row.id, ...row.coordinates])
    const reference = refFor('POINT', row)
    await insert(client, 'ExternalReference', {...reference, metadata: JSON.stringify(reference.metadata)})
    for (const zoneId of current.pins.zones.find(zone => zone.pointId === row.id).zoneIds) await insert(client, 'PointPrelevementZone', {id: stableId(`point-zone:${row.id}:${zoneId}`), pointPrelevementId: row.id, zoneId})
  }
  for (const row of manifest.exploitations.filter(row => shouldCreate('exploitations', row.id))) {
    await insert(client, 'DeclarantPointPrelevement', {id: row.id, sourceId: row.sourceId, pointPrelevementId: row.pointId,
      declarantUserId: row.declarantId, usageId: current.pins.usage.id, ...row.data, updatedAt: new Date()})
  }
  for (const row of manifest.declarants.filter(row => shouldCreate('declarants', row.id))) {
    const zoneIds = unique(manifest.exploitations.filter(exploitation => exploitation.declarantId === row.id).flatMap(exploitation => current.pins.zones.find(zone => zone.pointId === exploitation.pointId).zoneIds))
    for (const zoneId of zoneIds) await insert(client, 'DeclarantZone', {id: stableId(`declarant-zone:${row.id}:${zoneId}`), declarantUserId: row.id, zoneId, source: 'MIGRATION', updatedAt: new Date()})
  }
  const verification = await verifyAep(client, manifest)
  assert(verification.ok, 'AEP_POSTCONDITION_FAILED')
  for (const change of current.changes) {
    const table = change.kind === 'declarants' ? 'Declarant' : change.kind === 'exploitations' ? 'DeclarantPointPrelevement' : 'PointPrelevement'
    const key = change.kind === 'declarants' ? 'userId' : 'id'
    await audit(client, manifest, change, current.before.tables[table].find(row => row[key] === change.id) ?? null,
      verification.review.before.tables[table].find(row => row[key] === change.id))
  }
  return {...current, applied: true, verification}
}

export async function verifyAep(client, manifest) {
  const review = await reviewAep(client, manifest)
  const issues = [...review.blocked, ...review.changes.map(change => ({code: 'AEP_MISSING_CHANGE', ...change}))]
  const capabilities = manifest.declarants.map(record => {
    const user = review.before.tables.User.find(row => row.id === record.id)
    const declarant = review.before.tables.Declarant.find(row => row.userId === record.id)
    const active = user?.role === 'DECLARANT' && !user.deletedAt && declarant?.declarantRole === 'PRELEVEUR'
    const login = Boolean(active && user.email === record.email && review.before.tables.UserEmailIdentity.some(identity => identity.email === record.email && identity.primaryUserId === record.id))
    const quickExploitationIds = review.before.tables.DeclarantPointPrelevement.filter(row => {
      const point = review.before.tables.PointPrelevement.find(point => point.id === row.pointPrelevementId)
      return active && declarant.quickDeclarationEnabled && row.declarantUserId === record.id
        && !row.excludeFromQuickDeclaration && ['EN_ACTIVITE', 'NON_RENSEIGNE'].includes(row.status)
        && row.startDate === null && row.endDate === null && point && !point.deletedAt
        && [null, 'MANUAL'].includes(point.collectionMode)
    }).map(row => row.id).sort()
    const expected = manifest.exploitations.filter(row => row.declarantId === record.id).map(row => row.id).sort()
    if (!login || !same(quickExploitationIds, expected)) issues.push({code: 'AEP_CAPABILITIES_INVALID', id: record.id})
    return {id: record.id, loginEnabled: login, quickExploitationIds}
  })
  return {ok: issues.length === 0, complete: issues.length === 0, issues, capabilities,
    summary: {declarants: manifest.declarants.length, points: manifest.points.length, exploitations: manifest.exploitations.length,
      retiredPoints: manifest.retirements.length, quickEnabled: capabilities.reduce((count, row) => count + row.quickExploitationIds.length, 0)}, review}
}
