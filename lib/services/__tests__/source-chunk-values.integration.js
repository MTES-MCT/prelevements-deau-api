import process from 'node:process'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {loadSourceChunkValues} from '../source-chunk-values.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

integration('comptages natifs et valeurs legacy restent exacts et bornés aux chunks visibles', async t => {
  const rollback = new Error('ROLLBACK_SOURCE_CHUNK_VALUES')
  try {
    await prisma.$transaction(async client => {
      const usage = await client.sandreWaterUse.findUniqueOrThrow({where: {code: '2'}})
      const date = new Date('2026-01-01T00:00:00Z')
      const nativeValue = {metricTypeCode: 'index', unit: 'm³', frequency: 'instant', periodStart: date, periodEnd: date,
        value: '12.123456789012345', metadata: {nativeTemporal: true}}
      const legacyValue = {...nativeValue, frequency: 'daily', periodEnd: new Date('2026-01-02T00:00:00Z'), metadata: {}, remark: 'Remarque conservée'}
      const chunk = {usageId: usage.id, minDate: date, maxDate: date}
      const source = await client.source.create({data: {type: 'DECLARATION', status: 'COMPLETED', chunks: {create: [
        {...chunk, seriesKey: 'native', metadata: {nativeTemporal: true}, chunkValues: {create: [nativeValue,
          {...nativeValue, periodStart: new Date('2026-01-01T00:10:00Z'), periodEnd: new Date('2026-01-01T00:10:00Z'), value: '13'}]}},
        {...chunk, seriesKey: 'legacy', chunkValues: {create: [legacyValue]}},
        {...chunk, seriesKey: 'empty'},
        {...chunk, seriesKey: 'hidden', metadata: {nativeTemporal: true}, chunkValues: {create: [nativeValue]}}
      ]}}, include: {chunks: true}})
      const visible = {...source, chunks: source.chunks.filter(item => item.seriesKey !== 'hidden')}
      await loadSourceChunkValues([visible], {client, includeLegacyValues: true})
      const chunks = Object.fromEntries(visible.chunks.map(item => [item.seriesKey, item]))
      t.is(chunks.native._count.chunkValues, 2)
      t.deepEqual(chunks.native.chunkValues, [])
      t.is(chunks.legacy._count.chunkValues, 1)
      t.is(chunks.legacy.chunkValues[0].value.toFixed(), legacyValue.value)
      t.is(chunks.legacy.chunkValues[0].remark, legacyValue.remark)
      t.deepEqual(chunks.legacy.chunkValues[0].periodEnd, legacyValue.periodEnd)
      t.is(chunks.empty._count.chunkValues, 0)
      t.deepEqual(chunks.empty.chunkValues, [])
      t.falsy(chunks.hidden)
      throw rollback
    }, {timeout: 30000})
  } catch (error) { if (error !== rollback) throw error }
})
