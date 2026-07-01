import test from 'ava'

import {validateRegleCreation, validateRegleChanges} from '../regle-validation.js'
import {ValidationError} from '../../util/payload.js'

const DOCUMENT_ID = '55555555-5555-4555-8555-555555555555'
const EXPLOITATION_ID = '66666666-6666-4666-8666-666666666666'

function validRulePayload() {
  return {
    parameter: 'volume prélevé',
    frequency: '1 year',
    unit: 'm³',
    value: 10,
    constraint: 'MAX',
    validityStartDate: '2024-01-01',
    validityEndDate: null,
    annualPeriodStartDate: null,
    annualPeriodEndDate: null,
    comment: null,
    documentId: DOCUMENT_ID,
    exploitationIds: [EXPLOITATION_ID]
  }
}

function assertValidationError(t, fn) {
  return t.throws(fn, {instanceOf: ValidationError})
}

test('validateRegleCreation accepte une règle complète', t => {
  const value = validateRegleCreation(validRulePayload())

  t.is(value.parameter, 'volume prélevé')
  t.is(value.frequency, '1 year')
  t.is(value.unit, 'm³')
  t.is(value.constraint, 'MAX')
  t.true(value.validityStartDate instanceof Date)
  t.is(value.validityStartDate.toISOString(), '2024-01-01T00:00:00.000Z')
  t.deepEqual(value.exploitationIds, [EXPLOITATION_ID])
})

test('validateRegleCreation exige les champs métier', t => {
  const payload = validRulePayload()
  delete payload.parameter
  delete payload.unit
  delete payload.value
  delete payload.constraint
  delete payload.validityStartDate
  delete payload.exploitationIds

  const error = assertValidationError(t, () => validateRegleCreation(payload))
  const messages = new Set(error.details.map(detail => detail.message))

  t.true(messages.has('Le paramètre est obligatoire.'))
  t.true(messages.has('L\'unité est obligatoire.'))
  t.true(messages.has('La valeur est obligatoire.'))
  t.true(messages.has('La contrainte est obligatoire.'))
  t.true(messages.has('La date de début de validité est obligatoire.'))
  t.true(messages.has('Au moins une exploitation est obligatoire.'))
})

test('validateRegleCreation impose une fréquence pour le volume prélevé', t => {
  const payload = validRulePayload()
  delete payload.frequency

  const error = assertValidationError(t, () => validateRegleCreation(payload))

  t.true(error.details.some(detail => detail.message === 'La fréquence est obligatoire pour le paramètre "volume prélevé".'))
})

test('validateRegleCreation n’impose pas de fréquence pour un débit', t => {
  const payload = {
    ...validRulePayload(),
    parameter: 'débit prélevé',
    unit: 'L/s'
  }
  delete payload.frequency

  const value = validateRegleCreation(payload)

  t.is(value.parameter, 'débit prélevé')
  t.false(Object.hasOwn(value, 'frequency'))
})

test('validateRegleCreation rejette les UUID non v4', t => {
  const payload = {
    ...validRulePayload(),
    documentId: 'abcdef1234567890abcdef12',
    exploitationIds: ['not-a-uuid']
  }

  const error = assertValidationError(t, () => validateRegleCreation(payload))
  const paths = new Set(error.details.map(detail => detail.path))

  t.true(paths.has('documentId'))
  t.true(paths.has('exploitationIds.0'))
})

test('validateRegleCreation rejette les valeurs et dates invalides', t => {
  const error = assertValidationError(t, () => validateRegleCreation({
    ...validRulePayload(),
    value: 'abc',
    validityStartDate: '2024-13-01'
  }))

  t.true(error.details.some(detail => detail.message === 'La valeur doit être un nombre.'))
  t.true(error.details.some(detail => detail.message === 'La date est invalide.'))
})

test('validateRegleChanges accepte un patch partiel', t => {
  const value = validateRegleChanges({
    value: 20,
    comment: 'Mise à jour',
    documentId: null
  })

  t.deepEqual(value, {
    value: 20,
    comment: 'Mise à jour',
    documentId: null
  })
})

test('validateRegleChanges rejette les champs inconnus', t => {
  const error = assertValidationError(t, () => validateRegleChanges({unknown: true}))

  t.true(error.details.some(detail => detail.type === 'object.unknown' && detail.unknownKey === 'unknown'))
})
