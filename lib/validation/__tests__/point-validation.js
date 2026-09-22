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
    isWaterBodyConnectedToGroundwater: null,
    reservoirNominalVolume: null,
    waterBodyIdentifier: null
  })

  t.deepEqual(normalizeWaterBodyConnections({isWaterBodyConnectedToStream: true}, 'PLAN_EAU'), {
    isWaterBodyConnectedToStream: true
  })
})

test('validateCreation conserve les caractéristiques facultatives du plan d’eau', t => {
  const value = validateCreation({
    name: 'Retenue principale',
    waterBodyType: 'SUPERFICIELLE',
    flowType: 'PRELEVEMENT',
    coordinates: validCoordinates,
    nature: 'PLAN_EAU',
    reservoirNominalVolume: 12000.75,
    waterBodyIdentifier: '  00042/Retenue-A  '
  })

  t.is(value.reservoirNominalVolume, 12000.75)
  t.is(value.waterBodyIdentifier, '00042/Retenue-A')
})

test('validateCreation efface les caractéristiques du plan d’eau pour une autre origine ou une origine absente', t => {
  const base = {
    name: 'Point sans plan d’eau',
    waterBodyType: 'SUPERFICIELLE',
    flowType: 'PRELEVEMENT',
    coordinates: validCoordinates,
    reservoirNominalVolume: 12000.75,
    waterBodyIdentifier: '00042'
  }

  for (const nature of ['COURS_EAU', null, undefined]) {
    const value = validateCreation({...base, nature})
    t.is(value.reservoirNominalVolume, null)
    t.is(value.waterBodyIdentifier, null)
  }
})

test('validateChanges exige un volume nominal fini et strictement positif', t => {
  for (const reservoirNominalVolume of [0, -1, Number.NaN, Infinity, -Infinity, 'inconnu']) {
    const error = t.throws(() => validateChanges({reservoirNominalVolume}), {name: 'ValidationError'})
    t.true(error.details.some(detail => detail.path === 'reservoirNominalVolume'))
  }

  t.deepEqual(validateChanges({reservoirNominalVolume: 0.25}), {reservoirNominalVolume: 0.25})
})

test('validateChanges conserve une référence texte libre limitée à 100 caractères', t => {
  t.deepEqual(validateChanges({waterBodyIdentifier: '  00042  '}), {waterBodyIdentifier: '00042'})
  t.is(validateChanges({waterBodyIdentifier: 'a'.repeat(100)}).waterBodyIdentifier.length, 100)

  for (const waterBodyIdentifier of ['', '   ', 'a'.repeat(101), 42]) {
    const error = t.throws(() => validateChanges({waterBodyIdentifier}), {name: 'ValidationError'})
    t.true(error.details.some(detail => detail.path === 'waterBodyIdentifier'))
  }
})

test('normalizeWaterBodyConnections conserve les champs absents d’une modification partielle', t => {
  t.deepEqual(normalizeWaterBodyConnections({comment: 'Autre modification'}, 'PLAN_EAU'), {
    comment: 'Autre modification'
  })
  t.deepEqual(normalizeWaterBodyConnections({reservoirNominalVolume: 12.5}, 'PLAN_EAU'), {
    reservoirNominalVolume: 12.5
  })
  t.deepEqual(normalizeWaterBodyConnections({waterBodyIdentifier: null}, 'PLAN_EAU'), {
    waterBodyIdentifier: null
  })
  t.deepEqual(normalizeWaterBodyConnections({nature: 'PLAN_EAU'}, 'PLAN_EAU'), {nature: 'PLAN_EAU'})
})

test('normalizeWaterBodyConnections efface les nouveaux champs hors plan d’eau même sans origine dans le patch', t => {
  const emptyWaterBody = {
    isWaterBodyConnectedToStream: null,
    isWaterBodyConnectedToGroundwater: null,
    reservoirNominalVolume: null,
    waterBodyIdentifier: null
  }

  t.deepEqual(normalizeWaterBodyConnections({reservoirNominalVolume: 12.5}, 'NAPPE'), emptyWaterBody)
  t.deepEqual(normalizeWaterBodyConnections({waterBodyIdentifier: '00042'}, null), emptyWaterBody)
  t.deepEqual(normalizeWaterBodyConnections({nature: null}, 'PLAN_EAU'), {nature: null, ...emptyWaterBody})
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
    otherNames: null,
    names: null,
    identifiers: null,
    commissioningDate: null,
    waterAgencyInternalIdentifier: null,
    isReferencePoint: null,
    isWaterBodyConnectedToStream: null,
    isWaterBodyConnectedToGroundwater: null,
    reservoirNominalVolume: null,
    waterBodyIdentifier: null,
    depth: null,
    isZre: null,
    geometryPrecision: null,
    communeName: null
  }), {
    otherNames: null,
    names: null,
    identifiers: null,
    commissioningDate: null,
    waterAgencyInternalIdentifier: null,
    isReferencePoint: null,
    isWaterBodyConnectedToStream: null,
    isWaterBodyConnectedToGroundwater: null,
    reservoirNominalVolume: null,
    waterBodyIdentifier: null,
    depth: null,
    isZre: null,
    geometryPrecision: null,
    communeName: null
  })
})

test('validateChanges refuse de supprimer le type de milieu', t => {
  const error = t.throws(
    () => validateChanges({waterBodyType: null}),
    {name: 'ValidationError'}
  )

  t.true(error.details.some(detail =>
    detail.path === 'waterBodyType'
    && detail.message === 'Le type de milieu est obligatoire.'
  ))
})

test('validateChanges rejette les clés inconnues', t => {
  const error = t.throws(() => validateChanges({unknown: true}), {name: 'ValidationError'})
  t.is(error.details[0].type, 'object.unknown')
  t.is(error.details[0].unknownKey, 'unknown')
})
