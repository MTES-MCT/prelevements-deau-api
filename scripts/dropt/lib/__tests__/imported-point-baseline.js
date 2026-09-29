import test from 'ava'
import {applyManifest, referenceIdentity} from '../apply-epidropt.js'
import {digest, FORMAT_VERSION, SCOPE, stableId} from '../epidropt.js'

const pointId = stableId('baseline-synthetic-survivor')
const donorId = stableId('baseline-synthetic-donor')
const canonical = {name: 'Survivant synthétique', flowType: 'PRELEVEMENT', waterBodyType: 'SUPERFICIELLE', coordinates: [0.4, 44.6]}
const donated = {name: 'Donneur synthétique', flowType: 'PRELEVEMENT', waterBodyType: 'SOUTERRAIN', coordinates: [0.5, 44.7]}
const incoming = {name: 'Nouvelle valeur importée', flowType: 'PRELEVEMENT', waterBodyType: 'TRANSITION'}

function fixture({manual = false, ownReference = true, legacyManifest = false, reverse = false} = {}) {
  let state = {point: {id: pointId, sourceId: 'dropt-epidropt:point:synthetic-survivor',
    name: manual ? donated.name : canonical.name, flowType: canonical.flowType, waterBodyType: manual ? donated.waterBodyType : canonical.waterBodyType},
  coordinates: [...(manual ? donated.coordinates : canonical.coordinates)], references: [
    {id: stableId('baseline-donor-reference'), provider: 'epidropt', scope: SCOPE, kind: 'POINT', externalId: 'synthetic-donor',
      pointPrelevementId: pointId, metadata: {mergedFromPointId: donorId, imported: donated}},
    ...(ownReference ? [{id: stableId('baseline-canonical-reference'), provider: 'rives-et-eaux', scope: SCOPE, kind: 'POINT',
      externalId: 'synthetic-canonical', pointPrelevementId: pointId, metadata: {imported: canonical}}] : [])
  ]}
  if (reverse) state.references.reverse()
  const record = {id: pointId, sourceId: state.point.sourceId, data: incoming, coordinates: [0.6, 44.8],
    references: [{provider: 'epidropt', externalId: 'synthetic-donor'},
      ...(!legacyManifest && ownReference ? [{provider: 'rives-et-eaux', externalId: 'synthetic-canonical'}] : [])]}
  const payload = {formatVersion: FORMAT_VERSION, scope: SCOPE, points: [record],
    declarants: [], exploitations: [], meters: [], allocations: [], issues: []}
  let savepoint
  const client = {
    async $transaction(execute) {
      const before = structuredClone(state)
      try { return await execute(client) } catch (error) { state = before; throw error }
    },
    async $queryRaw(strings) {
      const sql = strings.join('?')
      if (sql.includes('FOR UPDATE')) return [{id: pointId}]
      if (sql.includes('ST_Intersects')) return []
      if (sql.includes('ST_X(coordinates)')) return [{...state.point, x: state.coordinates[0], y: state.coordinates[1]}]
      throw new Error('Unexpected synthetic query')
    },
    async $executeRaw(strings, ...parameters) {
      if (strings.join('?').includes('UPDATE "PointPrelevement"')) state.coordinates = parameters.slice(0, 2)
      return 0
    },
    async $executeRawUnsafe(sql) {
      if (sql === 'SAVEPOINT dropt_object') savepoint = structuredClone(state)
      if (sql === 'ROLLBACK TO SAVEPOINT dropt_object') state = savepoint
      return 0
    },
    pointPrelevement: {
      async findMany() { return [{id: pointId}] },
      async findUnique({where}) { return where.id === pointId || where.name === state.point.name ? structuredClone(state.point) : null },
      async update({data}) { Object.assign(state.point, data) }
    },
    externalReference: {
      async findMany({where}) {
        if (where.provider === 'pe-import-alias') return []
        return structuredClone(state.references.filter(reference => where.pointPrelevementId
          ? reference.pointPrelevementId === where.pointPrelevementId
          : where.OR.some(identity => identity.provider === reference.provider && identity.externalId === reference.externalId)))
      },
      async findUnique({where}) {
        const identity = where.provider_scope_kind_externalId
        return structuredClone(state.references.find(reference => reference.provider === identity.provider && reference.externalId === identity.externalId) ?? null)
      },
      async upsert({where, update, create}) {
        const identity = where.provider_scope_kind_externalId
        const reference = state.references.find(reference => reference.provider === identity.provider && reference.externalId === identity.externalId)
        if (reference) Object.assign(reference, structuredClone(update))
        else state.references.push(structuredClone(create))
      }
    },
    pointPrelevementZone: {async findMany() { return [] }},
    meterAllocation: {async findMany() { return [] }}
  }
  return {client, record, manifest: {...payload, manifestHash: digest(payload)}, getState: () => state}
}

test('la baseline du survivant reste prioritaire quel que soit l’ordre des références déplacées', async t => {
  for (const reverse of [false, true]) {
    const db = fixture({reverse})
    const identity = await referenceIdentity(db.client, db.record, 'POINT')
    t.is(identity.id, pointId)
    t.deepEqual(identity.imported, canonical)
  }
})

test('un ancien manifeste limité au donneur récupère la baseline propre au PP canonique', async t => {
  const db = fixture({legacyManifest: true})
  const identity = await referenceIdentity(db.client, db.record, 'POINT')
  t.deepEqual(identity.imported, canonical)
})

test('la référence Rives propre au survivant prime sur une autre baseline canonique', async t => {
  const db = fixture()
  db.getState().references[0].metadata = {imported: donated}
  t.deepEqual((await referenceIdentity(db.client, db.record, 'POINT')).imported, canonical)
})

test('sans baseline canonique connue, celle du donneur ne devient jamais un droit d’écraser', async t => {
  const db = fixture({ownReference: false})
  const before = structuredClone(db.getState())
  t.is((await referenceIdentity(db.client, db.record, 'POINT')).imported, undefined)
  const result = await applyManifest(db.client, db.manifest, {apply: true})
  t.true(result.complete)
  t.deepEqual(db.getState().point, before.point)
  t.deepEqual(db.getState().coordinates, before.coordinates)
})

test('les valeurs encore identiques à la baseline canonique sont bien actualisées après fusion', async t => {
  const db = fixture()
  const result = await applyManifest(db.client, db.manifest, {apply: true})
  t.true(result.complete)
  t.is(db.getState().point.name, incoming.name)
  t.is(db.getState().point.waterBodyType, incoming.waterBodyType)
  t.deepEqual(db.getState().coordinates, [0.6, 44.8])
  t.is(db.getState().references.find(reference => reference.provider === 'epidropt').metadata.mergedFromPointId, donorId)
})

test('une correction manuelle du survivant égale à l’ancienne valeur du donneur demeure préservée', async t => {
  const db = fixture({manual: true})
  const before = structuredClone(db.getState())
  const result = await applyManifest(db.client, db.manifest, {apply: true})
  t.true(result.complete)
  t.deepEqual(db.getState().point, before.point)
  t.deepEqual(db.getState().coordinates, before.coordinates)
  t.false(result.changes.some(change => ['UPDATED', 'COORDINATES_UPDATED'].includes(change.action)))
})
