import test from 'ava'

import {
  getSourceForInstructor,
  getValidatedChunkConflictsForChunks,
  getSourceChunkMutationCapabilities,
  instructorSourceScopeWhere,
  listSourcesForAdmin,
  listSourcesForInstructor,
  visibleSourceWhere
} from '../instructor-sources.js'

test('les conflits d’instruction distinguent les comptages sans oublier les anciennes séries sans identité', async t => {
  const common = {pointPrelevementId: 'point', preleveurUserId: 'owner', minDate: new Date('2026-01-01'), maxDate: new Date('2026-01-31')}
  let query
  const rows = [
    {...common, id: 'same', sourceId: 'source', exploitationId: 'exp-a'},
    {...common, id: 'other', sourceId: 'source', exploitationId: 'exp-b'},
    {...common, id: 'legacy', sourceId: 'source', exploitationId: null}
  ]
  const result = await getValidatedChunkConflictsForChunks([{...common, id: 'incoming', exploitationId: 'exp-a'}], {
    chunk: {async findMany(input) {query = input; return rows}}
  })
  t.true(query.select.exploitationId)
  t.deepEqual(result.incoming.map(conflict => conflict.chunkId), ['same', 'legacy'])
  t.is(result.incoming[0].exploitationId, 'exp-a')
})

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
  t.true(countWhere.AND.some(condition => JSON.stringify(condition) === JSON.stringify(expectedScope)))
  t.true(listWhere.AND.some(condition => JSON.stringify(condition) === JSON.stringify(expectedScope)))
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

  t.true(countWheres[0].AND.some(condition => JSON.stringify(condition) === JSON.stringify({id: {in: []}})))
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

test('les sources compteur restent lisibles mais sans boutons d’instruction ni de rapprochement génériques', t => {
  const chunk = {calculationStrategy: 'METER', pointPrelevementId: 'point', parsingInfo: {pointAssociationOrigin: 'MANUAL'}}
  t.deepEqual(getSourceChunkMutationCapabilities(chunk, {canInstruct: true, canReconcile: true}), {canInstruct: false, canReconcile: false})
})

test('un reçu de campagne se corrige depuis sa réponse et ne propose pas d’instruction séparée', t => {
  const chunk = {calculationStrategy: 'GENERIC', metadata: {collectionResponseId: 'response'},
    pointPrelevementId: 'point', parsingInfo: {pointAssociationOrigin: 'MANUAL'}}
  t.deepEqual(getSourceChunkMutationCapabilities(chunk, {canInstruct: true, canReconcile: true}), {canInstruct: false, canReconcile: false})
})

test('les capacités des chunks ordinaires gardent leurs contrôles de droits et d’association', t => {
  const chunk = {calculationStrategy: 'GENERIC', pointPrelevementId: 'point', parsingInfo: {pointAssociationOrigin: 'MANUAL'}}
  t.deepEqual(getSourceChunkMutationCapabilities(chunk, {canInstruct: true, canReconcile: true}), {canInstruct: true, canReconcile: true})
  t.deepEqual(getSourceChunkMutationCapabilities(chunk), {canInstruct: false, canReconcile: false})
  t.deepEqual(getSourceChunkMutationCapabilities({...chunk, parsingInfo: {}}, {canInstruct: true, canReconcile: true}), {canInstruct: true, canReconcile: false})
})

test('le filtre de type et la recherche restent combinés au périmètre instructeur sans écrasement des OR', async t => {
  let options
  const client = {
    $queryRaw: async () => [],
    pointPrelevementZone: {findMany: async () => [{pointPrelevementId: 'point'}]},
    source: {count: async () => 0, findMany: async value => { options = value; return [] }}
  }
  await listSourcesForInstructor({zoneIds: ['zone'], types: ['API'], declarant: 'Test'}, {client})
  t.is(options.where.AND.filter(condition => condition.OR).length, 3)
  t.true(JSON.stringify(options.where).includes('"type":"API"'))
  const meteredSearch = options.where.AND.flatMap(condition => condition.OR ?? []).find(condition => condition.chunks?.some?.preleveur)
  t.is(meteredSearch.chunks.some.calculationStrategy, 'METER')
  t.deepEqual(meteredSearch.chunks.some.pointPrelevementId, {in: ['point']})
  t.deepEqual(options.include.chunks.where.OR[1], {calculationStrategy: 'METER', pointPrelevementId: {in: ['point']}})
})

test('la recherche administrateur retrouve un bénéficiaire de télérelève sans Declaration artificielle', async t => {
  let where
  const client = {source: {count: async () => 0, findMany: async query => { where = query.where; return [] }}}
  await listSourcesForAdmin({types: ['API'], declarant: 'Test'}, {client})
  const search = where.AND.find(condition => condition.OR?.some(item => item.chunks))
  t.is(search.OR[1].chunks.some.calculationStrategy, 'METER')
  t.is(search.OR[1].chunks.some.preleveur.OR[0].socialReason.contains, 'Test')
})

test('le filtre Télérelève utilise les valeurs exactes Paris et le même chunk autorisé, sans changer le legacy', async t => {
  let query
  const client = {
    $queryRaw: async () => [],
    pointPrelevementZone: {findMany: async () => [{pointPrelevementId: 'allowed-point'}]},
    source: {count: async () => 0, findMany: async args => { query = args; return [] }}
  }
  const startDate = new Date('2026-09-01Z'), endDate = new Date('2026-09-01Z')
  await listSourcesForInstructor({zoneIds: ['zone'], startDate, endDate}, {client})
  const period = query.where.AND.find(condition => condition.chunks?.some?.OR).chunks.some.OR
  t.deepEqual(period[0], {calculationStrategy: {not: 'METER'}, maxDate: {gte: startDate}, minDate: {lte: endDate}})
  t.deepEqual(period[1], {calculationStrategy: 'METER', pointPrelevementId: {in: ['allowed-point']}, chunkValues: {some: {
    periodEnd: {gt: new Date('2026-08-31T22:00:00Z')}, periodStart: {lt: new Date('2026-09-01T22:00:00Z')}
  }}})
})

test('le filtre ADMIN respecte les journées de 23h et 25h des changements d’heure Paris', async t => {
  let query
  const client = {source: {count: async () => 0, findMany: async args => { query = args; return [] }}}
  for (const [day, from, to] of [
    ['2026-03-29', '2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z'],
    ['2026-10-25', '2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z']
  ]) {
    // eslint-disable-next-line no-await-in-loop -- Inspect each captured query independently.
    await listSourcesForAdmin({startDate: new Date(day), endDate: new Date(day)}, {client})
    const metered = query.where.AND.find(condition => condition.chunks?.some?.OR).chunks.some.OR[1]
    t.deepEqual(metered.chunkValues.some, {periodEnd: {gt: new Date(from)}, periodStart: {lt: new Date(to)}})
    t.false(Object.hasOwn(metered, 'pointPrelevementId'))
  }
})
