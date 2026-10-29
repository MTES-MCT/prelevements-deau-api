import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {sourceForReader, nativeValuesHandler} from '../native-values.js'

const SOURCE = '11111111-1111-4111-8111-111111111111'
const CHUNK = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'
const OWNER = '44444444-4444-4444-8444-444444444444'
const CURSOR = '55555555-5555-4555-8555-555555555555'
const ZONE = '66666666-6666-4666-8666-666666666666'
const POINT = '77777777-7777-4777-8777-777777777777'
const HIDDEN_POINT = '88888888-8888-4888-8888-888888888888'
const UNMATCHED = '99999999-9999-4999-8999-999999999999'

function stub(t, object, method, replacement) {
  const original = object[method]
  object[method] = replacement
  t.teardown(() => { object[method] = original })
}

const user = (declarantRole = 'PRELEVEUR') => ({id: USER, role: 'DECLARANT', declarant: {declarantRole}})

function forbidValueReads(t) {
  stub(t, prisma, '$queryRaw', async () => {throw new Error('Aucune lecture SQL de valeurs avant autorisation')})
  for (const method of ['findMany', 'findFirst', 'count', 'groupBy']) {
    stub(t, prisma.chunkValue, method, async () => {
      throw new Error(`L’autorisation seule ne doit pas appeler chunkValue.${method}`)
    })
  }
}

function stubInstructorScope(t, zoneIds = [ZONE]) {
  stub(t, prisma.instructorZone, 'findMany', async query => {
    t.is(query.where.instructorUserId, USER)
    t.deepEqual(query.where.permissions, {some: {permission: 'declaration.detail.read'}})
    return zoneIds.map(zoneId => ({zoneId}))
  })
  stub(t, prisma.pointPrelevementZone, 'findMany', async query => {
    t.true(zoneIds.length > 0)
    t.deepEqual(query.where.zoneId, {in: zoneIds})
    return [{pointPrelevementId: POINT}]
  })
  stub(t, prisma, '$queryRaw', async query => {
    t.true(zoneIds.length > 0)
    t.true(query.values.includes(ZONE))
    return [{declarantUserId: OWNER, zoneId: ZONE}]
  })
}

function assertAccessProjection(t, query) {
  t.truthy(query.select)
  t.is(query.select.chunks.select.id, true)
  t.false(JSON.stringify(query.select).includes('chunkValues'))
  t.false(JSON.stringify(query.select).includes('_count'))
  t.falsy(query.include)
}

test.serial('autorisation admin : seulement les identifiants, sans valeurs, comptages ni décoration du détail', async t => {
  forbidValueReads(t)
  let source = {id: SOURCE, chunks: [{id: CHUNK}]}
  stub(t, prisma.source, 'findFirst', async query => {
    t.is(query.where.id, SOURCE)
    t.deepEqual(query.where.NOT, {type: 'API', status: 'COMPLETED', chunks: {none: {}}})
    assertAccessProjection(t, query)
    return source
  })
  t.deepEqual((await sourceForReader(SOURCE, {id: USER, role: 'ADMIN'})).chunks, [{id: CHUNK}])
  source = null
  t.is(await sourceForReader(SOURCE, {id: USER, role: 'ADMIN'}), null)
})

test.serial('autorisation agent : droits de lecture, parts METER et PP natifs restent dans le même périmètre', async t => {
  forbidValueReads(t)
  stubInstructorScope(t)
  let nativeIdentity = {metadata: {nativeTemporal: true}}
  stub(t, prisma.source, 'findFirst', async query => {
    t.is(query.where.id, SOURCE)
    t.deepEqual(query.where.OR, [
      {chunks: {some: {pointPrelevementId: {in: [POINT]}}}},
      {declaration: {is: {OR: [{declarantUserId: {in: [OWNER]}}, {createdByDeclarantUserId: {in: [OWNER]}}]}}}
    ])
    assertAccessProjection(t, query)
    t.is(query.select.metadata, true)
    t.is(query.select.declaration.select.type, true)
    t.deepEqual(query.select.chunks.where, {OR: [
      {calculationStrategy: {not: 'METER'}},
      {calculationStrategy: 'METER', pointPrelevementId: {in: [POINT]}}
    ]})
    return {id: SOURCE, type: 'DECLARATION', status: 'PROCESSING', ...nativeIdentity, chunks: [
      {id: CHUNK, pointPrelevementId: POINT, instructionStatus: 'PENDING'},
      {id: CURSOR, pointPrelevementId: HIDDEN_POINT},
      {id: UNMATCHED, pointPrelevementId: null}
    ]}
  })
  const source = await sourceForReader(SOURCE, {id: USER, role: 'INSTRUCTOR'})
  t.deepEqual(source.chunks.map(chunk => chunk.id), [CHUNK, UNMATCHED])
  nativeIdentity = {declaration: {type: 'reunion_multi_param'}}
  const sourceIdentifiedByType = await sourceForReader(SOURCE, {id: USER, role: 'INSTRUCTOR'})
  t.deepEqual(sourceIdentifiedByType.chunks.map(chunk => chunk.id), [CHUNK, UNMATCHED])
})

