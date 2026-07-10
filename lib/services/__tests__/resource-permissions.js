import test from 'ava'

import {canCreateDeclarant} from '../resource-permissions.js'

test('canCreateDeclarant autorise un administrateur global', async t => {
  const canCreate = await canCreateDeclarant({id: 'admin-1', role: 'ADMIN'}, {
    client: {}
  })

  t.true(canCreate)
})

test('canCreateDeclarant autorise un agent administrateur d’une zone active', async t => {
  let query
  const client = {
    instructorZone: {
      async count(arguments_) {
        query = arguments_
        return 1
      }
    }
  }

  const canCreate = await canCreateDeclarant({id: 'instructor-1', role: 'INSTRUCTOR'}, {client})

  t.true(canCreate)
  t.true(query.where.isAdmin)
  t.is(query.where.instructorUserId, 'instructor-1')
})

test('canCreateDeclarant refuse un agent sans zone administrée', async t => {
  const client = {
    instructorZone: {
      count: async () => 0
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
