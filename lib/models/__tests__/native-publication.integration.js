/* eslint-disable no-await-in-loop -- Fixtures are isolated in a rollback-only transaction. */
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {getSeriesById, getSeriesValuesInRange, listSeries} from '../series.js'
import {refreshDeclarantsLastDeclarationAt} from '../declarant.js'
import {normalizeExportFilters, queryExportRows, rowToExportObject} from '../../services/data-exports.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function withFixture(run) {
  const rollback = new Error('ROLLBACK_NATIVE_PUBLICATION_FIXTURES')
  try {
    await prisma.$transaction(async client => {
      const key = randomUUID()
      const user = await client.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'GESTIONNAIRE_AEP'}}}})
      const usage = await client.sandreWaterUse.create({data: {code: `n${key.slice(0, 8)}`, label: 'Usage synthétique', kind: 'USAGE'}})
      const point = await client.pointPrelevement.create({data: {name: `Point synthétique ${key}`, flowType: 'PRELEVEMENT', waterBodyType: 'SUPERFICIELLE'}})
      const sources = []
      for (const [native, status, createdAt] of [[true, 'VALIDATED', '2026-10-01'], [true, 'PENDING', '2026-10-02'], [true, 'REJECTED', '2026-10-03'], [false, 'PENDING', '2026-09-30']]) {
        const metadata = native ? {nativeTemporal: true, timezone: 'Indian/Reunion', parameter: 'pH', valueType: 'instantaneous', frequency: '1 second'} : undefined
        const source = await client.source.create({data: {type: 'API', status: 'COMPLETED', createdAt: new Date(createdAt), chunks: {create: {
          pointPrelevementId: point.id, preleveurUserId: user.id, usageId: usage.id, instructionStatus: status, autoCalculateVolumes: false,
          metadata, minDate: new Date('2026-10-25'), maxDate: new Date('2026-10-26'), chunkValues: {create: (native ? [
            ['2026-10-24T19:59:59.999Z', '6'], ['2026-10-24T20:00:00.000Z', '7.123456789012345'], ['2026-10-25T20:00:00.000Z', '8']
          ] : [['2026-10-25T00:00:00.000Z', '9']]).map(([date, value]) => ({
            metricTypeCode: 'pH', frequency: '1 second', unit: 'autre', valueKind: 'DECLARED', value,
            periodStart: new Date(date), periodEnd: native ? new Date(date) : new Date(+new Date(date) + 1),
            metadata: native ? {nativeTemporal: true, row: 13} : undefined, remark: native ? 'Remarque native' : null
          }))}
        }}}, include: {chunks: true}})
        sources.push(source)
      }
      await run(client, {user, point, sources})
      throw rollback
    }, {timeout: 30000})
  } catch (error) { if (error !== rollback) throw error }
}

integration('publication native : bornes Réunion, instant minuit, précision et compatibilité legacy', async t => {
  await withFixture(async (client, {point, sources}) => {
    const options = {startDate: '2026-10-25', endDate: '2026-10-25'}
    const series = await listSeries({pointIds: [point.id], parameter: 'pH', ...options}, {client})
    t.is(series.length, 3)
    const nativeChunk = sources[0].chunks[0]
    const native = series.find(item => item.computed.chunkId === nativeChunk.id)
    t.like(native, {valueType: 'instantaneous', minDate: '2026-10-25', maxDate: '2026-10-25', hasSubDaily: true, numberOfValues: 1})
    const values = await getSeriesValuesInRange(native.id, options, client)
    t.is(values.length, 1)
    t.like(values[0], {date: '2026-10-24T20:00:00.000Z', values: {value: '7.123456789012345'}, remark: 'Remarque native', timezone: 'Indian/Reunion'})
    t.truthy(await getSeriesById(`${sources[1].chunks[0].id}:pH`, client))
    t.is(await getSeriesById(`${sources[2].chunks[0].id}:pH`, client), null)
    t.deepEqual(await getSeriesValuesInRange(`${sources[2].chunks[0].id}:pH`, options, client), [])
    const legacyValues = await getSeriesValuesInRange(`${sources[3].chunks[0].id}:pH`, options, client)
    t.is(legacyValues.length, 1)
    t.is(legacyValues[0].values.value, 9)
    const exports = (await queryExportRows({user: {role: 'ADMIN'}, filters: normalizeExportFilters(options), allowedZoneIds: [], client}))
      .filter(row => row.pointPrelevementId === point.id).map(rowToExportObject)
    t.is(exports.length, 3)
    t.true(exports.some(row => row.valeur === '7.123456789012345' && row.dateMesure === '2026-10-25'))
    t.false(exports.some(row => row.valeur === '6' || row.valeur === '8'))
  })
})

integration('les sources natives publiées rafraîchissent l’activité, les rejetées restent exclues', async t => {
  await withFixture(async (client, {user}) => {
    await refreshDeclarantsLastDeclarationAt([user.id], {client})
    const declarant = await client.declarant.findUnique({where: {userId: user.id}})
    t.is(declarant.lastDeclarationAt.toISOString(), '2026-10-02T00:00:00.000Z')
  })
})