test.serial('lecture agent sans zone autorisée : aucune valeur ni ouverture du périmètre', async t => {
  forbidValueReads(t)
  stubInstructorScope(t, [])
  stub(t, prisma.source, 'findFirst', async query => {
    t.deepEqual(query.where.id, {in: []})
    assertAccessProjection(t, query)
    return null
  })
  let received
  await nativeValuesHandler({params: {sourceId: SOURCE, chunkId: CHUNK}, query: {}, user: {id: USER, role: 'INSTRUCTOR'}},
    {json() {t.fail('La lecture doit être refusée')}}, error => {received = error})
  t.is(received.status, 404)
})

for (const role of ['ADMIN', 'INSTRUCTOR']) {
  test.serial(`lecture ${role} : une série étrangère au périmètre est refusée avant toute valeur`, async t => {
    forbidValueReads(t)
    if (role === 'INSTRUCTOR') stubInstructorScope(t)
    stub(t, prisma.source, 'findFirst', async query => {
      assertAccessProjection(t, query)
      return {id: SOURCE, metadata: {nativeTemporal: true}, chunks: [
        {id: role === 'INSTRUCTOR' ? CHUNK : CURSOR, pointPrelevementId: HIDDEN_POINT}
      ]}
    })
    let received
    await nativeValuesHandler({params: {sourceId: SOURCE, chunkId: CHUNK}, query: {}, user: {id: USER, role}},
      {json() {t.fail('La lecture doit être refusée')}}, error => {received = error})
    t.is(received.status, 404)
  })

  test.serial(`pagination ${role} : autorisation légère puis lecture bornée de la seule série autorisée`, async t => {
    if (role === 'INSTRUCTOR') stubInstructorScope(t)
    let authorized = false
    stub(t, prisma.source, 'findFirst', async query => {
      assertAccessProjection(t, query)
      authorized = true
      return {id: SOURCE, metadata: {nativeTemporal: true}, chunks: [{id: CHUNK, pointPrelevementId: POINT}]}
    })
    const row = {id: UNMATCHED, periodStart: new Date('2024-01-31T20:00:00.000Z'),
      periodEnd: new Date('2024-02-29T20:00:00.000Z'), value: '12.12345678901234567890123456789', unit: 'm³'}
    stub(t, prisma.chunkValue, 'findFirst', async query => {
      t.true(authorized)
      t.deepEqual(query.where, {chunkId: CHUNK, id: CURSOR})
      t.deepEqual(query.select, {id: true, periodStart: true})
      return {id: CURSOR, periodStart: row.periodStart}
    })
    const permissionQuery = prisma.$queryRaw
    stub(t, prisma, '$queryRaw', async query => {
      if (query.sql.includes('ChunkValueSummary')) {
        t.true(authorized)
        t.deepEqual(query.values.filter(value => typeof value === 'string'), [CHUNK])
        return [{id: CHUNK, valueCount: 12n}]
      }
      if (query.sql.includes('SELECT cv.*')) {
        t.true(authorized)
        t.deepEqual(query.values, [CHUNK, row.periodStart, CURSOR, 2])
        t.regex(query.sql, /ORDER BY cv\."periodStart"(?: ASC)?, cv\.id(?: ASC)?/)
        t.false(query.sql.includes('OFFSET'))
        return [row, {...row, id: OWNER}]
      }
      if (role === 'INSTRUCTOR') return permissionQuery(query)
      throw new Error('Requête inattendue')
    })
    let response
    await nativeValuesHandler({params: {sourceId: SOURCE, chunkId: CHUNK}, query: {limit: '1', cursor: CURSOR}, user: {id: USER, role}},
      {json(value) {response = value}}, error => {throw error})
    t.deepEqual(response.data, {data: [row], total: 12, nextCursor: UNMATCHED})
  })
}

test.serial('lecture des valeurs : un préleveur est limité à ses déclarations ou dépôts', async t => {
  let query
  stub(t, prisma.source, 'findFirst', async input => {query = input; return {id: SOURCE, chunks: [{id: CHUNK}]}})
  stub(t, prisma.declarantCollecteurExploitation, 'findMany', async () => {t.fail('Aucune recherche de délégation pour un préleveur'); return []})
  const result = await sourceForReader(SOURCE, user())
  t.is(result.id, SOURCE)
  t.is(query.where.id, SOURCE)
  t.deepEqual(query.where.declaration.AND[0].OR, [
    {declarantUserId: USER}, {createdByDeclarantUserId: USER}, {declarantUserId: {in: [USER]}}
  ])
  t.deepEqual(query.select, {id: true, chunks: {select: {id: true}}})
})

