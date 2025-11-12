import test from 'ava'
import {ObjectId} from 'mongodb'
import {parseObjectId} from '../mongo.js'

test('parseObjectId / retourne un ObjectId pour un string valide', t => {
  const validId = '507f1f77bcf86cd799439011'
  const result = parseObjectId(validId)

  t.truthy(result)
  t.true(result instanceof ObjectId)
  t.is(result.toHexString(), validId)
})

test('parseObjectId / retourne null pour un string invalide', t => {
  const invalidId = 'not-a-valid-objectid'
  const result = parseObjectId(invalidId)

  t.is(result, null)
})

test('parseObjectId / retourne null pour un string vide', t => {
  const result = parseObjectId('')

  t.is(result, null)
})

test('parseObjectId / retourne null pour un string trop court', t => {
  const shortId = '123'
  const result = parseObjectId(shortId)

  t.is(result, null)
})

test('parseObjectId / retourne null pour un string avec des caractères invalides', t => {
  const invalidId = '507f1f77bcf86cd79943901z' // Le caractère z n'est pas un caractère hex valide
  const result = parseObjectId(invalidId)

  t.is(result, null)
})

test('parseObjectId / retourne null pour un string trop long', t => {
  const longId = '507f1f77bcf86cd799439011123'
  const result = parseObjectId(longId)

  t.is(result, null)
})

test('parseObjectId / retourne null pour null', t => {
  const result = parseObjectId(null)

  t.is(result, null)
})

test('parseObjectId / retourne null pour undefined', t => {
  const result = parseObjectId(undefined)

  t.is(result, null)
})

test('parseObjectId / préserve la casse du string hex', t => {
  const mixedCaseId = '507F1f77BCF86CD799439011'
  const result = parseObjectId(mixedCaseId)

  t.truthy(result)
  t.true(result instanceof ObjectId)
  // ObjectId normalise en lowercase
  t.is(result.toHexString(), mixedCaseId.toLowerCase())
})

test('parseObjectId / retourne null pour un objet', t => {
  const result = parseObjectId({id: '507f1f77bcf86cd799439011'})

  t.is(result, null)
})

test('parseObjectId / retourne null pour un nombre', t => {
  const result = parseObjectId(123)

  t.is(result, null)
})
