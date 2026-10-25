import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {sourceForReader, nativeValuesHandler} from '../native-values.js'

const SOURCE = '11111111-1111-4111-8111-111111111111'
const CHUNK = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'
const OWNER = '44444444-4444-4444-8444-444444444444'
const CURSOR = '55555555-5555-4555-8555-555555555555'

function stub(t, object, method, replacement) {
  const original = object[method]
  object[method] = replacement
  t.teardown(() => { object[method] = original })
}

const user = (declarantRole = 'PRELEVEUR') => ({id: USER, role: 'DECLARANT', declarant: {declarantRole}})

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
  stub(t, prisma.chunkValue, 'findMany', async () => {t.fail('Aucune lecture de valeurs hors périmètre'); return []})
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
  stub(t, prisma.chunkValue, 'findMany', async () => {t.fail('Un curseur hors série doit être rejeté'); return []})
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
  stub(t, prisma.chunkValue, 'findMany', async input => {
    t.deepEqual(input.where, {chunkId: CHUNK})
    t.is(input.take, 201)
    t.deepEqual(input.orderBy, [{periodStart: 'asc'}, {id: 'asc'}])
    return values
  })
  stub(t, prisma.chunkValue, 'count', async input => {t.deepEqual(input.where, {chunkId: CHUNK}); return 1000})
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
