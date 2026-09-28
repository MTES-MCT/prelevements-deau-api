import test from 'ava'
import {inspectDroptPointZones, planDroptPointZones, synchronizeDroptPointZones} from '../point-zones.js'

const DROPT = {id: 'dropt', code: 'sage-SAGE05024', type: 'SAGE', name: 'Dropt', managedResourceType: 'MIXTE'}
const GIRONDE = {id: 'gironde', code: 'sage-SAGE05003', type: 'SAGE', name: 'Nappes profondes de Gironde', managedResourceType: 'SOUTERRAIN'}
const GARONNE = {id: 'garonne', code: 'sage-SAGE05009', type: 'SAGE', name: 'Vallée de la Garonne', managedResourceType: 'SUPERFICIELLE'}
const OTHER = {id: 'other', code: 'SAGE_TEST', type: 'SAGE', name: 'Autre SAGE', managedResourceType: 'MIXTE'}
const DEPARTMENT = {id: 'department', code: '47', type: 'DEPARTEMENT', name: 'Département', managedResourceType: null}
const REGION = {id: 'region', code: '75', type: 'REGION', name: 'Région', managedResourceType: null}
const POINT = {id: 'point', waterBodyType: 'SUPERFICIELLE', coordinates: [0.4, 44.6]}

function plan(options = {}) {
  return planDroptPointZones({point: POINT, candidates: [DROPT, GIRONDE], currentZones: [], ...options})
}

for (const [waterBodyType, selected] of [['SOUTERRAIN', GIRONDE], ['SUPERFICIELLE', DROPT]]) {
  test(`le chevauchement Dropt/Gironde choisit un seul SAGE pour ${waterBodyType}`, t => {
    const result = plan({point: {...POINT, waterBodyType}})
    t.is(result.reason, waterBodyType === 'SOUTERRAIN' ? 'SPECIALIZED_SAGE_PRIORITY' : 'SINGLE_COMPATIBLE_SAGE')
    t.deepEqual(result.selectedSage, selected)
    t.deepEqual(result.after, [selected])
    t.true(result.candidates.some(zone => zone.id === result.selectedSage.id))
  })
}

for (const [waterBodyType, selected] of [['SOUTERRAIN', GIRONDE], ['SUPERFICIELLE', GARONNE]]) {
  test(`le chevauchement Garonne/Gironde explicitement validé choisit un seul SAGE pour ${waterBodyType}`, t => {
    const result = plan({point: {...POINT, waterBodyType}, candidates: [GIRONDE, GARONNE]})
    t.is(result.reason, 'SINGLE_COMPATIBLE_SAGE')
    t.deepEqual(result.selectedSage, selected)
    t.deepEqual(result.after, [selected])
    t.true(result.candidates.some(zone => zone.id === result.selectedSage.id))
  })
}

test('un candidat géométrique incompatible ne peut pas recevoir le point, même seul', t => {
  for (const result of [
    plan({candidates: [GARONNE], point: {...POINT, waterBodyType: 'SOUTERRAIN'}}),
    plan({candidates: [GIRONDE]}),
    plan({candidates: [GIRONDE, GARONNE], point: {...POINT, waterBodyType: 'TRANSITION'}})
  ]) {
    t.deepEqual(result.after, [])
    t.is(result.reason, 'NO_COMPATIBLE_SAGE')
  }
})

test('le SAGE mixte accepte tous les milieux et un SAGE de transition reste limité à la transition', t => {
  for (const waterBodyType of ['SUPERFICIELLE', 'SOUTERRAIN', 'TRANSITION']) {
    t.deepEqual(plan({candidates: [OTHER], point: {...POINT, waterBodyType}}).after, [OTHER])
  }
  const transition = {...OTHER, managedResourceType: 'TRANSITION'}
  t.deepEqual(plan({candidates: [transition], point: {...POINT, waterBodyType: 'TRANSITION'}}).after, [transition])
  t.deepEqual(plan({candidates: [transition]}).after, [])
  t.deepEqual(plan({candidates: [OTHER]}).after, [OTHER])
})

test('le choix dépend de l’attribut PE, jamais du nom ou du code du SAGE', t => {
  const changed = {...DROPT, managedResourceType: 'SOUTERRAIN'}
  t.deepEqual(plan({candidates: [changed]}).after, [])
  t.deepEqual(plan({candidates: [changed], point: {...POINT, waterBodyType: 'SOUTERRAIN'}}).after, [changed])
  t.deepEqual(plan({candidates: [{...OTHER, managedResourceType: null}]}).after, [OTHER])
})

test('zéro candidat ne fabrique aucun SAGE et rapporte la suppression des anciens liens non traçables', t => {
  const result = plan({candidates: [], currentZones: [DROPT, DEPARTMENT]})
  t.is(result.reason, 'NO_GEOMETRIC_SAGE')
  t.is(result.selectedSage, null)
  t.deepEqual(result.after, [DEPARTMENT])
  t.deepEqual(result.removed, [DROPT])
  t.deepEqual(result.untraceableRemovedSageLinks, [DROPT])
  t.deepEqual(result.warnings, ['REMOVED_SAGE_LINK_PROVENANCE_UNKNOWN'])
})

test('plusieurs mixtes sans spécialisé ou plusieurs spécialisés compatibles restent explicitement ambigus', t => {
  for (const candidates of [[DROPT, OTHER], [DROPT, GIRONDE, OTHER], [GARONNE, {...GARONNE, id: 'second-surface'}], [DROPT, GARONNE, {...GARONNE, id: 'second-surface'}]]) {
    const result = plan({candidates, currentZones: [DEPARTMENT, OTHER]})
    t.is(result.reason, 'SAGE_CANDIDATES_AMBIGUOUS')
    t.is(result.selectedSage, null)
    t.deepEqual(result.after, result.before)
    t.deepEqual(result.added, [])
    t.deepEqual(result.removed, [])
  }
})