test.serial('lecture des valeurs : le collecteur hérite uniquement des préleveurs effectivement liés', async t => {
  let query
  stub(t, prisma.declarantCollecteurExploitation, 'findMany', async input => {
    t.deepEqual(input.where, {collecteurUserId: USER})
    return [{exploitation: {declarantUserId: OWNER}}, {exploitation: {declarantUserId: OWNER}}]
  })
  stub(t, prisma.source, 'findFirst', async input => {query = input; return {id: SOURCE, chunks: [{id: CHUNK}]}})
  await sourceForReader(SOURCE, user('COLLECTEUR'))
  t.deepEqual(query.where.declaration.AND[0].OR, [
    {declarantUserId: USER}, {createdByDeclarantUserId: USER}, {declarantUserId: {in: [USER, OWNER]}}
  ])
})

test.serial('lecture des valeurs : un compte de service ne devient pas lecteur humain', async t => {
  stub(t, prisma.source, 'findFirst', async () => {t.fail('La source ne doit pas être interrogée'); return null})
  t.is((await t.throwsAsync(() => sourceForReader(SOURCE, {id: USER, role: 'SERVICE_ACCOUNT'}))).status, 403)
})

test.serial('lecture des valeurs : source inaccessible ou chunk étranger renvoie 404 sans lire de valeur', async t => {
  let source = null
  stub(t, prisma.source, 'findFirst', async () => source)
  forbidValueReads(t)
  const req = {params: {sourceId: SOURCE, chunkId: CHUNK}, query: {}, user: user()}
  const res = {json() {t.fail('La requête doit être refusée')}}
  let received
  await nativeValuesHandler(req, res, error => {received = error})
  t.is(received.status, 404)
  source = {id: SOURCE, chunks: [{id: CURSOR}]}
  await nativeValuesHandler(req, res, error => {received = error})
  t.is(received.status, 404)
})

test.serial('lecture des valeurs : le curseur appartient obligatoirement à la même série', async t => {
  stub(t, prisma.source, 'findFirst', async () => ({id: SOURCE, chunks: [{id: CHUNK}]}))
  stub(t, prisma.chunkValue, 'findFirst', async input => {
    t.deepEqual(input.where, {chunkId: CHUNK, id: CURSOR})
    return null
  })
  stub(t, prisma, '$queryRaw', async () => {throw new Error('Un curseur hors série doit être rejeté avant SQL')})
  let received
  await nativeValuesHandler({params: {sourceId: SOURCE, chunkId: CHUNK}, query: {cursor: CURSOR}, user: user()},
    {json() {t.fail('La requête doit être refusée')}}, error => {received = error})
  t.is(received.status, 400)
})

test.serial('lecture des valeurs : un curseur mal formé est rejeté avant toute requête SQL', async t => {
  stub(t, prisma.source, 'findFirst', async () => {t.fail('Aucune lecture avec un curseur invalide'); return null})
  stub(t, prisma.chunkValue, 'findFirst', async () => {t.fail('Le UUID doit être validé avant Prisma'); return null})
  let received
  await nativeValuesHandler({params: {sourceId: SOURCE, chunkId: CHUNK}, query: {cursor: 'invalide'}, user: user()},
    {json() {t.fail('La requête doit être refusée')}}, error => {received = error})
  t.is(received.status, 400)
})

test.serial('lecture paginée : plafond 200, période exacte et décimale native préservés', async t => {
  stub(t, prisma.source, 'findFirst', async () => ({id: SOURCE, chunks: [{id: CHUNK}]}))
  const date = new Date('2024-02-01T00:05:06.789Z')
  const values = Array.from({length: 201}, (_, index) => ({id: `row-${index}`, periodStart: date, periodEnd: date, value: '12.12345678901234567890123456789', remark: 'Remarque', metadata: {nativeTemporal: true}}))
  stub(t, prisma, '$queryRaw', async query => {
    if (query.sql.includes('ChunkValueSummary')) {
      t.deepEqual(query.values.filter(value => typeof value === 'string'), [CHUNK])
      return [{id: CHUNK, valueCount: 1000n}]
    }
    t.deepEqual(query.values, [CHUNK, 201])
    t.regex(query.sql, /ORDER BY cv\."periodStart"(?: ASC)?, cv\.id(?: ASC)?/)
    t.false(query.sql.includes('OFFSET'))
    return values
  })
  let response
  await nativeValuesHandler({params: {sourceId: SOURCE, chunkId: CHUNK}, query: {limit: '999'}, user: user()},
    {json(value) {response = value}}, error => {throw error})
  t.is(response.data.data.length, 200)
  t.is(response.data.total, 1000)
  t.is(response.data.nextCursor, 'row-199')
  t.is(response.data.data[0].value, '12.12345678901234567890123456789')
  t.is(response.data.data[0].periodStart.toISOString(), '2024-02-01T00:05:06.789Z')
  t.is(response.data.data[0].remark, 'Remarque')
})
