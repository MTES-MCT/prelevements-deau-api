import test from 'ava'

import {
  getSourceForInstructor,
  instructorSourceScopeWhere,
  listSourcesForInstructor,
  visibleSourceWhere
} from '../instructor-sources.js'

test('instructorSourceScopeWhere refuse tout périmètre vide', t => {
  t.deepEqual(instructorSourceScopeWhere(), {id: {in: []}})
})

test('instructorSourceScopeWhere combine les points et les acteurs effectifs autorisés', t => {
  t.deepEqual(
    instructorSourceScopeWhere({
      declarantUserIds: ['declarant-1'],
      pointIds: ['point-1']
    }),
    {
      OR: [
        {
          chunks: {
            some: {pointPrelevementId: {in: ['point-1']}}
          }
        },
        {
          declaration: {
            is: {
              OR: [
                {declarantUserId: {in: ['declarant-1']}},
                {createdByDeclarantUserId: {in: ['declarant-1']}}
              ]
            }
          }
        }
      ]
    }
  )
})

test('listSourcesForInstructor utilise les acteurs effectifs et les points des zones', async t => {
  let countWhere
  let listWhere
  const client = {
    async $queryRaw() {
      return [
        {declarantUserId: 'declarant-1', zoneId: 'zone-1'},
        {declarantUserId: 'declarant-1', zoneId: 'zone-1'}
      ]
    },
    pointPrelevementZone: {
      async findMany() {
        return [{pointPrelevementId: 'point-1'}]
      }
    },
    source: {
      async count(arguments_) {
        countWhere = arguments_.where
        return 0
      },
      async findMany(arguments_) {
        listWhere = arguments_.where
        return []
      }
    }
  }

  await listSourcesForInstructor({zoneIds: ['zone-1']}, {client})

  const expectedScope = instructorSourceScopeWhere({
    declarantUserIds: ['declarant-1'],
    pointIds: ['point-1']
  })
  t.deepEqual(countWhere.OR, expectedScope.OR)
  t.deepEqual(listWhere.OR, expectedScope.OR)
  t.false(JSON.stringify(countWhere).includes('zones'))
})

test('getSourceForInstructor utilise les acteurs effectifs pour le détail', async t => {
  let detailWhere
  const client = {
    async $queryRaw() {
      return [{declarantUserId: 'declarant-1', zoneId: 'zone-1'}]
    },
    pointPrelevementZone: {
      async findMany() {
        return [{pointPrelevementId: 'point-1'}]
      }
    },
    source: {
      async findFirst(arguments_) {
        detailWhere = arguments_.where
        return null
      }
    }
  }

  await getSourceForInstructor('source-1', {
    readZoneIds: ['zone-1']
  }, {client})

  t.is(detailWhere.id, 'source-1')
  t.deepEqual(detailWhere.OR, instructorSourceScopeWhere({
    declarantUserIds: ['declarant-1'],
    pointIds: ['point-1']
  }).OR)
  t.false(JSON.stringify(detailWhere).includes('zones'))
})

test('liste et détail restent fermés avec des tableaux de zones vides', async t => {
  const countWheres = []
  const detailWheres = []
  const client = {
    pointPrelevementZone: {
      async findMany() {
        throw new Error('Aucune recherche de point ne doit être faite sans zone')
      }
    },
    source: {
      async count(arguments_) {
        countWheres.push(arguments_.where)
        return 0
      },
      async findMany() {
        return []
      },
      async findFirst(arguments_) {
        detailWheres.push(arguments_.where)
        return null
      }
    }
  }

  await listSourcesForInstructor({zoneIds: []}, {client})
  await getSourceForInstructor('source-1', {readZoneIds: []}, {client})

  t.deepEqual(countWheres[0].id, {in: []})
  t.deepEqual(detailWheres[0].id, {in: []})
})

test('visibleSourceWhere masque les sources API terminées sans donnée', t => {
  t.deepEqual(visibleSourceWhere(), {
    NOT: {
      type: 'API',
      status: 'COMPLETED',
      chunks: {none: {}}
    }
  })
})
