import test from 'ava'

import {
  GEOMETRY_PRECISIONS,
  POINT_PRELEVEMENT_NATURES,
  PRELEVEMENT_TYPES,
  WATER_BODY_TYPES,
  normalizeWaterBodyConnections,
  validateChanges,
  validateCreation
} from '../point-validation.js'

const validCoordinates = {
  type: 'Point',
  coordinates: [2.35, 48.85]
}

test('validateCreation accepte un point complet', t => {
  const value = validateCreation({
    name: 'Forage principal',
    waterBodyType: WATER_BODY_TYPES[0],
    flowType: 'PRELEVEMENT',
    coordinates: validCoordinates,
    nature: POINT_PRELEVEMENT_NATURES[0],
    withdrawalType: PRELEVEMENT_TYPES[0],
    commissioningDate: '2024-03-15',
    waterAgencyInternalIdentifier: 'AERMC-42',
    isReferencePoint: true,
    depth: 12.5,
    isZre: true,
    isBiologicalReservoir: false,
    geometryPrecision: GEOMETRY_PRECISIONS[0],
    names: [{type: 'LOCAL', value: 'Puits A', source: ''}],
    identifiers: {BNPE: 'BNPE-1'},
    communeCode: '75056',
    communeName: 'Paris'
  })

  t.like(value, {
    name: 'Forage principal',
    waterBodyType: WATER_BODY_TYPES[0],
    flowType: 'PRELEVEMENT',
    coordinates: validCoordinates,
    nature: POINT_PRELEVEMENT_NATURES[0],
    withdrawalType: PRELEVEMENT_TYPES[0],
    pointKind: 'PHYSIQUE',
    waterAgencyInternalIdentifier: 'AERMC-42',
    isReferencePoint: true,
    depth: 12.5,
    isZre: true,
    isBiologicalReservoir: false,
    geometryPrecision: GEOMETRY_PRECISIONS[0]
  })

  t.is(value.commissioningDate.toISOString(), '2024-03-15T00:00:00.000Z')
})

test('validateCreation conserve le type de prélèvement ou rejet pour un point de rejet', t => {
  const result = validateCreation({
    name: 'Point de rejet',
    waterBodyType: 'SUPERFICIELLE',
    flowType: 'REJET',
    withdrawalType: 'CONTINENTAL',
    coordinates: {
      type: 'Point',
      coordinates: [5.72, 45.19]
    }
  })

  t.is(result.flowType, 'REJET')
  t.is(result.withdrawalType, 'CONTINENTAL')
})

test('validateCreation conserve les connexions uniquement pour un plan d’eau', t => {
  const base = {
    name: 'Plan d’eau principal',
    waterBodyType: 'SUPERFICIELLE',
    flowType: 'PRELEVEMENT',
    coordinates: validCoordinates,
    isWaterBodyConnectedToStream: true,
    isWaterBodyConnectedToGroundwater: false
  }

  const waterBody = validateCreation({...base, nature: 'PLAN_EAU'})
  const stream = validateCreation({...base, nature: 'COURS_EAU'})

  t.is(waterBody.isWaterBodyConnectedToStream, true)
  t.is(waterBody.isWaterBodyConnectedToGroundwater, false)
  t.is(stream.isWaterBodyConnectedToStream, null)
  t.is(stream.isWaterBodyConnectedToGroundwater, null)
})

test('normalizeWaterBodyConnections nettoie une origine modifiée hors plan d’eau', t => {
  t.deepEqual(normalizeWaterBodyConnections({nature: 'COURS_EAU'}, 'PLAN_EAU'), {
    nature: 'COURS_EAU',
    isWaterBodyConnectedToStream: null,
    isWaterBodyConnectedToGroundwater: null
  })

  t.deepEqual(normalizeWaterBodyConnections({isWaterBodyConnectedToStream: true}, 'PLAN_EAU'), {
    isWaterBodyConnectedToStream: true
  })
})

test('validateCreation exige nom, type de point, type de milieu et géométrie', t => {
  const error = t.throws(() => validateCreation({}), {name: 'ValidationError'})
  t.deepEqual(error.details.map(detail => detail.path).sort(), ['coordinates', 'flowType', 'name', 'waterBodyType'])
})

test('validateCreation rejette les valeurs métier invalides', t => {
  const error = t.throws(() => validateCreation({
    name: 'Fo',
    waterBodyType: 'MER',
    flowType: 'INCONNU',
    pointKind: 'VIRTUEL',
    coordinates: validCoordinates,
    nature: 'PUITS',
    withdrawalType: 'AUTRE',
    geometryPrecision: 'Précision GPS',
    depth: -1
  }), {name: 'ValidationError'})

  t.true(error.details.some(detail => detail.message === 'Ce type de milieu est invalide.'))
  t.true(error.details.some(detail => detail.message === 'Le type de point est invalide.'))
  t.true(error.details.some(detail => detail.message === 'La nature physique ou fictive du point est invalide.'))
  t.true(error.details.some(detail => detail.message === 'Cette origine de prélèvement ou de rejet est invalide.'))
  t.true(error.details.some(detail => detail.message === 'Ce type de prélèvement ou de rejet est invalide.'))
  t.true(error.details.some(detail => detail.message === 'Cette précision géométrique est invalide.'))
  t.true(error.details.some(detail => detail.path === 'depth'))
  t.true(error.details.some(detail => detail.path === 'name'))
})

test('validateCreation valide la structure de géométrie', t => {
  const base = {
    name: 'Forage principal',
    waterBodyType: 'SUPERFICIELLE',
    flowType: 'PRELEVEMENT'
  }

  const cases = [
    [{type: 'LineString', coordinates: [2, 48]}, 'La géométrie doit être un point.'],
    [{type: 'Point', coordinates: [2]}, 'Les coordonnées doivent contenir longitude et latitude.'],
    [{type: 'Point', coordinates: [181, 48]}, 'La longitude est invalide.'],
    [{type: 'Point', coordinates: [2, 91]}, 'La latitude est invalide.']
  ]

  for (const [coordinates, message] of cases) {
    const error = t.throws(() => validateCreation({...base, coordinates}), {name: 'ValidationError'})
    t.true(error.details.some(detail => detail.message === message))
  }
})

test('validateChanges accepte un patch partiel et les nulls autorisés', t => {
  t.deepEqual(validateChanges({
    waterBodyType: null,
    otherNames: null,
    names: null,
    identifiers: null,
    commissioningDate: null,
    waterAgencyInternalIdentifier: null,
    isReferencePoint: null,
    isWaterBodyConnectedToStream: null,
    isWaterBodyConnectedToGroundwater: null,
    depth: null,
    isZre: null,
    geometryPrecision: null,
    communeName: null
  }), {
    waterBodyType: null,
    otherNames: null,
    names: null,
    identifiers: null,
    commissioningDate: null,
    waterAgencyInternalIdentifier: null,
    isReferencePoint: null,
    isWaterBodyConnectedToStream: null,
    isWaterBodyConnectedToGroundwater: null,
    depth: null,
    isZre: null,
    geometryPrecision: null,
    communeName: null
  })
})

test('validateChanges rejette les clés inconnues', t => {
  const error = t.throws(() => validateChanges({unknown: true}), {name: 'ValidationError'})
  t.is(error.details[0].type, 'object.unknown')
  t.is(error.details[0].unknownKey, 'unknown')
})
