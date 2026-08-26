import test from 'ava'

import {
  listAllowedDeclarationTypesForDeclarant,
  listAllowedDeclarationTypesForDeclarants
} from '../declaration-type.js'

function declarationType(id, code, name) {
  return {
    id,
    code,
    name,
    version: 1,
    isAvailable: true
  }
}

test('listAllowedDeclarationTypesForDeclarants charge tous les déclarants en une requête', async t => {
  const now = new Date('2026-08-26T15:45:00.000Z')
  const referenceDate = new Date(now)
  referenceDate.setHours(0, 0, 0, 0)
  const queries = []
  const template = declarationType('type-template', 'template-file', 'Modèle de déclaration')
  const quick = declarationType('type-quick', 'quick-declaration', 'Saisie rapide')
  const client = {
    declarantDeclarationType: {
      async findMany(query) {
        queries.push(query)
        return [
          {declarantUserId: 'preleveur-1', declarationType: quick},
          {declarantUserId: 'collecteur-1', declarationType: template},
          {declarantUserId: 'preleveur-1', declarationType: quick}
        ]
      }
    }
  }

  const result = await listAllowedDeclarationTypesForDeclarants([
    'collecteur-1',
    'preleveur-1',
    'preleveur-1',
    'preleveur-2'
  ], now, {client})

  t.is(queries.length, 1)
  t.deepEqual(queries[0].where.declarantUserId, {
    in: ['collecteur-1', 'preleveur-1', 'preleveur-2']
  })
  t.deepEqual(queries[0].where.AND, [
    {OR: [{startDate: null}, {startDate: {lte: referenceDate}}]},
    {OR: [{endDate: null}, {endDate: {gte: referenceDate}}]}
  ])
  t.deepEqual(result.get('collecteur-1'), [template])
  t.deepEqual(result.get('preleveur-1'), [quick])
  t.deepEqual(result.get('preleveur-2'), [])
})

test('listAllowedDeclarationTypesForDeclarant conserve le contrat de liste', async t => {
  let queryCount = 0
  const template = declarationType('type-template', 'template-file', 'Modèle de déclaration')
  const client = {
    declarantDeclarationType: {
      async findMany() {
        queryCount += 1
        return [{declarantUserId: 'declarant-1', declarationType: template}]
      }
    }
  }

  const result = await listAllowedDeclarationTypesForDeclarant(
    'declarant-1',
    new Date('2026-08-26T12:00:00.000Z'),
    {client}
  )

  t.is(queryCount, 1)
  t.deepEqual(result, [template])
})
