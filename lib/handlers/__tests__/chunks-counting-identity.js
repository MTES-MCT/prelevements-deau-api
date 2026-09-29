import test from 'ava'
import {resolveInstructionChunkExploitation, updateChunkInstructionSchema} from '../chunks.js'

const id = '11111111-1111-4111-8111-111111111111'

test('le contrat d’instruction accepte une exploitation explicite et un détachement', t => {
  t.falsy(updateChunkInstructionSchema.validate({instructionStatus: 'VALIDATED', exploitationId: id}).error)
  t.falsy(updateChunkInstructionSchema.validate({instructionStatus: 'PENDING', pointPrelevementId: null, exploitationId: null}).error)
  t.truthy(updateChunkInstructionSchema.validate({instructionStatus: 'VALIDATED', exploitationId: 'invalid'}).error)
})

test('l’instruction contrôle le préleveur, le code déclaré, le point et la période ensemble', async t => {
  let query
  const result = await resolveInstructionChunkExploitation({
    client: {
      declarant: {async findUnique() {return {declarantRole: 'PRELEVEUR'}}},
      declarantPointPrelevement: {async findMany(input) {query = input; return [{id, declarantUserId: 'owner', countingCode: '001'}]}}
    },
    chunk: {preleveurUserId: 'owner', metadata: {countingCode: '001'}, minDate: new Date('2026-01-01'), maxDate: new Date('2026-01-31')},
    exploitationId: id, pointPrelevementId: 'point'
  })
  t.is(result.id, id)
  t.is(query.where.id, id)
  t.is(query.where.declarantUserId, 'owner')
  t.is(query.where.pointPrelevementId, 'point')
  t.is(query.where.countingCode, '001')
  t.is(query.where.AND.length, 2)
})

test('un dépôt collecteur non rapproché reste limité aux exploitations déléguées', async t => {
  let query
  const result = await resolveInstructionChunkExploitation({
    client: {
      declarant: {async findUnique() {return {declarantRole: 'COLLECTEUR'}}},
      declarantPointPrelevement: {async findMany(input) {query = input; return [{id, declarantUserId: 'owner'}]}}
    },
    chunk: {preleveurUserId: null, source: {declaration: {declarantUserId: 'collector'}}, minDate: new Date('2026-01-01'), maxDate: new Date('2026-01-31')},
    exploitationId: id, pointPrelevementId: 'point'
  })
  t.is(result.declarantUserId, 'owner')
  t.deepEqual(query.where.OR, [{declarantUserId: 'collector'}, {collecteurs: {some: {collecteurUserId: 'collector'}}}])
})

test('un préleveur absent ou une exploitation introuvable ne sont jamais devinés', async t => {
  t.is((await t.throwsAsync(resolveInstructionChunkExploitation({client: {}, chunk: {}, pointPrelevementId: 'point'}))).statusCode, 409)
  t.is((await t.throwsAsync(resolveInstructionChunkExploitation({
    client: {
      declarant: {async findUnique() {return {declarantRole: 'PRELEVEUR'}}},
      declarantPointPrelevement: {async findMany() {return []}}
    },
    chunk: {preleveurUserId: 'owner', minDate: new Date('2026-01-01'), maxDate: new Date('2026-01-31')}, pointPrelevementId: 'point'
  }))).statusCode, 409)
})
