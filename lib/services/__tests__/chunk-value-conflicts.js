import test from 'ava'

import {METRIC_TYPE_CODES} from '../../constants/metric-type-codes.js'
import {
  applyConflictPolicyForIncomingChunkValues,
  normalizeConflictPolicy
} from '../chunk-value-conflicts.js'

function monthPeriod(year, monthIndex) {
  return {
    start: new Date(Date.UTC(year, monthIndex, 1)),
    end: new Date(Date.UTC(year, monthIndex + 1, 1))
  }
}

function decimal(value) {
  return {
    toNumber() {
      return value
    }
  }
}

function createFakeClient({chunk, source, values}) {
  const state = {
    values: [...values],
    chunkUpdates: [],
    sourceUpdates: []
  }

  const client = {
    state,
    async $transaction(callback) {
      return callback(client)
    },
    async $queryRaw() {
      const totalWaterVolumeWithdrawn = state.values
        .filter(value => value.metricTypeCode === METRIC_TYPE_CODES.VOLUME_PRELEVE)
        .reduce((sum, value) => sum + value.value, 0)
      const totalWaterVolumeDischarged = state.values
        .filter(value => value.metricTypeCode === METRIC_TYPE_CODES.VOLUME_REJETE)
        .reduce((sum, value) => sum + value.value, 0)

      return [{
        sourceId: source.id,
        totalWaterVolumeWithdrawn,
        totalWaterVolumeDischarged
      }]
    },
    chunkValue: {
      async deleteMany({where}) {
        state.values = state.values.filter(value => !where.id.in.includes(value.id))
      },
      async groupBy({by, where}) {
        const scopedValues = state.values.filter(value => where.chunkId.in.includes(value.chunkId))

        if (by.includes('metricTypeCode')) {
          const rowsByKey = new Map()
          for (const value of scopedValues.filter(value => where.metricTypeCode.in.includes(value.metricTypeCode))) {
            const key = `${value.chunkId}:${value.metricTypeCode}`
            const current = rowsByKey.get(key) ?? {
              chunkId: value.chunkId,
              metricTypeCode: value.metricTypeCode,
              _sum: {value: decimal(0)}
            }

            current._sum.value = decimal(current._sum.value.toNumber() + value.value)
            rowsByKey.set(key, current)
          }

          return [...rowsByKey.values()]
        }

        return where.chunkId.in.map(chunkId => {
          const chunkValues = scopedValues.filter(value => value.chunkId === chunkId)

          return {
            chunkId,
            _count: {_all: chunkValues.length},
            _min: {
              periodStart: new Date(Math.min(...chunkValues.map(value => value.periodStart.getTime())))
            },
            _max: {
              periodEnd: new Date(Math.max(...chunkValues.map(value => value.periodEnd.getTime())))
            }
          }
        })
      }
    },
    chunk: {
      async findMany({select}) {
        if (select?.sourceId) {
          return [{sourceId: source.id, pointPrelevementId: chunk.pointPrelevementId}]
        }

        return [{id: chunk.id, metadata: chunk.metadata}]
      },
      async update(update) {
        state.chunkUpdates.push(update)
        Object.assign(chunk, update.data)
        return chunk
      }
    },
    source: {
      async findMany() {
        return [{id: source.id, metadata: source.metadata}]
      },
      async update(update) {
        state.sourceUpdates.push(update)
        Object.assign(source, update.data)
        return source
      }
    }
  }

  return client
}

test('normalizeConflictPolicy normalise les politiques supportées', t => {
  t.is(normalizeConflictPolicy(' replace_existing '), 'REPLACE_EXISTING')
  t.is(normalizeConflictPolicy('skip_new_chunk'), 'SKIP_NEW_CHUNK')
  t.is(normalizeConflictPolicy('unknown'), null)
  t.is(normalizeConflictPolicy(null), null)
})

