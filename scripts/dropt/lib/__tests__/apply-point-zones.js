import test from 'ava'
import {applyManifest, verifyManifest} from '../apply-epidropt.js'
import {digest, FORMAT_VERSION, SCOPE, stableId} from '../epidropt.js'

const POINT_ID = stableId('sage-unit-point')
const DROPT = {id: stableId('sage-unit-dropt'), code: 'sage-SAGE05024', type: 'SAGE', name: 'Dropt', managedResourceType: 'MIXTE'}
const GIRONDE = {id: stableId('sage-unit-gironde'), code: 'sage-SAGE05003', type: 'SAGE', name: 'Nappes profondes de Gironde', managedResourceType: 'SOUTERRAIN'}
const GARONNE = {id: stableId('sage-unit-garonne'), code: 'sage-SAGE05009', type: 'SAGE', name: 'Vallée de la Garonne', managedResourceType: 'SUPERFICIELLE'}
const DEPARTMENT = {id: stableId('sage-unit-department'), code: '47', type: 'DEPARTEMENT', name: 'Département', managedResourceType: null}
const OTHER = {id: stableId('sage-unit-other'), code: 'SAGE_TEST', type: 'SAGE', name: 'Autre SAGE', managedResourceType: 'MIXTE'}
const INITIAL_DATA = {name: 'Point fictif', flowType: 'PRELEVEMENT', waterBodyType: 'SUPERFICIELLE'}
const INITIAL_COORDINATES = [0.4, 44.6]

function manifest({data = INITIAL_DATA, coordinates = INITIAL_COORDINATES} = {}) {
  const payload = {formatVersion: FORMAT_VERSION, scope: SCOPE, issues: [],
    points: [{id: POINT_ID, sourceId: 'dropt-unit-point', data, coordinates,
      references: [{provider: 'epidropt', externalId: 'sage-unit-point'}]}],
    declarants: [], exploitations: [], meters: [], allocations: []}
  return {...payload, manifestHash: digest(payload)}
}

// Transactional in-memory fixture: it never connects to a database. The outer
// transaction and object savepoint both restore their exact state on rollback.
function databaseFixture() {
  let state = {
    point: {id: POINT_ID, sourceId: 'dropt-unit-point', ...INITIAL_DATA},
    coordinates: [...INITIAL_COORDINATES],
    imported: {...INITIAL_DATA, coordinates: [...INITIAL_COORDINATES]},
    candidates: [DROPT, GIRONDE, DEPARTMENT],
    links: [DROPT, GIRONDE, DEPARTMENT]
  }
  let savepoint
  const client = {
    async $transaction(execute) {
      const before = structuredClone(state)
      try {
        return await execute(client)
      } catch (error) {
        state = before
        throw error
      }
    },
    async $queryRaw(strings) {
      const sql = strings.join('?')
      if (sql.includes('FOR UPDATE')) return [{id: POINT_ID}]
      if (sql.includes('ST_Intersects')) return structuredClone(state.candidates)
      if (sql.includes('ST_X(coordinates)')) return [{...state.point, x: state.coordinates[0], y: state.coordinates[1]}]
      throw new Error('Unexpected fixture query')
    },
    async $executeRaw(strings, ...values) {
      if (strings.join('?').includes('UPDATE "PointPrelevement"')) state.coordinates = values.slice(0, 2)
      return 0
    },
    async $executeRawUnsafe(sql) {
      if (sql === 'SAVEPOINT dropt_object') savepoint = structuredClone(state)
      if (sql === 'ROLLBACK TO SAVEPOINT dropt_object') state = savepoint
      return 0
    },
    pointPrelevement: {
      async findMany() { return [{id: POINT_ID}] },
      async findUnique({where}) {
        return where.id === POINT_ID || where.name === state.point.name ? structuredClone(state.point) : null
      },
      async update({data}) { Object.assign(state.point, data) }
    },
    externalReference: {
      async findMany({where}) { return where.provider === 'pe-import-alias' ? [] : [{pointPrelevementId: POINT_ID, metadata: {imported: state.imported}}] },
      async findUnique() { return {pointPrelevementId: POINT_ID, metadata: {imported: state.imported}} },
      async upsert({update}) { state.imported = structuredClone(update.metadata.imported) }
    },
    pointPrelevementZone: {
      async findMany() { return state.links.map(zone => ({zoneId: zone.id, zone})) },
      async deleteMany({where}) { state.links = state.links.filter(zone => !where.zoneId.in.includes(zone.id)) },
      async createMany({data}) { state.links.push(...data.map(link => state.candidates.find(zone => zone.id === link.zoneId))) }
    },
    meterAllocation: {async findMany() { return [] }}
  }
  return {client, getState: () => state}
}

