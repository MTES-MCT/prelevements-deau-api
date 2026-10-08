import test from 'ava'
import {getZoneManagedResourceType, isSageSelectionBlocked, isZoneResourceCompatible, selectCompatibleSageZone, selectPointZones} from '../zone-resource-types.js'

const surface = {id: 'surface', type: 'SAGE', managedResourceType: 'SUPERFICIELLE'}
const groundwater = {id: 'groundwater', type: 'SAGE', managedResourceType: 'SOUTERRAIN'}
const transition = {id: 'transition', type: 'SAGE', managedResourceType: 'TRANSITION'}
const mixed = {id: 'mixed', type: 'SAGE', managedResourceType: 'MIXTE'}
const department = {id: 'department', type: 'DEPARTEMENT', managedResourceType: null}
const roussillon = {...mixed, id: 'roussillon', code: 'sage-SAGE06028'}
const tech = {...mixed, id: 'tech', code: 'sage-SAGE06030'}

test('le type géré est propre aux SAGE et son défaut conserve la compatibilité historique', t => {
  t.is(getZoneManagedResourceType({...surface, managedResourceType: null}), 'MIXTE')
  t.is(getZoneManagedResourceType({...department, managedResourceType: 'SOUTERRAIN'}), null)
  for (const waterBodyType of ['SUPERFICIELLE', 'SOUTERRAIN', 'TRANSITION']) {
    t.true(isZoneResourceCompatible(mixed, waterBodyType))
    t.true(isZoneResourceCompatible(department, waterBodyType))
    t.deepEqual(selectPointZones([mixed, department], waterBodyType), [department, mixed])
  }
})

test('la sélection générique filtre la ressource parmi les seuls candidats géométriques', t => {
  for (const zone of [surface, groundwater, transition]) {
    t.deepEqual(selectPointZones([surface, groundwater, transition, department], zone.managedResourceType), [department, zone])
  }
  t.deepEqual(selectPointZones([surface, department], 'SOUTERRAIN'), [department])
  t.is(selectCompatibleSageZone([surface], 'SOUTERRAIN').reason, 'NO_COMPATIBLE_SAGE')
  t.is(selectCompatibleSageZone([department], 'SUPERFICIELLE').reason, 'NO_GEOMETRIC_SAGE')
})

test('un seul SAGE spécialisé compatible est prioritaire sur les SAGE mixtes', t => {
  for (const zone of [surface, groundwater, transition]) {
    for (const candidates of [[mixed, zone], [zone, mixed], [mixed, {...mixed, id: 'second-mixed'}, zone]]) {
      const result = selectCompatibleSageZone(candidates, zone.managedResourceType)
      t.is(result.reason, 'SPECIALIZED_SAGE_PRIORITY')
      t.deepEqual(result.selectedSage, zone)
      t.deepEqual(result.compatibleCandidates, candidates)
      t.deepEqual(selectPointZones([...candidates, department], zone.managedResourceType), [department, zone])
    }
  }
  t.deepEqual(selectPointZones([mixed, groundwater], 'SUPERFICIELLE'), [mixed])
})

test('plusieurs spécialisés compatibles ou plusieurs mixtes sans spécialisé restent ambigus', t => {
  for (const candidates of [[surface, {...surface, id: 'second-surface'}], [mixed, surface, {...surface, id: 'second-surface'}], [mixed, {...mixed, id: 'second-mixed'}]]) {
    const error = t.throws(() => selectPointZones(candidates, 'SUPERFICIELLE'))
    t.is(error.status, 409)
    t.is(error.data.code, 'SAGE_CANDIDATES_AMBIGUOUS')
    t.deepEqual(error.data.candidateZoneIds, candidates.map(zone => zone.id))
  }
})

test('le chevauchement Roussillon et Tech choisit seulement le SAGE du milieu sans modifier les candidats', t => {
  for (const [waterBodyType, target] of [['SUPERFICIELLE', tech], ['SOUTERRAIN', roussillon]]) {
    for (const candidates of [[roussillon, tech, department], [department, tech, roussillon]]) {
      const before = structuredClone(candidates)
      const result = selectCompatibleSageZone(candidates, waterBodyType)
      t.is(result.reason, 'SAGE_OVERLAP_RESOURCE_PRIORITY')
      t.false(isSageSelectionBlocked(result.reason))
      t.deepEqual(result.compatibleCandidates, [target])
      t.deepEqual(result.selectedSage, target)
      t.deepEqual(selectPointZones(candidates, waterBodyType), [department, target])
      t.deepEqual(candidates, before)
    }
  }
})

test('hors chevauchement, transition et milieu absent conservent la sélection générique', t => {
  for (const zone of [roussillon, tech]) {
    for (const waterBodyType of ['SUPERFICIELLE', 'SOUTERRAIN', 'TRANSITION', null, undefined]) {
      t.deepEqual(selectPointZones([department, zone], waterBodyType), [department, zone])
    }
  }
  for (const waterBodyType of ['TRANSITION', null, undefined]) {
    t.is(selectCompatibleSageZone([roussillon, tech], waterBodyType).reason, 'SAGE_CANDIDATES_AMBIGUOUS')
  }
  t.deepEqual(selectPointZones([roussillon, tech, transition], 'TRANSITION'), [transition])
  t.is(selectCompatibleSageZone([{...roussillon, code: 'another'}, tech], 'SUPERFICIELLE').reason, 'SAGE_CANDIDATES_AMBIGUOUS')
})

test('une configuration incompatible du SAGE désigné bloque sans se rabattre sur son voisin', t => {
  for (const [waterBodyType, candidates] of [
    ['SUPERFICIELLE', [roussillon, {...tech, managedResourceType: 'SOUTERRAIN'}]],
    ['SOUTERRAIN', [{...roussillon, managedResourceType: 'SUPERFICIELLE'}, tech]]
  ]) {
    const selection = selectCompatibleSageZone(candidates, waterBodyType)
    t.is(selection.reason, 'SAGE_OVERLAP_RESOURCE_CONFLICT')
    t.true(isSageSelectionBlocked(selection.reason))
    t.is(selection.selectedSage, null)
    const error = t.throws(() => selectPointZones(candidates, waterBodyType))
    t.is(error.status, 409)
    t.is(error.data.code, selection.reason)
  }
})

test('un troisième SAGE compatible interdit tout arbitrage supplémentaire dans le chevauchement', t => {
  for (const third of [mixed, surface]) {
    for (const target of [tech, {...tech, managedResourceType: 'SUPERFICIELLE'}]) {
      const selection = selectCompatibleSageZone([roussillon, target, third], 'SUPERFICIELLE')
      t.is(selection.reason, 'SAGE_CANDIDATES_AMBIGUOUS')
      t.is(selection.selectedSage, null)
      t.deepEqual(selection.compatibleCandidates, [target, third])
      t.is(t.throws(() => selectPointZones([roussillon, target, third], 'SUPERFICIELLE')).status, 409)
    }
  }
  t.deepEqual(selectPointZones([roussillon, tech, groundwater, department], 'SUPERFICIELLE'), [department, tech])
})
