import test from 'ava'
import {preserveManifestIdentities, resolvePointMatches} from '../reconciliation.js'
import {exploitationIdentity, referenceIdentity} from '../apply-epidropt.js'

const oldId = 'old-point'
const targetId = 'kept-point'
const alias = {provider: 'pe-import-alias', scope: 'epidropt', kind: 'POINT', externalId: oldId, pointPrelevementId: targetId,
  metadata: {exploitationAliases: [{sourceId: 'old-exploitation', targetId: 'kept-exploitation', sourceSourceId: 'old-source-exploitation'}]}}

function fixture() {
  const point = {id: oldId, sourceId: 'old-source-point', key: 'source-key', references: [{provider: 'epidropt', externalId: 'source-point'}], data: {}}
  const exploitation = {id: 'old-exploitation', pointId: oldId, declarantId: 'owner', sourceId: 'old-source-exploitation', countingCode: 'count-1'}
  const manifest = {points: [point], declarants: [{id: 'owner', sourceId: 'owner-source', data: {}, references: []}], meters: [],
    exploitations: [exploitation], allocations: [], issues: [], reconciliation: []}
  const snapshot = {tables: {
    externalReferences: [alias, {provider: 'epidropt', scope: 'epidropt', kind: 'POINT', externalId: 'source-point', pointPrelevementId: targetId}],
    points: [{id: oldId, sourceId: point.sourceId, deletedAt: '2026-09-28'}, {id: targetId, sourceId: 'kept-source-point'}],
    exploitations: [{id: 'kept-exploitation', sourceId: 'kept-source-exploitation', pointPrelevementId: targetId, declarantUserId: 'owner'}]
  }}
  return {manifest, snapshot}
}

test('le ledger conserve les UUID et sourceId survivants après fusion, avec un ancien manifeste et une tombstone', t => {
  const {manifest, snapshot} = fixture()
  const result = preserveManifestIdentities(manifest, {previousManifest: manifest, snapshot})
  t.deepEqual(result.issues, [])
  t.is(result.points[0].id, targetId)
  t.is(result.points[0].sourceId, 'kept-source-point')
  t.is(result.exploitations[0].id, 'kept-exploitation')
  t.is(result.exploitations[0].sourceId, 'kept-source-exploitation')
  t.is(result.exploitations[0].pointId, targetId)
  t.is(manifest.points[0].id, oldId)
})

test('plusieurs anciennes ancres PP ne sont compatibles que si leurs alias prouvent le même survivant', t => {
  const {manifest, snapshot} = fixture()
  const previousManifest = structuredClone(manifest)
  previousManifest.points.push({...manifest.points[0], id: targetId, sourceId: 'kept-source-point'})
  const result = preserveManifestIdentities(manifest, {previousManifest, snapshot})
  t.deepEqual(result.issues, [])
  t.is(result.points[0].id, targetId)
  snapshot.tables.externalReferences = snapshot.tables.externalReferences.filter(ref => ref.provider !== 'pe-import-alias')
  const conflict = preserveManifestIdentities(manifest, {previousManifest, snapshot})
  t.true(conflict.issues.some(issue => issue.code === 'IDENTITY_LEDGER_CONFLICT'))
  t.deepEqual(conflict.points, [])
})

test('deux anciennes exploitations fusionnées sont une ancre unique pour un nouveau code de manifeste', t => {
  const {manifest, snapshot} = fixture()
  const previousManifest = structuredClone(manifest)
  previousManifest.exploitations[0].usageCode = '17'
  previousManifest.points.push({...manifest.points[0], id: targetId, sourceId: 'kept-source-point'})
  previousManifest.exploitations.push({...manifest.exploitations[0], id: 'kept-exploitation',
    sourceId: 'kept-source-exploitation', key: 'kept-key', pointId: targetId, usageCode: '2'})
  manifest.exploitations[0].id = 'newly-generated-exploitation'
  manifest.exploitations[0].sourceId = 'newly-generated-source'
  manifest.exploitations[0].usageCode = '7'
  const result = preserveManifestIdentities(manifest, {previousManifest, snapshot})
  t.deepEqual(result.issues, [])
  t.is(result.exploitations[0].id, 'kept-exploitation')
  t.is(result.exploitations[0].sourceId, 'kept-source-exploitation')
  t.is(result.exploitations[0].key, 'kept-key')
  t.is(result.exploitations[0].pointId, targetId)
  t.is(result.exploitations[0].previousCountingCode, 'count-1')
  t.is(result.exploitations[0].previousUsageCode, '2')
  t.is(result.exploitations[0].usageCode, '7')
})

test('la baseline usage vient de la précédente ancre importée, jamais de la valeur live ou d’une ancienne baseline', t => {
  const {manifest, snapshot} = fixture()
  const previousManifest = structuredClone(manifest)
  previousManifest.exploitations[0].usageCode = '17'
  previousManifest.exploitations[0].previousUsageCode = '2'
  snapshot.tables.exploitations[0].usageCode = '4'
  manifest.exploitations[0].usageCode = '7'
  const result = preserveManifestIdentities(manifest, {previousManifest, snapshot})
  t.deepEqual(result.issues, [])
  t.is(result.exploitations[0].previousUsageCode, '17')
  t.is(result.exploitations[0].usageCode, '7')
  t.false(Object.hasOwn(manifest.exploitations[0], 'previousUsageCode'))
  manifest.exploitations[0].previousUsageCode = '4'
  const withoutPrevious = preserveManifestIdentities(manifest, {snapshot})
  t.is(withoutPrevious.exploitations[0].previousUsageCode, null)
})