test('rejeu sans correction des coordonnées : simulation puis application corrigent les SAGE, sans toucher DEP', async t => {
  const db = databaseFixture()
  const input = manifest()
  const before = structuredClone(db.getState())
  const preview = await applyManifest(db.client, input)
  t.true(preview.complete)
  t.false(preview.applied)
  t.deepEqual(db.getState(), before)
  t.is(preview.changes.length, 1)
  t.is(preview.changes[0].action, 'ZONES_UPDATED')
  t.false(preview.pointZoneDecisions[0].refreshNonSageZones)
  const result = await applyManifest(db.client, input, {apply: true, expectedReport: preview})
  t.true(result.applied)
  t.deepEqual(db.getState().links, [DROPT, DEPARTMENT])
  t.deepEqual(result.objectIds.points, [POINT_ID])
  const replay = await applyManifest(db.client, input, {apply: true})
  t.true(replay.complete)
  t.deepEqual(replay.changes, [])
  t.true((await verifyManifest(db.client, input, {report: result})).complete)
})

test('les corrections manuelles de milieu et coordonnées sont préservées et gouvernent le choix du SAGE', async t => {
  const db = databaseFixture()
  db.getState().point.waterBodyType = 'SOUTERRAIN'
  db.getState().coordinates = [0.5, 44.7]
  db.getState().candidates = [DROPT, GIRONDE]
  const result = await applyManifest(db.client, manifest(), {apply: true})
  t.true(result.complete)
  t.is(db.getState().point.waterBodyType, 'SOUTERRAIN')
  t.deepEqual(db.getState().coordinates, [0.5, 44.7])
  t.deepEqual(db.getState().links, [GIRONDE, DEPARTMENT])
  t.is(result.pointZoneDecisions[0].waterBodyType, 'SOUTERRAIN')
  t.deepEqual(result.pointZoneDecisions[0].coordinates, [0.5, 44.7])
  t.false(result.pointZoneDecisions[0].refreshNonSageZones)
})

test('le rejeu retire Nappes profondes pour un point de surface dans Garonne sans inventer un lien au Dropt', async t => {
  const db = databaseFixture()
  db.getState().candidates = [GARONNE, GIRONDE, DEPARTMENT]
  db.getState().links = [GARONNE, GIRONDE, DEPARTMENT]
  const result = await applyManifest(db.client, manifest(), {apply: true})
  t.true(result.complete)
  t.deepEqual(db.getState().links, [GARONNE, DEPARTMENT])
  t.is(result.pointZoneDecisions[0].reason, 'SINGLE_COMPATIBLE_SAGE')
  t.deepEqual(result.pointZoneDecisions[0].removed, [GIRONDE])
  t.deepEqual(result.pointZoneDecisions[0].added, [])
})

test('une correction importée de coordonnées actualise les zones administratives comme avant', async t => {
  const db = databaseFixture()
  db.getState().candidates = [DROPT, GIRONDE]
  const result = await applyManifest(db.client, manifest({coordinates: [0.5, 44.7]}), {apply: true})
  t.true(result.complete)
  t.deepEqual(db.getState().coordinates, [0.5, 44.7])
  t.deepEqual(db.getState().links, [DROPT])
  t.true(result.pointZoneDecisions[0].refreshNonSageZones)
  t.true(result.changes.some(change => change.action === 'COORDINATES_UPDATED'))
})