test('un PP souterrain hors de Nappes profondes reste dans le Dropt mixte candidat géographique', t => {
  const result = plan({point: {...POINT, waterBodyType: 'SOUTERRAIN'}, candidates: [DROPT], currentZones: [DROPT]})
  t.is(result.reason, 'SINGLE_COMPATIBLE_SAGE')
  t.deepEqual(result.after, [DROPT])
  t.deepEqual(result.removed, [])
})

test('un rejeu corrige les deux SAGE et conserve tous les liens non-SAGE existants', t => {
  const result = plan({currentZones: [REGION, GIRONDE, DEPARTMENT, DROPT]})
  t.deepEqual(result.after, [DEPARTMENT, DROPT, REGION])
  t.deepEqual(result.removed, [GIRONDE])
  t.deepEqual(result.added, [])
  const replay = plan({currentZones: result.after})
  t.deepEqual(replay.added, [])
  t.deepEqual(replay.removed, [])
  t.deepEqual(replay.warnings, [])
})

test('création ou correction importée des coordonnées actualise aussi les zones administratives', t => {
  const result = plan({candidates: [DROPT, GIRONDE, REGION], currentZones: [DEPARTMENT], refreshNonSageZones: true})
  t.deepEqual(result.after, [DROPT, REGION])
  t.deepEqual(result.removed, [DEPARTMENT])
  t.deepEqual(result.added, [DROPT, REGION])
})

test('les décisions et leur preuve sont stables quel que soit l’ordre des zones', t => {
  t.deepEqual(plan({candidates: [GIRONDE, DROPT], currentZones: [GIRONDE, DROPT, REGION]}),
    plan({candidates: [DROPT, GIRONDE], currentZones: [REGION, DROPT, GIRONDE]}))
})

function databaseFixture({point = POINT, candidates = [DROPT, GIRONDE], currentZones = [DEPARTMENT, DROPT, GIRONDE]} = {}) {
  const queries = []
  const mutations = []
  let zones = [...currentZones]
  const client = {
    async $queryRaw(strings, ...values) {
      const sql = strings.join('?')
      queries.push({sql, values})
      if (sql.includes('ST_Intersects')) return candidates
      return [{id: point.id, waterBodyType: point.waterBodyType, x: point.coordinates?.[0] ?? null, y: point.coordinates?.[1] ?? null}]
    },
    pointPrelevementZone: {
      async findMany() { return zones.map(zone => ({zoneId: zone.id, zone})) },
      async deleteMany({where}) {
        mutations.push({operation: 'deleteMany', where})
        zones = zones.filter(zone => !where.zoneId.in.includes(zone.id))
      },
      async createMany({data, skipDuplicates}) {
        mutations.push({operation: 'createMany', data, skipDuplicates})
        zones.push(...data.map(link => candidates.find(zone => zone.id === link.zoneId)))
      }
    }
  }
  return {client, queries, mutations, getZones: () => zones}
}

test('la synchronisation relit le milieu et les coordonnées réels avant de retirer seulement le SAGE incorrect', async t => {
  const db = databaseFixture({point: {...POINT, waterBodyType: 'SOUTERRAIN', coordinates: [0.5, 44.7]}})
  const changes = []
  const decisions = []
  await synchronizeDroptPointZones(db.client, POINT.id, {changes, decisions, refreshNonSageZones: false})
  t.deepEqual(db.getZones(), [DEPARTMENT, GIRONDE])
  t.deepEqual(db.mutations, [{operation: 'deleteMany', where: {pointPrelevementId: POINT.id, zoneId: {in: [DROPT.id]}}}])
  t.deepEqual(decisions[0].coordinates, [0.5, 44.7])
  t.is(decisions[0].waterBodyType, 'SOUTERRAIN')
  t.is(changes[0].action, 'ZONES_UPDATED')
  t.true(db.queries[1].sql.includes('ST_Intersects(z.coordinates, p.coordinates)'))
  t.deepEqual(db.queries[1].values, [POINT.id])
  await synchronizeDroptPointZones(db.client, POINT.id, {changes, decisions, refreshNonSageZones: false})
  t.is(db.mutations.length, 1)
  t.is(changes.length, 1)
  t.is(decisions.length, 2)
})

test('une ambiguïté ne réalise aucune écriture et conserve la preuve des candidats dans le rapport', async t => {
  const db = databaseFixture({candidates: [DROPT, OTHER]})
  const changes = []
  const decisions = []
  await t.throwsAsync(synchronizeDroptPointZones(db.client, POINT.id, {changes, decisions}), {message: 'SAGE_CANDIDATES_AMBIGUOUS'})
  t.deepEqual(db.mutations, [])
  t.deepEqual(changes, [])
  t.is(decisions.length, 1)
  t.deepEqual(decisions[0].candidates, [DROPT, OTHER])
})

test('inspection seule sans coordonnées ne choisit aucun SAGE et ne modifie rien', async t => {
  const db = databaseFixture({point: {...POINT, coordinates: null}, candidates: [], currentZones: [DEPARTMENT]})
  const decision = await inspectDroptPointZones(db.client, POINT.id)
  t.is(decision.reason, 'NO_GEOMETRIC_SAGE')
  t.is(decision.coordinates, null)
  t.deepEqual(decision.after, [DEPARTMENT])
  t.deepEqual(db.mutations, [])
})
