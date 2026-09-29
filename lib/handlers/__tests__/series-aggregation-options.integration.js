/* eslint-disable no-await-in-loop -- Synthetic fixtures and assertions use one rollback-only transaction. */
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'

import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {buildAggregationOptionsPayload, listAggregationOptionGroups} from '../series-aggregation-options.js'

const integration = process.env.METER_INTEGRATION_TESTS === '1' ? test.serial : test.skip

test.before(() => {
  if (process.env.METER_INTEGRATION_TESTS === '1') requireDisposableDatabase()
})
test.after.always(async () => {
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

async function withFixture(operation) {
  const rollback = new Error('ROLLBACK_AGGREGATION_OPTIONS')
  try {
    await prisma.$transaction(async client => {
      const key = randomUUID()
      const usage = await client.sandreWaterUse.create({data: {
        code: `opt${key.slice(0, 8)}`, label: 'Usage synthétique options', kind: 'USAGE'
      }})
      const owners = []
      for (let index = 0; index < 2; index++) {
        owners.push(await client.user.create({data: {
          role: 'DECLARANT', declarant: {create: {declarantRole: 'PRELEVEUR', preleveurType: 'IRRIGANT'}}
        }, include: {declarant: true}}))
      }
      const points = []
      for (const flowType of ['PRELEVEMENT', 'REJET']) {
        points.push(await client.pointPrelevement.create({data: {
          name: `Options synthétiques ${key} ${flowType}`, flowType, waterBodyType: 'SUPERFICIELLE'
        }}))
      }
      const exploitations = []
      for (const [pointIndex, ownerIndex, countingCode] of [[0, 0, 'A'], [0, 1, 'B'], [1, 0, 'R']]) {
        exploitations.push(await client.declarantPointPrelevement.create({data: {
          pointPrelevementId: points[pointIndex].id,
          declarantUserId: owners[ownerIndex].id,
          usageId: usage.id,
          countingCode
        }}))
      }
      const source = await client.source.create({data: {type: 'API', status: 'COMPLETED'}})
      await operation(client, {usage, owners, points, exploitations, source})
      throw rollback
    }, {timeout: 30000})
  } catch (error) {
    if (error !== rollback) throw error
  }
}

function value(metricTypeCode, month, unit = 'm³') {
  return {
    metricTypeCode, unit, frequency: '1 day', value: 10,
    periodStart: new Date(`2026-${month}-01T00:00:00Z`),
    periodEnd: new Date(`2026-${month}-02T00:00:00Z`)
  }
}

async function createChunk(client, fixture, values, changes = {}) {
  const exploitation = fixture.exploitations[0]
  return client.chunk.create({data: {
    sourceId: fixture.source.id,
    pointPrelevementId: exploitation.pointPrelevementId,
    exploitationId: exploitation.id,
    preleveurUserId: exploitation.declarantUserId,
    usageId: fixture.usage.id,
    minDate: new Date('2026-01-01Z'),
    maxDate: new Date('2026-12-31Z'),
    instructionStatus: 'VALIDATED',
    chunkValues: {create: values},
    ...changes
  }})
}

// Reference query keeps the original per-exploitation grouping. It is independent
// of the optimized query builder and runs against exactly the same database rows.
async function legacyGroups(client, pointIds) {
  return client.$queryRaw`
    SELECT cv."metricTypeCode", cv.unit, c."exploitationId", exploitation."countingCode",
      point.name AS "pointName", COALESCE(c."flowType", point."flowType")::text AS "flowType",
      min(cv."periodStart") AS "minPeriodStart", min(cv."periodEnd") AS "minPeriodEnd",
      max(cv."periodEnd") AS "maxPeriodEnd", count(DISTINCT cv."chunkId")::int AS "seriesCount"
    FROM "ChunkValue" cv
    JOIN "Chunk" c ON c.id = cv."chunkId"
    JOIN "Source" source ON source.id = c."sourceId"
    LEFT JOIN "PointPrelevement" point ON point.id = c."pointPrelevementId"
    LEFT JOIN "DeclarantPointPrelevement" exploitation ON exploitation.id = c."exploitationId"
    WHERE c."pointPrelevementId" = ANY(${pointIds}::uuid[])
      AND c."instructionStatus" IN ('PENDING', 'VALIDATED', 'AUTOMATICALLY_VALIDATED')
      AND source.status = 'COMPLETED'
    GROUP BY cv."metricTypeCode", cv.unit, c."exploitationId", exploitation."countingCode",
      point.name, COALESCE(c."flowType", point."flowType")
    ORDER BY cv."metricTypeCode", cv.unit NULLS FIRST,
      COALESCE(c."flowType", point."flowType") NULLS FIRST
  `
}

function sortParameters(payload) {
  return {...payload, parameters: [...payload.parameters].sort((a, b) => a.id.localeCompare(b.id))}
}

integration('options SQL : les groupes compacts préservent unités, alias, flux, périodes et index par exploitation', async t => {
  await withFixture(async (client, fixture) => {
    const [first, second, rejectedPointExploitation] = fixture.exploitations
    const duplicate = value('volume', '01', null)
    await createChunk(client, fixture, [
      duplicate,
      {...duplicate, periodStart: new Date('2026-01-02Z'), periodEnd: new Date('2026-01-03Z')},
      value('volume', '02'), value('volume prélevé', '03'),
      value('index', '01'), value('relevé d\'index', '04')
    ])
    await createChunk(client, fixture, [value('volume', '05'), value('index', '05')], {
      exploitationId: second.id, preleveurUserId: second.declarantUserId
    })
    await createChunk(client, fixture, [value('volume', '06')], {
      exploitationId: rejectedPointExploitation.id,
      pointPrelevementId: rejectedPointExploitation.pointPrelevementId
    })
    await createChunk(client, fixture, [value('volume', '07')], {flowType: 'REJET'})
    await createChunk(client, fixture, [value('index', '08', null), value('UNKNOWN_METRIC', '09')], {exploitationId: null})
    await createChunk(client, fixture, [value('volume', '12')], {instructionStatus: 'REJECTED'})
    const pending = await client.source.create({data: {type: 'API', status: 'PENDING'}})
    await createChunk(client, fixture, [value('volume', '11')], {sourceId: pending.id})

    const pointIds = fixture.points.map(point => point.id)
    const resolvedPoints = fixture.points.map(point => ({id: point.id, point}))
    const referenceGroups = await legacyGroups(client, pointIds)

    for (const includeExploitationIndexes of [false, true]) {
      const groupedBySeries = await listAggregationOptionGroups({client, pointIds, includeExploitationIndexes})
      const input = {resolvedPoints, includeExploitationIndexes}
      const reference = buildAggregationOptionsPayload({...input, groupedBySeries: referenceGroups})
      const actual = buildAggregationOptionsPayload({...input, groupedBySeries})
      t.deepEqual(sortParameters(actual), sortParameters(reference))
      t.true(groupedBySeries.length < referenceGroups.length)
      t.like(actual.parameters.find(parameter => parameter.id === 'volume:PRELEVEMENT'), {
        seriesCount: 4, minDate: '2026-01-01', maxDate: '2026-05-01', unit: 'm³'
      })
      t.like(actual.parameters.find(parameter => parameter.id === 'volume:REJET'), {
        seriesCount: 2, minDate: '2026-06-01', maxDate: '2026-07-01'
      })
      const indexes = actual.parameters.filter(parameter => parameter.name === 'index')
      t.is(indexes.length, includeExploitationIndexes ? 3 : 1)
      t.is(indexes.reduce((count, parameter) => count + parameter.seriesCount, 0), 4)
      if (includeExploitationIndexes) {
        t.like(indexes.find(parameter => parameter.exploitationId === first.id), {
          countingCode: 'A', seriesCount: 2, minDate: '2026-01-02', maxDate: '2026-04-02',
          label: `Index de prélèvement — ${fixture.points[0].name} — Comptage A`
        })
      }
      t.deepEqual(buildAggregationOptionsPayload({...input, groupedBySeries, view: 'chart'}), {
        parameters: actual.parameters
      })
    }

    t.deepEqual(await listAggregationOptionGroups({client, pointIds, sourceId: randomUUID()}), [])
  })
})

integration('options SQL METER : le groupage et la vue graphique conservent le périmètre bénéficiaire et les dates Paris', async t => {
  await withFixture(async (client, fixture) => {
    const pointIds = [fixture.points[0].id]
    const resolvedPoints = [{id: pointIds[0], point: fixture.points[0]}]
    const meterValue = {
      metricTypeCode: 'volume', unit: 'm³', frequency: 'irregular', valueKind: 'COMPUTED', value: 23,
      periodStart: new Date('2026-03-28T23:00:00Z'), periodEnd: new Date('2026-03-29T22:00:00Z')
    }
    for (const exploitation of fixture.exploitations.slice(0, 2)) {
      await createChunk(client, fixture, [meterValue], {
        calculationStrategy: 'METER', exploitationId: exploitation.id, preleveurUserId: exploitation.declarantUserId
      })
    }
    await createChunk(client, fixture, [{...meterValue, periodEnd: new Date('2026-12-01T23:00:00Z')}], {
      calculationStrategy: 'METER', instructionStatus: 'REJECTED'
    })
    const [owner, other] = fixture.owners
    for (const [user, expectedCount] of [[{role: 'ADMIN'}, 2], [owner, 1], [other, 1]]) {
      for (const includeExploitationIndexes of [false, true]) {
        const groupedBySeries = await listAggregationOptionGroups({
          client, pointIds, sourceId: fixture.source.id, user, includeExploitationIndexes
        })
        const input = {groupedBySeries, resolvedPoints, includeExploitationIndexes}
        const payload = buildAggregationOptionsPayload(input)
        t.is(payload.parameters.length, 1)
        t.like(payload.parameters[0], {
          seriesCount: expectedCount, minDate: '2026-03-29', maxDate: '2026-03-29'
        })
        t.deepEqual(buildAggregationOptionsPayload({...input, view: 'chart'}), {parameters: payload.parameters})
      }
    }
    for (const restricted of [
      {user: owner, preleveurId: other.id},
      {user: {role: 'DECLARANT', id: randomUUID()}},
      {user: {role: 'INSTRUCTOR'}, pointIds: []}
    ]) {
      t.deepEqual(await listAggregationOptionGroups({client, pointIds, sourceId: fixture.source.id, ...restricted}), [])
    }
  })
})
