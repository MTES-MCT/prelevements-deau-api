import test from 'ava'

import {
  getZoneDeclarantBaseWhere,
  listDeclarantOptionsForZone
} from '../zone-resources.js'

test('getZoneDeclarantBaseWhere limite la requête aux identifiants effectifs et échoue fermé', t => {
  t.deepEqual(getZoneDeclarantBaseWhere([], 'COLLECTEUR'), {
    id: {in: []},
    role: 'DECLARANT',
    deletedAt: null,
    declarant: {declarantRole: 'COLLECTEUR'}
  })
  t.deepEqual(getZoneDeclarantBaseWhere([
    'declarant-1',
    'declarant-1',
    'declarant-2'
  ]), {
    id: {in: ['declarant-1', 'declarant-2']},
    role: 'DECLARANT',
    deletedAt: null
  })
})

test('listDeclarantOptionsForZone résout le périmètre effectif avant de charger les options', async t => {
  let userQuery
  let effectiveZoneQueries = 0
  const client = {
    async $queryRaw() {
      effectiveZoneQueries += 1
      return [{declarantUserId: 'declarant-1', zoneId: 'zone-1'}]
    },
    user: {
      async findMany(query) {
        userQuery = query
        return [{
          id: 'declarant-1',
          email: 'declarant@example.test',
          declarant: {
            declarantRole: 'PRELEVEUR',
            socialReason: 'Déclarant 1'
          }
        }]
      }
    }
  }

  const options = await listDeclarantOptionsForZone('zone-1', {client})

  t.is(effectiveZoneQueries, 1)
  t.deepEqual(userQuery.where, {
    id: {in: ['declarant-1']},
    role: 'DECLARANT',
    deletedAt: null
  })
  t.is(options.length, 1)
  t.is(options[0].id, 'declarant-1')
})

test('listDeclarantOptionsForZone ne charge aucun utilisateur sans preuve effective', async t => {
  const client = {
    async $queryRaw() {
      return []
    },
    user: {
      async findMany() {
        t.fail('Une zone sans déclarant effectif doit rester fermée.')
      }
    }
  }

  t.deepEqual(await listDeclarantOptionsForZone('zone-1', {client}), [])
})
