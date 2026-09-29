import test from 'ava'
import {resourceIdSchema} from '../resource-id.js'

test('les identifiants de ressources acceptent les UUID v4 et v5 sans les modifier', t => {
  for (const id of [
    '1b50db42-ca4b-4dd2-afc0-491ab70a704f',
    '1b50db42-ca4b-5dd2-afc0-491ab70a704f'
  ]) {
    const result = resourceIdSchema.required().validate(id)
    t.is(result.error, undefined)
    t.is(result.value, id)
  }
})

test('les identifiants de ressources refusent les UUID malformés et les autres versions', t => {
  for (const id of [
    '', undefined, null, 123, 'point-123',
    '1b50db42-ca4b-3dd2-afc0-491ab70a704f',
    '1b50db42-ca4b-5dd2-0fc0-491ab70a704f',
    '1b50db42-ca4b-5dd2-afc0-491ab70a704f-invalid'
  ]) {
    t.truthy(resourceIdSchema.required().validate(id).error)
  }
})
