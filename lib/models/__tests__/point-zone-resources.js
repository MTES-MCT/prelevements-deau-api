import test from 'ava'
import {getZoneIdsForCoordinates, refreshPointPrelevementZones} from '../point-prelevement.js'
import {assertCoordinatesInZone} from '../../handlers/zone-resources.js'

const surface = {id: 'surface', type: 'SAGE', managedResourceType: 'SUPERFICIELLE'}
const groundwater = {id: 'groundwater', type: 'SAGE', managedResourceType: 'SOUTERRAIN'}
const department = {id: 'department', type: 'DEPARTEMENT', managedResourceType: null}
const coordinates = {type: 'Point', coordinates: [0.4, 44.6]}

test('le précontrôle des coordonnées ne donne pas des droits via un SAGE incompatible', async t => {
  const client = {$queryRaw: async () => [surface, groundwater, department]}
  t.deepEqual(await getZoneIdsForCoordinates(coordinates, {waterBodyType: 'SOUTERRAIN', client}), [department.id, groundwater.id])
  t.deepEqual(await getZoneIdsForCoordinates(coordinates, {waterBodyType: 'SUPERFICIELLE', client}), [department.id, surface.id])
})

test('le recalcul du modèle commun ne réintroduit pas un deuxième SAGE en édition de PP', async t => {
  const calls = []
  const client = {
    pointPrelevement: {findUnique: async () => ({waterBodyType: 'SUPERFICIELLE'})},
    $queryRaw: async () => [surface, groundwater, department],
    pointPrelevementZone: {
      deleteMany: async args => calls.push({operation: 'deleteMany', ...args}),
      createMany: async args => calls.push({operation: 'createMany', ...args})
    },
    declarantPointPrelevement: {findMany: async () => []}
  }
  t.deepEqual(await refreshPointPrelevementZones(client, 'point'), [department.id, surface.id])
  t.deepEqual(calls[1].data, [{pointPrelevementId: 'point', zoneId: department.id}, {pointPrelevementId: 'point', zoneId: surface.id}])
})

test('une ambiguïté du modèle commun échoue avant la suppression des rattachements existants', async t => {
  let touched = false
  const client = {
    pointPrelevement: {findUnique: async () => ({waterBodyType: 'SUPERFICIELLE'})},
    $queryRaw: async () => [surface, {...surface, id: 'other'}],
    pointPrelevementZone: {deleteMany: async () => { touched = true }}
  }
  const error = await t.throwsAsync(refreshPointPrelevementZones(client, 'point'))
  t.is(error.status, 409)
  t.false(touched)
})

test('la route PP dans une zone précontrôle le milieu effectif avant toute écriture', async t => {
  const calls = []
  const findZoneIds = async (receivedCoordinates, options) => {
    calls.push({receivedCoordinates, options})
    return [groundwater.id, department.id]
  }
  const error = await t.throwsAsync(assertCoordinatesInZone(surface.id, coordinates, 'SOUTERRAIN', {findZoneIds}))
  t.is(error.status, 400)
  t.deepEqual(calls[0], {receivedCoordinates: coordinates, options: {waterBodyType: 'SOUTERRAIN'}})
  await t.notThrowsAsync(assertCoordinatesInZone(groundwater.id, coordinates, 'SOUTERRAIN', {findZoneIds}))
})
