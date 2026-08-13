import test from 'ava'

import {
  validateChanges,
  validateCreation
} from '../preleveur-validation.js'

test('validateCreation applique les valeurs par défaut et normalise email', t => {
  const value = validateCreation({
    civility: 'MR',
    firstName: ' Samy ',
    lastName: ' Test ',
    email: 'SAMY@example.fr',
    phoneNumber: '0102030405',
    siret: '12345678901234'
  })

  t.like(value, {
    declarantType: 'NATURAL_PERSON',
    declarantRole: 'PRELEVEUR',
    quickDeclarationEnabled: true,
    civility: 'MR',
    firstName: 'Samy',
    lastName: 'Test',
    email: 'samy@example.fr',
    phoneNumber: '0102030405',
    siret: '12345678901234'
  })
})

test('validateCreation accepte les personnes morales collectrices', t => {
  const value = validateCreation({
    declarantType: 'LEGAL_PERSON',
    declarantRole: 'COLLECTEUR',
    quickDeclarationEnabled: false,
    socialReason: 'ASA des canaux',
    addressLine1: '1 rue de l’eau',
    postalCode: '66000',
    city: 'Perpignan',
    email: null,
    sourceId: 'source-legacy-1'
  })

  t.like(value, {
    declarantType: 'LEGAL_PERSON',
    declarantRole: 'COLLECTEUR',
    quickDeclarationEnabled: false,
    socialReason: 'ASA des canaux',
    postalCode: '66000',
    city: 'Perpignan',
    email: null
  })
})

test('validateCreation rejette enums, formats et longueurs invalides', t => {
  const error = t.throws(() => validateCreation({
    declarantType: 'ASSOCIATION',
    declarantRole: 'ADMIN',
    civility: 'MX',
    email: 'not-an-email',
    postalCode: '1234',
    phoneNumber: '0102',
    siret: '123',
    socialReason: 'ab'
  }), {name: 'ValidationError'})

  t.true(error.details.some(detail => detail.path === 'declarantType'))
  t.true(error.details.some(detail => detail.path === 'declarantRole'))
  t.true(error.details.some(detail => detail.path === 'civility'))
  t.true(error.details.some(detail => detail.path === 'email'))
  t.true(error.details.some(detail => detail.path === 'postalCode'))
  t.true(error.details.some(detail => detail.path === 'phoneNumber'))
  t.true(error.details.some(detail => detail.path === 'siret'))
  t.true(error.details.some(detail => detail.path === 'socialReason'))
})

test('validateChanges accepte un patch sans injecter de valeurs par défaut', t => {
  const value = validateChanges({
    quickDeclarationEnabled: false,
    city: 'Lyon'
  })

  t.deepEqual(value, {
    quickDeclarationEnabled: false,
    city: 'Lyon'
  })
})

test('validateCreation valide les types de préleveur et peut les exiger', t => {
  for (const preleveurType of ['ICPE', 'IRRIGANT', 'GESTIONNAIRE_AEP', 'AUTRE']) {
    t.is(validateCreation({preleveurType}, {requirePreleveurType: true}).preleveurType, preleveurType)
  }

  const missingError = t.throws(
    () => validateCreation({}, {requirePreleveurType: true}),
    {name: 'ValidationError'}
  )
  t.true(missingError.details.some(detail => detail.path === 'preleveurType'))

  const collecteur = validateCreation({
    declarantRole: 'COLLECTEUR'
  }, {requirePreleveurType: true})
  t.false(Object.hasOwn(collecteur, 'preleveurType'))

  const invalidError = t.throws(
    () => validateCreation({preleveurType: 'ENTREPRISE'}, {requirePreleveurType: true}),
    {name: 'ValidationError'}
  )
  t.true(invalidError.details.some(detail => detail.path === 'preleveurType'))
})

test('validateChanges rejette les clés inconnues', t => {
  const error = t.throws(() => validateChanges({unknown: 'value'}), {name: 'ValidationError'})
  t.is(error.details[0].type, 'object.unknown')
  t.is(error.details[0].unknownKey, 'unknown')
})