test('la mise à jour importée du milieu est prise en compte sans attendre une nouvelle coordonnée', async t => {
  const db = databaseFixture()
  const input = manifest({data: {...INITIAL_DATA, waterBodyType: 'SOUTERRAIN'}})
  const result = await applyManifest(db.client, input, {apply: true})
  t.true(result.complete)
  t.is(db.getState().point.waterBodyType, 'SOUTERRAIN')
  t.deepEqual(db.getState().links, [GIRONDE, DEPARTMENT])
  t.false(result.pointZoneDecisions[0].refreshNonSageZones)
})

test('une ambiguïté annule toute la transaction, y compris une correction de milieu déjà préparée', async t => {
  const db = databaseFixture()
  db.getState().candidates = [DROPT, GIRONDE, {...OTHER, managedResourceType: 'SOUTERRAIN'}]
  const before = structuredClone(db.getState())
  const result = await applyManifest(db.client, manifest({data: {...INITIAL_DATA, waterBodyType: 'SOUTERRAIN'}}), {apply: true})
  t.false(result.applied)
  t.false(result.complete)
  t.deepEqual(result.changes, [])
  t.is(result.executionIssues[0].code, 'SAGE_CANDIDATES_AMBIGUOUS')
  t.is(result.pointZoneDecisions[0].candidates.length, 3)
  t.deepEqual(db.getState(), before)
})

test('une dérive des coordonnées entre simulation et application invalide la preuve même si le SAGE choisi reste identique', async t => {
  const db = databaseFixture()
  const input = manifest()
  const preview = await applyManifest(db.client, input)
  db.getState().coordinates = [0.5, 44.7]
  const before = structuredClone(db.getState())
  const result = await applyManifest(db.client, input, {apply: true, expectedReport: preview})
  t.false(result.applied)
  t.false(result.complete)
  t.true(result.executionIssues.some(issue => issue.code === 'DRY_RUN_STATE_CHANGED'))
  t.deepEqual(db.getState(), before)
})

test('verify détecte les anciens doubles rattachements et reste en lecture seule', async t => {
  const db = databaseFixture()
  const before = structuredClone(db.getState())
  const result = await verifyManifest(db.client, manifest())
  t.false(result.complete)
  t.is(result.issues[0].code, 'SAGE_ZONE_DIFFERENTE')
  t.deepEqual(db.getState(), before)
})

test('aucun candidat SAGE : ne rattache pas le PP au Dropt par défaut et rapporte son absence', async t => {
  const db = databaseFixture()
  db.getState().candidates = [DEPARTMENT]
  const result = await applyManifest(db.client, manifest(), {apply: true})
  t.true(result.complete)
  t.deepEqual(db.getState().links, [DEPARTMENT])
  t.is(result.pointZoneDecisions[0].reason, 'NO_GEOMETRIC_SAGE')
  t.is(result.pointZoneDecisions[0].selectedSage, null)
  t.is(result.pointZoneDecisions[0].untraceableRemovedSageLinks.length, 2)
})

test('le conflit de configuration du chevauchement annule les champs préparés et bloque aussi verify', async t => {
  const db = databaseFixture()
  db.getState().candidates = [
    {...OTHER, id: 'roussillon', code: 'sage-SAGE06028'},
    {...OTHER, id: 'tech', code: 'sage-SAGE06030', managedResourceType: 'SOUTERRAIN'}
  ]
  const before = structuredClone(db.getState())
  const input = manifest({data: {...INITIAL_DATA, usageName: 'Ne doit pas être enregistré'}})
  const result = await applyManifest(db.client, input, {apply: true})
  t.false(result.applied)
  t.false(result.complete)
  t.deepEqual(result.changes, [])
  t.is(result.executionIssues[0].code, 'SAGE_OVERLAP_RESOURCE_CONFLICT')
  t.deepEqual(db.getState(), before)
  const verification = await verifyManifest(db.client, input)
  t.false(verification.complete)
  t.is(verification.issues[0].code, 'SAGE_OVERLAP_RESOURCE_CONFLICT')
  t.deepEqual(db.getState(), before)
})
