import test from 'ava'

import {canCreateDeclarant, canEditPointUsageName} from '../resource-permissions.js'

test('canCreateDeclarant autorise un administrateur global', async t => {
  const canCreate = await canCreateDeclarant({id: 'admin-1', role: 'ADMIN'}, {
    client: {}
  })

  t.true(canCreate)
})

test('canCreateDeclarant autorise un agent qui possède le droit sur une zone active', async t => {
  let query
  const client = {
    instructorZone: {
      async findMany(arguments_) {
        query = arguments_
        return [{zoneId: 'zone-1'}]
      }
    }
  }

  const canCreate = await canCreateDeclarant({id: 'instructor-1', role: 'INSTRUCTOR'}, {client})

  t.true(canCreate)
  t.is(query.where.instructorUserId, 'instructor-1')
  t.deepEqual(query.where.permissions, {
    some: {permission: 'declarant.create'}
  })
})

test('canCreateDeclarant refuse un agent sans zone administrée', async t => {
  const client = {
    instructorZone: {
      findMany: async () => []
    }
  }

  const canCreate = await canCreateDeclarant({id: 'instructor-1', role: 'INSTRUCTOR'}, {client})

  t.false(canCreate)
})

test('canCreateDeclarant refuse les autres rôles', async t => {
  const canCreate = await canCreateDeclarant({id: 'declarant-1', role: 'DECLARANT'}, {
    client: {}
  })

  t.false(canCreate)
})

test('canEditPointUsageName autorise un rattachement actif direct ou collecteur', async t => {
  const queries = []
  const client = {
    declarantPointPrelevement: {
      async findFirst(arguments_) {
        queries.push(arguments_)
        return {id: 'exploitation-1'}
      }
    }
  }
  const now = new Date('2026-07-13T12:00:00.000Z')
  const canEdit = await canEditPointUsageName(
    {id: 'declarant-1', role: 'DECLARANT'},
    'point-1',
    {client, now}
  )

  t.true(canEdit)
  t.is(queries[0].where.pointPrelevementId, 'point-1')
  t.deepEqual(queries[0].where.OR, [
    {declarantUserId: 'declarant-1'},
    {collecteurs: {some: {collecteurUserId: 'declarant-1'}}}
  ])
  t.deepEqual(queries[0].where.AND, [
    {OR: [{startDate: null}, {startDate: {lte: now}}]},
    {OR: [{endDate: null}, {endDate: {gte: now}}]}
  ])
})

test('canEditPointUsageName refuse un déclarant sans rattachement actif', async t => {
  const client = {
    declarantPointPrelevement: {
      findFirst: async () => null
    }
  }

  t.false(await canEditPointUsageName(
    {id: 'declarant-1', role: 'DECLARANT'},
    'point-1',
    {client}
  ))
})

test('canEditPointUsageName refuse les autres rôles sans interroger la base', async t => {
  t.false(await canEditPointUsageName(
    {id: 'admin-1', role: 'ADMIN'},
    'point-1',
    {client: {}}
  ))
})
