import test from 'ava'

import {
  NATURES_VALIDES,
  validateDocumentChanges,
  validateDocumentCreation
} from '../document-validation.js'

const uuid = '11111111-1111-4111-8111-111111111111'

test('validateDocumentCreation accepte un document complet et convertit les dates', t => {
  const value = validateDocumentCreation({
    title: 'Arrêté préfectoral',
    reference: 'AP-2026-001',
    nature: 'Autorisation IOTA',
    signatureDate: '2026-06-30',
    validityEndDate: null,
    comment: 'Document vérifié',
    declarantPointPrelevementId: uuid
  })

  t.is(value.title, 'Arrêté préfectoral')
  t.is(value.reference, 'AP-2026-001')
  t.is(value.nature, 'Autorisation IOTA')
  t.true(value.signatureDate instanceof Date)
  t.is(value.signatureDate.toISOString(), '2026-06-30T00:00:00.000Z')
  t.is(value.validityEndDate, null)
  t.is(value.declarantPointPrelevementId, uuid)
})

test('validateDocumentCreation accepte une Date native valide', t => {
  const signatureDate = new Date('2026-06-30T00:00:00.000Z')
  const value = validateDocumentCreation({
    nature: NATURES_VALIDES[0],
    signatureDate
  })

  t.is(value.signatureDate, signatureDate)
})

test('validateDocumentCreation exige la nature et la date de signature', t => {
  const error = t.throws(() => validateDocumentCreation({}), {name: 'ValidationError'})
  t.deepEqual(error.details.map(detail => detail.path).sort(), ['nature', 'signatureDate'])
  t.true(error.details.some(detail => detail.message === 'La date de signature est obligatoire.'))
})

test('validateDocumentCreation rejette nature, date, uuid et chaînes invalides', t => {
  const error = t.throws(() => validateDocumentCreation({
    title: 'ab',
    reference: 'xy',
    nature: 'Nature inconnue',
    signatureDate: '30/06/2026',
    validityEndDate: 'date',
    comment: 'no',
    declarantPointPrelevementId: 'not-a-uuid'
  }), {name: 'ValidationError'})

  t.true(error.details.some(detail => detail.message === 'Cette nature est invalide.'))
  t.true(error.details.filter(detail => detail.message === 'La date est invalide.').length >= 2)
  t.true(error.details.some(detail => detail.path === 'declarantPointPrelevementId'))
  t.true(error.details.some(detail => detail.path === 'title'))
  t.true(error.details.some(detail => detail.path === 'comment'))
})

test('validateDocumentChanges accepte un patch partiel et les nulls', t => {
  t.deepEqual(validateDocumentChanges({
    title: null,
    nature: null,
    signatureDate: null,
    validityEndDate: '',
    declarantPointPrelevementId: null
  }), {
    title: null,
    nature: null,
    signatureDate: null,
    validityEndDate: null,
    declarantPointPrelevementId: null
  })
})

test('validateDocumentChanges rejette les clés inconnues', t => {
  const error = t.throws(() => validateDocumentChanges({unknown: true}), {name: 'ValidationError'})
  t.is(error.details[0].type, 'object.unknown')
  t.is(error.details[0].unknownKey, 'unknown')
})
