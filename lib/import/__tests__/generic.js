import test from 'ava'

import {parseGeometry} from '../generic.js'

test('parseGeometry / geom', t => {
  const geom = '01010000209F0B0000014A09BAA91A1441640CA4DFE3335D41'
  t.deepEqual(parseGeometry(geom, {}), {
    type: 'Point',
    coordinates: [55.356_377, -21.195_673]
  })
})

test('parseGeometry / broken geom', t => {
  const geom = 'boom'
  t.throws(() => parseGeometry(geom, {}), {message: 'Erreur de parsing de la géométrie : Attempt to access memory outside buffer bounds'})
})

test('parseGeomtry / empty geom', t => {
  t.is(parseGeometry(null, {}), undefined)
})

test('parseGeometry / lon-lat fallback', t => {
  t.deepEqual(parseGeometry(null, {lon: 1, lat: 2}), {
    type: 'Point',
    coordinates: [1, 2]
  })
})
