import test from 'ava'

import {validateChanges, validateUsageNameChange} from '../point-validation.js'

test('validateChanges normalise un nom d’usage', t => {
  t.deepEqual(
    validateChanges({usageName: '  Forage de la source  '}),
    {usageName: 'Forage de la source'}
  )
})

test('validateChanges permet de supprimer un nom d’usage', t => {
  t.deepEqual(validateChanges({usageName: null}), {usageName: null})
})

test('validateChanges refuse un nom d’usage trop long', t => {
  const error = t.throws(() => validateChanges({usageName: 'a'.repeat(201)}))

  t.is(error.statusCode, 400)
  t.true(error.details.some(detail => detail.path === 'usageName' && detail.type === 'string.max'))
})

test('validateUsageNameChange normalise et permet de supprimer un nom d’usage', t => {
  t.deepEqual(
    validateUsageNameChange({usageName: '  Forage de la source  '}),
    {usageName: 'Forage de la source'}
  )
  t.deepEqual(validateUsageNameChange({usageName: ''}), {usageName: null})
  t.deepEqual(validateUsageNameChange({usageName: null}), {usageName: null})
})

test('validateUsageNameChange refuse les autres propriétés du point', t => {
  const error = t.throws(() => validateUsageNameChange({usageName: 'Forage', name: 'Nom technique'}))

  t.is(error.statusCode, 400)
  t.true(error.details.some(detail => detail.path === 'name' && detail.type === 'object.unknown'))
})
