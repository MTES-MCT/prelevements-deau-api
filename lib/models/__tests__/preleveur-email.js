import test from 'ava'
import createHttpError from 'http-errors'
import {classifyPreleveurEmailAllocationError, isRetryablePreleveurEmailAllocation} from '../preleveur-email.js'

test('only known legacy login allocation constraints are retryable', t => {
  const unique = Object.assign(new Error('Concurrent unique email'), {code: 'P2002', meta: {modelName: 'User', target: ['email']}})
  const registry = Object.assign(new Error('Raw query failed'), {code: 'P2010', meta: {driverAdapterError: {cause: {
    originalCode: '23514', originalMessage: 'violates check constraint "UserEmailIdentity_compatible_claims_check"'
  }}}})
  for (const error of [unique, registry]) {
    const classified = classifyPreleveurEmailAllocationError(error)
    t.true(isRetryablePreleveurEmailAllocation(classified))
    t.is(classified.status, 409)
  }
  for (const error of [createHttpError(409, 'Fiche déjà existante'), createHttpError(409, 'Un utilisateur avec cet email existe déjà.'),
    Object.assign(new Error('Unique source'), {code: 'P2002', meta: {modelName: 'Declarant', target: ['sourceId']}})]) {
    t.is(classifyPreleveurEmailAllocationError(error), error)
    t.false(isRetryablePreleveurEmailAllocation(error))
  }
})
