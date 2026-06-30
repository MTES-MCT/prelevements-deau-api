import test from 'ava'
import {randomUUID} from 'node:crypto'
import '../../config/env.js'
import {prisma} from '../../../db/prisma.js'
import {METRIC_TYPE_CODES} from '../../constants/metric-type-codes.js'
import {applyConflictPolicyForIncomingChunkValues} from '../chunk-value-conflicts.js'

test.after.always(async () => {
  await prisma.$disconnect()
  await globalThis.pgPool?.end?.()
  globalThis.pgPool = undefined
  globalThis.prismaAdapter = undefined
  globalThis.prisma = undefined
})

function monthPeriod(year, monthIndex) {
  return {
    start: new Date(Date.UTC(year, monthIndex, 1)),
    end: new Date(Date.UTC(year, monthIndex + 1, 1))
  }
}

async function createFixture() {
  const suffix = randomUUID()
  const usage = await prisma.sandreWaterUse.create({
    data: {
      code: `TEST-${suffix.slice(0, 8)}`,
      kind: 'USAGE',
      label: 'Usage test'
    }
  })
  const point = await prisma.pointPrelevement.create({
    data: {
      name: `Point test ${suffix}`
    }
  })
  const source = await prisma.source.create({
    data: {
      type: 'API',
      status: 'COMPLETED',
      metadata: {
        totalWaterVolumeWithdrawn: 600,
        totalWaterVolumeDischarged: 50
      }
    }
  })
  const may = monthPeriod(2025, 4)
  const june = monthPeriod(2025, 5)
  const july = monthPeriod(2025, 6)
  const chunk = await prisma.chunk.create({
    data: {
      sourceId: source.id,
      pointPrelevementId: point.id,
      pointPrelevementName: point.name,
      usageId: usage.id,
      instructionStatus: 'VALIDATED',
      minDate: may.start,
      maxDate: july.end,
      metadata: {
        totalWaterVolumeWithdrawn: 600,
        totalWaterVolumeDischarged: 50
      }
    }
  })

  await prisma.chunkValue.createMany({
    data: [
      {
        chunkId: chunk.id,
        metricTypeCode: METRIC_TYPE_CODES.VOLUME_PRELEVE,
        unit: 'm3',
        frequency: '1 month',
        periodStart: may.start,
        periodEnd: may.end,
        valueKind: 'DECLARED',
        value: 100
      },
      {
        chunkId: chunk.id,
        metricTypeCode: METRIC_TYPE_CODES.VOLUME_PRELEVE,
        unit: 'm3',
        frequency: '1 month',
        periodStart: june.start,
        periodEnd: june.end,
        valueKind: 'DECLARED',
        value: 200
      },
      {
        chunkId: chunk.id,
        metricTypeCode: METRIC_TYPE_CODES.VOLUME_PRELEVE,
        unit: 'm3',
        frequency: '1 month',
        periodStart: july.start,
        periodEnd: july.end,
        valueKind: 'DECLARED',
        value: 300
      },
      {
        chunkId: chunk.id,
        metricTypeCode: METRIC_TYPE_CODES.VOLUME_REJETE,
        unit: 'm3',
        frequency: '1 month',
        periodStart: may.start,
        periodEnd: may.end,
        valueKind: 'DECLARED',
        value: 50
      }
    ]
  })

  return {chunk, june, july, may, point, source, usage}
}

async function cleanupFixture({point, source, usage}) {
  await prisma.source.deleteMany({where: {id: source.id}})
  await prisma.pointPrelevement.deleteMany({where: {id: point.id}})
  await prisma.sandreWaterUse.deleteMany({where: {id: usage.id}})
}

test.serial('REPLACE_EXISTING remplace seulement les valeurs en conflit et conserve les mois suivants', async t => {
  const fixture = await createFixture()

  try {
    const result = await applyConflictPolicyForIncomingChunkValues({
      pointPrelevementId: fixture.point.id,
      requestedPolicy: 'REPLACE_EXISTING',
      replaceComment: 'AUTO_REPLACED_BY_TEST',
      valueRows: [
        {
          metricTypeCode: METRIC_TYPE_CODES.VOLUME_PRELEVE,
          periodStart: fixture.may.start,
          periodEnd: fixture.may.end
        },
        {
          metricTypeCode: METRIC_TYPE_CODES.VOLUME_PRELEVE,
          periodStart: fixture.june.start,
          periodEnd: fixture.june.end
        }
      ]
    })

    t.false(result.shouldSkip)
    t.deepEqual(result.replacedChunkIds, [fixture.chunk.id])

    const chunk = await prisma.chunk.findUnique({
      where: {id: fixture.chunk.id},
      select: {instructionStatus: true, minDate: true, maxDate: true, metadata: true}
    })
    const values = await prisma.chunkValue.findMany({
      where: {chunkId: fixture.chunk.id},
      orderBy: [{metricTypeCode: 'asc'}, {periodStart: 'asc'}],
      select: {metricTypeCode: true, periodStart: true, value: true}
    })
    const source = await prisma.source.findUnique({
      where: {id: fixture.source.id},
      select: {metadata: true}
    })

    t.is(chunk.instructionStatus, 'VALIDATED')
    t.is(chunk.minDate.toISOString(), fixture.may.start.toISOString())
    t.is(chunk.maxDate.toISOString(), fixture.july.end.toISOString())
    t.deepEqual(
      values.map(value => ({
        metricTypeCode: value.metricTypeCode,
        periodStart: value.periodStart.toISOString(),
        value: value.value.toNumber()
      })),
      [
        {
          metricTypeCode: METRIC_TYPE_CODES.VOLUME_PRELEVE,
          periodStart: fixture.july.start.toISOString(),
          value: 300
        },
        {
          metricTypeCode: METRIC_TYPE_CODES.VOLUME_REJETE,
          periodStart: fixture.may.start.toISOString(),
          value: 50
        }
      ]
    )
    t.is(chunk.metadata.totalWaterVolumeWithdrawn, 300)
    t.is(chunk.metadata.totalWaterVolumeDischarged, 50)
    t.is(source.metadata.totalWaterVolumeWithdrawn, 300)
    t.is(source.metadata.totalWaterVolumeDischarged, 50)
  } finally {
    await cleanupFixture(fixture)
  }
})
