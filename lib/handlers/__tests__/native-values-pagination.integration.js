/* eslint-disable no-await-in-loop -- Pages must be traversed in cursor order. */
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {refreshChunkValueSummaries} from '../../services/chunk-value-summaries.js'
import {nativeValuesHandler} from '../native-values.js'

const integration = process.env.METER_INTEGRATION_TESTS === '1' ? test.serial : test.skip
test.before(() => { if (process.env.METER_INTEGRATION_TESTS === '1') requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function fixture(run) {
  const usage = await prisma.sandreWaterUse.findUniqueOrThrow({where: {code: '0'}})
  const source = await prisma.source.create({data: {type: 'API', status: 'COMPLETED', metadata: {nativeTemporal: true}}})
  const chunkIds = [randomUUID(), randomUUID()]
  try {
    await prisma.chunk.createMany({data: chunkIds.map(id => ({id, sourceId: source.id, usageId: usage.id,
      minDate: new Date('2026-01-01'), maxDate: new Date('2026-01-03'), metadata: {nativeTemporal: true}, instructionStatus: 'VALIDATED'}))})
    const values = Array.from({length: 123}, (_, index) => ({id: randomUUID(), chunkId: chunkIds[0], metricTypeCode: 'index', unit: 'm³', frequency: 'instant',
      periodStart: new Date(`2026-01-0${Math.floor(index / 50) + 1}T20:00:00.123Z`), periodEnd: new Date(`2026-01-0${Math.floor(index / 50) + 1}T20:00:00.123Z`),
      value: '9007199254740993.12345678901234567890123456789', remark: `Observation synthétique ${index}`, metadata: {row: index + 4, nativeTemporal: true}}))
    await prisma.chunkValue.createMany({data: values})
    const foreign = await prisma.chunkValue.create({data: {...values[0], id: randomUUID(), chunkId: chunkIds[1]}})
    const request = async (query = {}) => {
      let response, failure
      await nativeValuesHandler({params: {sourceId: source.id, chunkId: chunkIds[0]}, user: {role: 'ADMIN'}, query},
        {json(value) {response = value}}, error => {failure = error})
      if (failure) throw failure
      return response.data
    }
    await run({source, chunkIds, values, foreign, request})
  } finally { await prisma.source.delete({where: {id: source.id}}) }
}

integration('pagination SQL froide et chaude : aucun oubli ou doublon entre instants égaux, précision et total conservés', async t => {
  await fixture(async ({chunkIds, values, request}) => {
    const expected = await prisma.chunkValue.findMany({where: {chunkId: chunkIds[0]}, orderBy: [{periodStart: 'asc'}, {id: 'asc'}]})
    for (const warm of [false, true]) {
      if (warm) await refreshChunkValueSummaries(chunkIds)
      const collected = []
      let cursor
      do {
        const page = await request({limit: '17', ...(cursor ? {cursor} : {})})
        t.is(page.total, 123)
        t.is(typeof page.total, 'number')
        t.true(page.data.length <= 17)
        collected.push(...page.data)
        cursor = page.nextCursor
      } while (cursor)
      t.deepEqual(collected.map(row => row.id), expected.map(row => row.id))
      t.is(new Set(collected.map(row => row.id)).size, 123)
      t.true(collected.every(row => row.value.toString() === values[0].value))
      t.deepEqual(collected.map(row => row.periodStart), expected.map(row => row.periodStart))
      t.deepEqual(collected.map(row => row.metadata), expected.map(row => row.metadata))
    }
    const last = await request({cursor: expected.at(-1).id})
    t.deepEqual(last.data, [])
    t.is(last.nextCursor, null)
    t.is(last.total, 123)
  })
})

integration('pagination SQL : curseur étranger refusé et total exact dès une écriture qui invalide le cache', async t => {
  await fixture(async ({chunkIds, values, foreign, request}) => {
    await refreshChunkValueSummaries(chunkIds)
    t.is((await t.throwsAsync(request({cursor: foreign.id}))).status, 400)
    await prisma.chunkValue.delete({where: {id: values[0].id}})
    t.false((await prisma.chunkValueSummary.findUnique({where: {chunkId: chunkIds[0]}})).valid)
    t.is((await request()).total, 122)
    t.is((await t.throwsAsync(request({cursor: values[0].id}))).status, 400)
    t.false((await prisma.chunkValueSummary.findUnique({where: {chunkId: chunkIds[0]}})).valid)
  })
})
