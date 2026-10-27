import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {getDeclarationDetailHandler, getMyTelemetrySourceHandler, listMyDeclarationsHandler, listMyTelemetrySourcesHandler} from '../declarations.js'

const userId = '11111111-1111-4111-8111-111111111111'
const sourceId = '22222222-2222-4222-8222-222222222222'
const declarationId = '33333333-3333-4333-8333-333333333333'
const user = {id: userId, role: 'DECLARANT', declarant: {declarantRole: 'PRELEVEUR'}}

function nativeSource() {
  return {id: sourceId, status: 'COMPLETED',
    metadata: {nativeTemporal: true, nativeBatch: {keys: ['internal-receipt'], hashes: ['internal-hash']},
      parsingErrors: [{seriesKey: 'visible', message: 'Visible'}, {seriesKey: 'hidden', message: 'Hors périmètre'}]},
    chunks: [{id: 'visible-chunk', seriesKey: 'visible', instructionStatus: 'VALIDATED', calculationStrategy: 'GENERIC',
      metadata: {nativeTemporal: true, totalWaterVolumeWithdrawn: 12}, _count: {chunkValues: 2_800_000}, chunkValues: []}]}
}

function stub(t, target, name, implementation) {
  const original = target[name]
  target[name] = implementation
  t.teardown(() => { target[name] = original })
}

async function invoke(handler, req) {
  let response
  await handler(req, {json(value) { response = value }}, error => { throw error })
  return response
}

test.serial('la liste du déclarant retire les reçus natifs sans charger les valeurs ni changer les anciens dossiers', async t => {
  const source = nativeSource()
  const legacy = {id: 'legacy',  metadata: {legacyField: true}, chunks: []}
  let query
  stub(t, prisma.declarant, 'findUnique', async () => ({declarantRole: 'PRELEVEUR', quickDeclarationEnabled: false}))
  stub(t, prisma.declarantDeclarationType, 'findMany', async () => [])
  stub(t, prisma.declaration, 'findMany', async value => {
    query = value
    return [{id: declarationId, source}, {id: 'legacy-declaration', source: legacy}]
  })
  const response = await invoke(listMyDeclarationsHandler, {user})
  t.false(Object.hasOwn(response.data[0].source.metadata, 'nativeBatch'))
  t.truthy(source.metadata.nativeBatch)
  t.is(response.data[1].source, legacy)
  t.falsy(query.include.source.include.chunks.include.chunkValues)
  t.true(query.include.source.include.chunks.include._count.select.chunkValues)
  t.deepEqual(query.where.AND[0], {OR: [{declarantUserId: userId}, {createdByDeclarantUserId: userId}]})
})

test.serial('le détail natif reste un résumé même avec plusieurs millions de valeurs et garde le contrôle propriétaire', async t => {
  let query
  stub(t, prisma.declaration, 'findFirst', async value => {
    query = value
    return {id: declarationId, declarantUserId: userId, files: [], source: nativeSource()}
  })
  stub(t, prisma, '$queryRaw', async query => {
    t.regex(query.sql, /ChunkValueSummary/)
    t.deepEqual(query.values.filter(value => typeof value === 'string'), ['visible-chunk'])
    return [{id: 'visible-chunk', valueCount: 2_800_000n}]
  })
  stub(t, prisma.chunkValue, 'findMany', async () => {t.fail('Les valeurs natives ne sont pas préchargées'); return []})
  const response = await invoke(getDeclarationDetailHandler, {user, params: {declarationId}})
  t.false(Object.hasOwn(response.data.source.metadata, 'nativeBatch'))
  t.deepEqual(response.data.source.chunks[0].chunkValues, [])
  t.is(response.data.source.chunks[0]._count.chunkValues, 2_800_000)
  t.falsy(query.include.source.include.chunks.include.chunkValues)
  t.falsy(query.include.source.include.chunks.include._count)
  t.deepEqual(query.where.AND[0], {OR: [{declarantUserId: userId}, {createdByDeclarantUserId: userId}]})
})

for (const [label, handler, method] of [
  ['liste', listMyTelemetrySourcesHandler, 'findMany'],
  ['détail', getMyTelemetrySourceHandler, 'findFirst']
]) {
  test.serial(`télémétrie ${label} : une source native partiellement visible ne divulgue ni reçu ni anomalie hors périmètre`, async t => {
    let query
    const source = {...nativeSource(), type: 'API', _count: {chunks: 2}}
    stub(t, prisma.source, method, async value => {
      query = value
      return method === 'findMany' ? [source] : source
    })
    stub(t, prisma, '$queryRaw', async query => {
      t.regex(query.sql, /ChunkValueSummary/)
      t.deepEqual(query.values.filter(value => typeof value === 'string'), ['visible-chunk'])
      return [{id: 'visible-chunk', valueCount: 2_800_000n}]
    })
    stub(t, prisma.chunkValue, 'findMany', async () => {t.fail('Les valeurs natives ne sont pas préchargées'); return []})
    const response = await invoke(handler, {user, params: {sourceId}})
    const result = method === 'findMany' ? response.data[0] : response.data
    t.false(Object.hasOwn(result.metadata, 'nativeBatch'))
    t.deepEqual(result.metadata.parsingErrors, [{seriesKey: 'visible', message: 'Visible'}])
    t.is(result._count.chunks, 1)
    t.is(result.metadata.totalWaterVolumeWithdrawn, 12)
    t.truthy(query.where.chunks.some)
    t.truthy(query.include.chunks.where)
    if (method === 'findFirst') {
      t.falsy(query.include.chunks.include.chunkValues)
      t.falsy(query.include.chunks.include._count)
    } else {
      t.falsy(query.include.chunks.include.chunkValues)
    }
  })
}