test('cible absente, conflit de référence ou exploitation source encore vivante ne sont pas masqués par un alias', t => {
  for (const change of [
    snapshot => { snapshot.tables.points = snapshot.tables.points.filter(point => point.id !== targetId) },
    snapshot => { snapshot.tables.externalReferences.push({...alias, pointPrelevementId: 'other'}) },
    snapshot => { snapshot.tables.exploitations.push({id: 'old-exploitation', sourceId: 'old-source-exploitation'}) }
  ]) {
    const {manifest, snapshot} = fixture()
    change(snapshot)
    const result = preserveManifestIdentities(manifest, {previousManifest: manifest, snapshot})
    t.true(result.issues.some(issue => issue.code.startsWith('IMPORT_ALIAS_')))
  }
})

test('la preuve de rapprochement utilise les UUID canoniques sans lever une collision non fusionnée', t => {
  const {snapshot} = fixture()
  const values = Array(25).fill(null)
  values[1] = '24000000396CACG_99999'
  snapshot.tables.externalReferences[1].externalId = values[1]
  snapshot.tables.externalReferences[1].pointPrelevementId = oldId
  snapshot.tables.externalReferences.push({provider: 'rives-et-eaux', kind: 'POINT', externalId: 'place', pointPrelevementId: targetId})
  const input = {pointRows: [{row: 2, values}], lieux: [{id: 'place'}], assignments: [{pointName: values[1], lieuId: 'place'}], snapshot}
  t.is(resolvePointMatches(input).get(values[1]).status, 'ACCEPTED')
  snapshot.tables.externalReferences = snapshot.tables.externalReferences.filter(ref => ref !== alias)
  t.is(resolvePointMatches(input).get(values[1]).reason, 'EXISTING_POINT_IDENTITIES_COLLIDE')
})

test('un PP explicitement retiré est exclu avant les rapprochements et ne crée pas de collision fictive', t => {
  const skipped = '24000000396CACG_99999'
  const kept = '396CACG_99999'
  const row = name => ({row: 2, values: [null, name]})
  const results = resolvePointMatches({pointRows: [row(skipped), row(kept)], lieux: [{id: 'place'}],
    assignments: [{pointName: skipped, lieuId: 'place'}, {pointName: kept, lieuId: 'place'}],
    overrides: {points: {[skipped]: {skip: true}}}, snapshot: {tables: {externalReferences: [
      {provider: 'epidropt', kind: 'POINT', externalId: skipped, pointPrelevementId: oldId},
      {provider: 'epidropt', kind: 'POINT', externalId: kept, pointPrelevementId: targetId},
      {provider: 'rives-et-eaux', kind: 'POINT', externalId: 'place', pointPrelevementId: targetId}
    ]}}})
  t.is(results.get(skipped).status, 'EXCLUDED')
  t.is(results.get(skipped).reason, 'REVIEWED_RETIREMENT')
  t.deepEqual(results.get(skipped).candidates, [])
  t.is(results.get(kept).status, 'ACCEPTED')
})

test('referenceIdentity ne confond plus tombstone et référence déplacée, mais une troisième identité bloque toujours', async t => {
  const client = {
    externalReference: {async findMany({where}) {
      if (where.provider === 'pe-import-alias') return where.externalId === oldId ? [{pointPrelevementId: targetId}] : []
      return [{pointPrelevementId: targetId, metadata: {imported: {name: 'Kept'}}}]
    }},
    pointPrelevement: {async findMany() { return [{id: oldId}] }, async findUnique() { return {id: targetId} }}
  }
  const record = {id: oldId, sourceId: 'old-source', references: [{provider: 'epidropt', externalId: 'source'}]}
  t.deepEqual(await referenceIdentity(client, record, 'POINT'), {id: targetId, imported: {name: 'Kept'}})
  client.pointPrelevement.findMany = async () => [{id: oldId}, {id: 'other'}]
  await t.throwsAsync(referenceIdentity(client, record, 'POINT'), {message: 'REFERENCES_INCOMPATIBLES'})
})

test('une exploitation fusionnée est retrouvée mais jamais recréée si sa cible manque ou si elle est retirée', async t => {
  const client = {externalReference: {async findMany() { return [alias] }}, declarantPointPrelevement: {async findMany() { return [{id: 'kept-exploitation'}] }}}
  const record = {id: 'old-exploitation', sourceId: 'old-source-exploitation'}
  t.is((await exploitationIdentity(client, record)).id, 'kept-exploitation')
  client.declarantPointPrelevement.findMany = async () => []
  await t.throwsAsync(exploitationIdentity(client, record), {message: 'IMPORT_ALIAS_TARGET_MISSING'})
  client.externalReference.findMany = async () => [{provider: 'pe-import-retired', metadata: {retiredExploitationId: record.id}}]
  await t.throwsAsync(exploitationIdentity(client, record), {message: 'EXPLOITATION_RETIREE'})
})
