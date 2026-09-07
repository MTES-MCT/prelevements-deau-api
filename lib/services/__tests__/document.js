import test from 'ava'

import {
  assertCanLinkDocumentExploitations,
  assertExploitationsBelongToDeclarant,
  getExploitationDocumentsFromRelations
} from '../document.js'

function createClient(exploitations) {
  return {
    declarantPointPrelevement: {
      async findMany() {
        return exploitations
      }
    }
  }
}

function createZoneClient({permittedZoneIds, zonesByExploitation}) {
  const queries = []

  return {
    queries,
    instructorZone: {
      async findMany(query) {
        queries.push({type: 'permissions', query})
        return permittedZoneIds.map(zoneId => ({zoneId}))
      }
    },
    declarantPointPrelevement: {
      async count(query) {
        queries.push({type: 'coverage', query})
        const requestedIds = query.where.id.in
        const allowedZoneIds = query.where.pointPrelevement.zones.some.zoneId.in

        return requestedIds.filter(exploitationId =>
          (zonesByExploitation.get(exploitationId) ?? [])
            .some(zoneId => allowedZoneIds.includes(zoneId))).length
      }
    }
  }
}

test('assertExploitationsBelongToDeclarant accepte seulement un propriétaire commun', async t => {
  await t.notThrowsAsync(assertExploitationsBelongToDeclarant(
    ['exploitation-1', 'exploitation-2'],
    'declarant-1',
    {
      client: createClient([
        {id: 'exploitation-1', declarantUserId: 'declarant-1'},
        {id: 'exploitation-2', declarantUserId: 'declarant-1'}
      ])
    }
  ))

  const error = await t.throwsAsync(assertExploitationsBelongToDeclarant(
    ['exploitation-1', 'exploitation-2'],
    'declarant-1',
    {
      client: createClient([
        {id: 'exploitation-1', declarantUserId: 'declarant-1'},
        {id: 'exploitation-2', declarantUserId: 'declarant-2'}
      ])
    }
  ))

  t.is(error.status, 400)
  t.regex(error.message, /n’est pas rattachée/)
})

test('assertExploitationsBelongToDeclarant signale une exploitation absente', async t => {
  const error = await t.throwsAsync(assertExploitationsBelongToDeclarant(
    ['exploitation-1', 'exploitation-2'],
    'declarant-1',
    {
      client: createClient([
        {id: 'exploitation-1', declarantUserId: 'declarant-1'}
      ])
    }
  ))

  t.is(error.status, 400)
  t.regex(error.message, /est introuvable/)
})

test('un instructeur peut lier toutes les exploitations couvertes par ses zones document.update', async t => {
  const client = createZoneClient({
    permittedZoneIds: ['zone-1', 'zone-2'],
    zonesByExploitation: new Map([
      ['exploitation-1', ['zone-1']],
      ['exploitation-2', ['zone-2', 'zone-3']]
    ])
  })

  await t.notThrowsAsync(assertCanLinkDocumentExploitations(
    {id: 'instructor-1', role: 'INSTRUCTOR'},
    ['exploitation-1', 'exploitation-2', 'exploitation-2'],
    {client, now: new Date('2026-08-27T12:00:00.000Z')}
  ))

  const permissionQuery = client.queries.find(item => item.type === 'permissions').query
  const coverageQuery = client.queries.find(item => item.type === 'coverage').query
  t.is(permissionQuery.where.permissions.some.permission, 'declarant.document.update')
  t.deepEqual(coverageQuery.where.id.in, ['exploitation-1', 'exploitation-2'])
  t.deepEqual(
    coverageQuery.where.pointPrelevement.zones.some.zoneId.in,
    ['zone-1', 'zone-2']
  )
})

test('un instructeur ne peut pas ajouter un seul lien hors de ses zones document.update', async t => {
  const client = createZoneClient({
    permittedZoneIds: ['zone-1'],
    zonesByExploitation: new Map([
      ['exploitation-1', ['zone-1']],
      ['exploitation-2', ['zone-2']]
    ])
  })

  const error = await t.throwsAsync(assertCanLinkDocumentExploitations(
    {id: 'instructor-1', role: 'INSTRUCTOR'},
    ['exploitation-1', 'exploitation-2'],
    {client}
  ))

  t.is(error.status, 403)
  t.regex(error.message, /ne sont pas couvertes/)
})

test('le garde-fou accepte la permission document.create pour une création', async t => {
  const client = createZoneClient({
    permittedZoneIds: ['zone-1'],
    zonesByExploitation: new Map([['exploitation-1', ['zone-1']]])
  })

  await assertCanLinkDocumentExploitations(
    {id: 'instructor-1', role: 'INSTRUCTOR'},
    ['exploitation-1'],
    {client, permission: 'declarant.document.create'}
  )

  const permissionQuery = client.queries.find(item => item.type === 'permissions').query
  t.is(permissionQuery.where.permissions.some.permission, 'declarant.document.create')
})

test('un administrateur conserve la possibilité de lier des exploitations inter-zones', async t => {
  const client = new Proxy({}, {
    get() {
      t.fail('Aucune requête de zone ne doit être faite pour un administrateur.')
    }
  })

  await t.notThrowsAsync(assertCanLinkDocumentExploitations(
    {id: 'admin-1', role: 'ADMIN'},
    ['exploitation-1', 'exploitation-2'],
    {client}
  ))
})

test('getExploitationDocumentsFromRelations fusionne les liens anciens et N-N', t => {
  const legacy = {id: 'document-1', createdAt: new Date('2026-01-01'), deletedAt: null}
  const shared = {id: 'document-2', createdAt: new Date('2026-02-01'), deletedAt: null}
  const deleted = {id: 'document-3', createdAt: new Date('2026-03-01'), deletedAt: new Date()}

  const documents = getExploitationDocumentsFromRelations({
    documents: [legacy, shared],
    documentLinks: [
      {resourceDocument: shared},
      {resourceDocument: deleted}
    ]
  })

  t.deepEqual(documents.map(document => document.id), ['document-2', 'document-1'])
})
