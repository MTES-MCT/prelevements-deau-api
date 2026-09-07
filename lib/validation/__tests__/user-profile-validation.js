import test from 'ava'

import {validateUserProfileChanges} from '../user-profile-validation.js'

function naturalDeclarant(overrides = {}) {
  return {
    role: 'DECLARANT',
    firstName: 'Alice',
    lastName: 'Martin',
    declarant: {
      declarantType: 'NATURAL_PERSON',
      socialReason: null
    },
    ...overrides
  }
}

test('refuse une modification absente ou vide', t => {
  for (const changes of [undefined, {}]) {
    const error = t.throws(() => validateUserProfileChanges(
      changes,
      naturalDeclarant()
    ))

    t.is(error.statusCode, 400)
  }
})

test('valide et normalise les champs modifiables d’un déclarant personne physique', t => {
  const value = validateUserProfileChanges({
    firstName: '  Aline  ',
    phoneNumber: '0102030405',
    addressLine2: '',
    postalCode: '75001'
  }, naturalDeclarant())

  t.deepEqual(value, {
    firstName: 'Aline',
    phoneNumber: '0102030405',
    addressLine2: null,
    postalCode: '75001'
  })
})

test('refuse les champs techniques et la raison sociale d’une personne physique', t => {
  const error = t.throws(() => validateUserProfileChanges({
    email: 'autre@example.test',
    role: 'ADMIN',
    siret: '12345678901234',
    socialReason: 'Entreprise'
  }, naturalDeclarant()))

  t.is(error.statusCode, 400)
  t.deepEqual(
    error.details.map(detail => detail.path).sort(),
    ['email', 'role', 'siret', 'socialReason']
  )
})

test('valide l’état final obligatoire d’une personne physique', t => {
  const error = t.throws(() => validateUserProfileChanges({
    phoneNumber: '0102030405'
  }, naturalDeclarant({firstName: null, lastName: null})))

  t.deepEqual(error.details.map(detail => detail.path), ['firstName', 'lastName'])
})

test('autorise la raison sociale uniquement pour une personne morale', t => {
  const user = naturalDeclarant({
    firstName: null,
    lastName: null,
    declarant: {
      declarantType: 'LEGAL_PERSON',
      socialReason: 'Ancienne société'
    }
  })

  t.deepEqual(validateUserProfileChanges({
    firstName: null,
    lastName: null,
    socialReason: '  Nouvelle société  '
  }, user), {
    firstName: null,
    lastName: null,
    socialReason: 'Nouvelle société'
  })

  const error = t.throws(() => validateUserProfileChanges({socialReason: null}, user))
  t.is(error.details[0].path, 'socialReason')
})

test('limite un agent à son identité et ses coordonnées professionnelles', t => {
  const user = {
    role: 'INSTRUCTOR',
    firstName: 'Ada',
    lastName: 'Lovelace',
    instructor: {phoneNumber: null, jobTitle: null}
  }

  t.deepEqual(validateUserProfileChanges({
    jobTitle: 'Chargée de mission',
    phoneNumber: null
  }, user), {
    jobTitle: 'Chargée de mission',
    phoneNumber: null
  })

  const error = t.throws(() => validateUserProfileChanges({city: 'Paris'}, user))
  t.is(error.details[0].path, 'city')
})

test('limite un administrateur à son prénom et son nom', t => {
  const user = {
    role: 'ADMIN',
    firstName: 'Admin',
    lastName: 'Plateforme'
  }

  t.deepEqual(validateUserProfileChanges({firstName: 'Camille'}, user), {
    firstName: 'Camille'
  })

  const error = t.throws(() => validateUserProfileChanges({jobTitle: 'Admin'}, user))
  t.is(error.details[0].path, 'jobTitle')
})

test('impose des chiffres pour le téléphone et le code postal', t => {
  const error = t.throws(() => validateUserProfileChanges({
    phoneNumber: '01 02 03 04',
    postalCode: '75A01'
  }, naturalDeclarant()))

  t.deepEqual(error.details.map(detail => detail.path), ['phoneNumber', 'postalCode'])
})

test('présente les erreurs de longueur en français', t => {
  const error = t.throws(() => validateUserProfileChanges({
    jobTitle: 'A',
    addressLine1: 'BP',
    city: 'X'
  }, naturalDeclarant()))

  t.deepEqual(error.details.map(detail => detail.message), [
    'Saisissez au moins 2 caractères.',
    'Saisissez au moins 3 caractères.',
    'Saisissez au moins 2 caractères.'
  ])
})