test('REPLACE_EXISTING remplace seulement les valeurs en conflit et conserve les mois suivants', async t => {
  const may = monthPeriod(2025, 4)
  const june = monthPeriod(2025, 5)
  const july = monthPeriod(2025, 6)
  const chunk = {
    id: 'chunk-1',
    pointPrelevementId: 'point-1',
    metadata: {
      totalWaterVolumeWithdrawn: 600,
      totalWaterVolumeDischarged: 50
    }
  }
  const source = {
    id: 'source-1',
    metadata: {
      totalWaterVolumeWithdrawn: 600,
      totalWaterVolumeDischarged: 50
    }
  }
  const client = createFakeClient({
    chunk,
    source,
    values: [
      {
        id: 'may-withdrawal',
        chunkId: chunk.id,
        metricTypeCode: METRIC_TYPE_CODES.VOLUME_PRELEVE,
        periodStart: may.start,
        periodEnd: may.end,
        value: 100
      },
      {
        id: 'june-withdrawal',
        chunkId: chunk.id,
        metricTypeCode: METRIC_TYPE_CODES.VOLUME_PRELEVE,
        periodStart: june.start,
        periodEnd: june.end,
        value: 200
      },
      {
        id: 'july-withdrawal',
        chunkId: chunk.id,
        metricTypeCode: METRIC_TYPE_CODES.VOLUME_PRELEVE,
        periodStart: july.start,
        periodEnd: july.end,
        value: 300
      },
      {
        id: 'may-discharge',
        chunkId: chunk.id,
        metricTypeCode: METRIC_TYPE_CODES.VOLUME_REJETE,
        periodStart: may.start,
        periodEnd: may.end,
        value: 50
      }
    ]
  })

  const result = await applyConflictPolicyForIncomingChunkValues({
    pointPrelevementId: 'point-1',
    requestedPolicy: 'REPLACE_EXISTING',
    replaceComment: 'AUTO_REPLACED_BY_TEST',
    client,
    findConflictingChunkValues: async () => [
      {chunkValueId: 'may-withdrawal', chunkId: chunk.id, sourceId: source.id},
      {chunkValueId: 'june-withdrawal', chunkId: chunk.id, sourceId: source.id}
    ],
    valueRows: [
      {
        metricTypeCode: METRIC_TYPE_CODES.VOLUME_PRELEVE,
        periodStart: may.start,
        periodEnd: may.end
      },
      {
        metricTypeCode: METRIC_TYPE_CODES.VOLUME_PRELEVE,
        periodStart: june.start,
        periodEnd: june.end
      }
    ]
  })

  t.deepEqual(result, {shouldSkip: false, replacedChunkIds: [chunk.id]})
  t.deepEqual(client.state.values.map(value => value.id), ['july-withdrawal', 'may-discharge'])
  t.is(chunk.minDate.toISOString(), may.start.toISOString())
  t.is(chunk.maxDate.toISOString(), july.end.toISOString())
  t.is(chunk.metadata.totalWaterVolumeWithdrawn, 300)
  t.is(chunk.metadata.totalWaterVolumeDischarged, 50)
  t.is(source.metadata.totalWaterVolumeWithdrawn, 300)
  t.is(source.metadata.totalWaterVolumeDischarged, 50)
})

test('SKIP_NEW_CHUNK demande de sauter le nouveau chunk sans supprimer les conflits', async t => {
  const client = createFakeClient({
    chunk: {id: 'chunk-1', pointPrelevementId: 'point-1', metadata: {}},
    source: {id: 'source-1', metadata: {}},
    values: []
  })

  const result = await applyConflictPolicyForIncomingChunkValues({
    pointPrelevementId: 'point-1',
    requestedPolicy: 'SKIP_NEW_CHUNK',
    replaceComment: 'ignored',
    client,
    findConflictingChunkValues: async () => [
      {chunkValueId: 'value-1', chunkId: 'chunk-1', sourceId: 'source-1'}
    ],
    valueRows: [
      {
        metricTypeCode: METRIC_TYPE_CODES.VOLUME_PRELEVE,
        periodStart: new Date('2025-05-01T00:00:00.000Z'),
        periodEnd: new Date('2025-06-01T00:00:00.000Z')
      }
    ]
  })

  t.deepEqual(result, {shouldSkip: true, replacedChunkIds: []})
  t.deepEqual(client.state.chunkUpdates, [])
  t.deepEqual(client.state.sourceUpdates, [])
})
