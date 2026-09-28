import test from 'ava'
import {getZoneManagedResourceType, isZoneResourceCompatible, selectCompatibleSageZone, selectPointZones} from '../zone-resource-types.js'

const surface = {id: 'surface', type: 'SAGE', managedResourceType: 'SUPERFICIELLE'}
const groundwater = {id: 'groundwater', type: 'SAGE', managedResourceType: 'SOUTERRAIN'}
const transition = {id: 'transition', type: 'SAGE', managedResourceType: 'TRANSITION'}
const mixed = {id: 'mixed', type: 'SAGE', managedResourceType: 'MIXTE'}
const department = {id: 'department', type: 'DEPARTEMENT', managedResourceType: null}

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
