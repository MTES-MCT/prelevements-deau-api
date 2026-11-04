import test from 'ava'
import {getCollectorEditableExploitationIds, getCollectorEditablePreleveurIds} from '../collector-resource-rights.js'

const user = {id: 'collector', role: 'DECLARANT'}
const now = new Date('2026-11-04T12:00:00Z')

test('les capacités de gestion sont absentes sans habilitation ou sans session déclarant', async t => {
  let queries = 0
  const client = {declarant: {async findFirst(query) {
    queries++
    t.true(query.where.pointManagementEnabled)
    t.deepEqual(query.where.user, {role: 'DECLARANT', deletedAt: null})
    return null
  }}}
  t.deepEqual([...await getCollectorEditableExploitationIds({role: 'ADMIN'}, ['exploitation'], {client})], [])
  t.deepEqual([...await getCollectorEditableExploitationIds(user, ['exploitation'], {client})], [])
  t.deepEqual([...await getCollectorEditablePreleveurIds(user, ['preleveur'], {client})], [])
  t.is(queries, 2)
})

test('la capacité exploitation est bornée à une délégation actuelle et à des ressources actives', async t => {
  let query
  const client = {
    declarant: {async findFirst() { return {userId: user.id} }},
    declarantPointPrelevement: {async findMany(value) { query = value; return [{id: 'active'}] }}
  }
  const result = await getCollectorEditableExploitationIds(user, ['active', 'ended', 'outside'], {client, now})
  t.deepEqual([...result], ['active'])
  t.deepEqual(query.where.id, {in: ['active', 'ended', 'outside']})
  t.deepEqual(query.where.collecteurs, {some: {collecteurUserId: user.id}})
  t.deepEqual(query.where.status, {in: ['EN_ACTIVITE', 'NON_RENSEIGNE']})
  t.deepEqual(query.where.pointPrelevement, {deletedAt: null})
  t.deepEqual(query.where.declarant, {declarantRole: 'PRELEVEUR', user: {role: 'DECLARANT', deletedAt: null}})
  const day = new Date('2026-11-04T00:00:00Z')
  t.deepEqual(query.where.AND, [
    {OR: [{startDate: null}, {startDate: {lte: day}}]},
    {OR: [{endDate: null}, {endDate: {gte: day}}]}
  ])
})

test('les coordonnées sont habilitées par une exploitation actuelle, sans droit général d’édition', async t => {
  let enabled = true
  let queries = 0
  const client = {
    declarant: {async findFirst() { return enabled ? {userId: user.id} : null }},
    declarantPointPrelevement: {async findMany(query) {
      queries++
      t.deepEqual(query.where.declarantUserId, {in: ['followed', 'other']})
      t.deepEqual(query.distinct, ['declarantUserId'])
      return [{declarantUserId: 'followed'}]
    }}
  }
  t.deepEqual([...await getCollectorEditablePreleveurIds(user, ['followed', 'other'], {client, now})], ['followed'])
  enabled = false
  t.deepEqual([...await getCollectorEditablePreleveurIds(user, ['followed', 'other'], {client, now})], [])
  t.is(queries, 1)
})
