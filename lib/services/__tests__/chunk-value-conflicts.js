import test from 'ava'

import {METRIC_TYPE_CODES} from '../../constants/metric-type-codes.js'
import {
  applyConflictPolicyForIncomingChunkValues,
  findConflictingChunkValuesForIncomingChunkValues,
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
    sourceUpdates: [],
    replacementAudits: []
  }

  const client = {
    state,
    async $transaction(callback) {
      return callback(client)
    },
    async $queryRaw() {
      const totalWaterVolume = state.values
        .filter(value => value.metricTypeCode === METRIC_TYPE_CODES.VOLUME)
        .reduce((sum, value) => sum + value.value, 0)
      const isRejection = chunk.flowType === 'REJET'
      const totalWaterVolumeWithdrawn = isRejection ? 0 : totalWaterVolume
      const totalWaterVolumeDischarged = isRejection ? totalWaterVolume : 0

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
    chunkValueReplacement: {
      async createMany({data}) {
        state.replacementAudits.push(...data)
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
  t.is(normalizeConflictPolicy('skip_conflicting_values'), 'SKIP_CONFLICTING_VALUES')
  t.is(normalizeConflictPolicy('replace_existing_except_willie'), 'REPLACE_EXISTING_EXCEPT_WILLIE')
  t.is(normalizeConflictPolicy('unknown'), null)
  t.is(normalizeConflictPolicy(null), null)
})

test('findConflictingChunkValuesForIncomingChunkValues restreint les conflits au préleveur métier', async t => {
  const may = monthPeriod(2025, 4)
  const preleveurUserId = '2c869f1f-1ed0-4627-9078-93b2c92a8264'
  const capturedValues = []
  const client = {
    async $queryRaw(strings, ...values) {
      capturedValues.push(...values)
      return []
    }
  }

  await findConflictingChunkValuesForIncomingChunkValues({
    client,
    pointPrelevementId: '3cf2ac7f-ad23-4d7d-a818-7da51ed4b708',
    preleveurUserId,
    valueRows: [{
      metricTypeCode: METRIC_TYPE_CODES.VOLUME,
      periodStart: may.start,
      periodEnd: may.end
    }]
  })

  t.true(capturedValues.includes(preleveurUserId))
})

test('REPLACE_EXISTING fonctionne avec un client transactionnel existant', async t => {
  const may = monthPeriod(2025, 4)
  const chunk = {
    id: 'chunk-1',
    pointPrelevementId: 'point-1',
    metadata: {
      totalWaterVolumeWithdrawn: 120
    }
  }
  const source = {
    id: 'source-1',
    metadata: {
      totalWaterVolumeWithdrawn: 120
    }
  }
  const client = createFakeClient({
    chunk,
    source,
    values: [
      {
        id: 'old-may-withdrawal',
        chunkId: chunk.id,
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        periodStart: may.start,
        periodEnd: may.end,
        value: 120
      }
    ]
  })
  client.$transaction = undefined

  await applyConflictPolicyForIncomingChunkValues({
    pointPrelevementId: 'point-1',
    requestedPolicy: 'REPLACE_EXISTING',
    replaceComment: 'AUTO_REPLACED_BY_TEST',
    replacementSourceId: 'incoming-source',
    client,
    findConflictingChunkValues: async () => [
      {
        chunkValueId: 'old-may-withdrawal',
        chunkId: chunk.id,
        sourceId: source.id,
        pointPrelevementId: 'point-1',
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        unit: 'm3',
        frequency: '1 month',
        periodStart: may.start,
        periodEnd: may.end,
        valueKind: 'DECLARED',
        value: 120
      }
    ],
    valueRows: [
      {
        id: 'new-may-withdrawal',
        chunkId: 'incoming-chunk',
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        periodStart: may.start,
        periodEnd: may.end
      }
    ]
  })

  t.deepEqual(client.state.values, [])
  t.is(client.state.replacementAudits[0].replacementChunkValueId, 'new-may-withdrawal')
})

test('REPLACE_EXISTING conserve un audit des valeurs remplacées', async t => {
  const may = monthPeriod(2025, 4)
  const chunk = {
    id: 'chunk-1',
    pointPrelevementId: 'point-1',
    metadata: {
      totalWaterVolumeWithdrawn: 120
    }
  }
  const source = {
    id: 'source-1',
    metadata: {
      totalWaterVolumeWithdrawn: 120
    }
  }
  const client = createFakeClient({
    chunk,
    source,
    values: [
      {
        id: 'old-may-withdrawal',
        chunkId: chunk.id,
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        periodStart: may.start,
        periodEnd: may.end,
        value: 120
      }
    ]
  })

  await applyConflictPolicyForIncomingChunkValues({
    pointPrelevementId: 'point-1',
    requestedPolicy: 'REPLACE_EXISTING',
    replaceComment: 'AUTO_REPLACED_BY_TEST',
    replacementSourceId: 'incoming-source',
    replacementMetadata: {
      declarationType: 'GIDAF'
    },
    client,
    findConflictingChunkValues: async () => [
      {
        chunkValueId: 'old-may-withdrawal',
        chunkId: chunk.id,
        sourceId: source.id,
        pointPrelevementId: 'point-1',
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        unit: 'm3',
        frequency: '1 month',
        periodStart: may.start,
        periodEnd: may.end,
        valueKind: 'DECLARED',
        value: 120
      }
    ],
    valueRows: [
      {
        id: 'new-may-withdrawal',
        chunkId: 'incoming-chunk',
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        periodStart: may.start,
        periodEnd: may.end
      }
    ]
  })

  t.deepEqual(client.state.replacementAudits, [
    {
      replacedChunkValueId: 'old-may-withdrawal',
      replacedChunkId: chunk.id,
      replacedSourceId: source.id,
      replacementChunkValueId: 'new-may-withdrawal',
      replacementChunkId: 'incoming-chunk',
      replacementSourceId: 'incoming-source',
      pointPrelevementId: 'point-1',
      metricTypeCode: METRIC_TYPE_CODES.VOLUME,
      unit: 'm3',
      frequency: '1 month',
      periodStart: may.start,
      periodEnd: may.end,
      valueKind: 'DECLARED',
      value: 120,
      conflictPolicy: 'REPLACE_EXISTING',
      replaceComment: 'AUTO_REPLACED_BY_TEST',
      metadata: {
        declarationType: 'GIDAF'
      }
    }
  ])
  t.deepEqual(client.state.values, [])
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
      totalWaterVolumeDischarged: 0
    }
  }
  const source = {
    id: 'source-1',
    metadata: {
      totalWaterVolumeWithdrawn: 600,
      totalWaterVolumeDischarged: 0
    }
  }
  const client = createFakeClient({
    chunk,
    source,
    values: [
      {
        id: 'may-withdrawal',
        chunkId: chunk.id,
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        periodStart: may.start,
        periodEnd: may.end,
        value: 100
      },
      {
        id: 'june-withdrawal',
        chunkId: chunk.id,
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        periodStart: june.start,
        periodEnd: june.end,
        value: 200
      },
      {
        id: 'july-withdrawal',
        chunkId: chunk.id,
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        periodStart: july.start,
        periodEnd: july.end,
        value: 300
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
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        periodStart: may.start,
        periodEnd: may.end
      },
      {
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        periodStart: june.start,
        periodEnd: june.end
      }
    ]
  })

  t.deepEqual(result, {
    shouldSkip: false,
    replacedChunkIds: [chunk.id],
    valueRowsToInsert: [
      {
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        periodStart: may.start,
        periodEnd: may.end
      },
      {
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        periodStart: june.start,
        periodEnd: june.end
      }
    ],
    skippedValueRows: [],
    skippedValueCount: 0
  })
  t.deepEqual(client.state.values.map(value => value.id), ['july-withdrawal'])
  t.is(chunk.minDate.toISOString(), july.start.toISOString())
  t.is(chunk.maxDate.toISOString(), july.end.toISOString())
  t.is(chunk.metadata.totalWaterVolumeWithdrawn, 300)
  t.is(chunk.metadata.totalWaterVolumeDischarged, 0)
  t.is(source.metadata.totalWaterVolumeWithdrawn, 300)
  t.is(source.metadata.totalWaterVolumeDischarged, 0)
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
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        periodStart: new Date('2025-05-01T00:00:00.000Z'),
        periodEnd: new Date('2025-06-01T00:00:00.000Z')
      }
    ]
  })

  t.deepEqual(result, {
    shouldSkip: true,
    replacedChunkIds: [],
    valueRowsToInsert: [],
    skippedValueRows: [
      {
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        periodStart: new Date('2025-05-01T00:00:00.000Z'),
        periodEnd: new Date('2025-06-01T00:00:00.000Z')
      }
    ],
    skippedValueCount: 1
  })
  t.deepEqual(client.state.chunkUpdates, [])
  t.deepEqual(client.state.sourceUpdates, [])
})

test('SKIP_CONFLICTING_VALUES ignore seulement les valeurs qui recoupent l’existant', async t => {
  const may = monthPeriod(2025, 4)
  const june = monthPeriod(2025, 5)
  const client = createFakeClient({
    chunk: {id: 'chunk-1', pointPrelevementId: 'point-1', metadata: {}},
    source: {id: 'source-1', metadata: {}},
    values: []
  })
  const incomingMay = {
    metricTypeCode: METRIC_TYPE_CODES.VOLUME,
    periodStart: may.start,
    periodEnd: may.end,
    value: 120
  }
  const incomingJune = {
    metricTypeCode: METRIC_TYPE_CODES.VOLUME,
    periodStart: june.start,
    periodEnd: june.end,
    value: 130
  }

  const result = await applyConflictPolicyForIncomingChunkValues({
    pointPrelevementId: 'point-1',
    requestedPolicy: 'SKIP_CONFLICTING_VALUES',
    replaceComment: 'ignored',
    client,
    findConflictingChunkValues: async () => [
      {
        chunkValueId: 'existing-may',
        chunkId: 'chunk-1',
        sourceId: 'source-1',
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        periodStart: may.start,
        periodEnd: may.end
      }
    ],
    valueRows: [incomingMay, incomingJune]
  })

  t.deepEqual(result, {
    shouldSkip: false,
    replacedChunkIds: [],
    valueRowsToInsert: [incomingJune],
    skippedValueRows: [incomingMay],
    skippedValueCount: 1
  })
  t.deepEqual(client.state.values, [])
  t.deepEqual(client.state.chunkUpdates, [])
  t.deepEqual(client.state.sourceUpdates, [])
})

test('SKIP_CONFLICTING_VALUES saute tout le chunk si toutes les valeurs recoupent l’existant', async t => {
  const may = monthPeriod(2025, 4)
  const client = createFakeClient({
    chunk: {id: 'chunk-1', pointPrelevementId: 'point-1', metadata: {}},
    source: {id: 'source-1', metadata: {}},
    values: []
  })
  const incomingMay = {
    metricTypeCode: METRIC_TYPE_CODES.VOLUME,
    periodStart: may.start,
    periodEnd: may.end,
    value: 120
  }

  const result = await applyConflictPolicyForIncomingChunkValues({
    pointPrelevementId: 'point-1',
    requestedPolicy: 'SKIP_CONFLICTING_VALUES',
    replaceComment: 'ignored',
    client,
    findConflictingChunkValues: async () => [
      {
        chunkValueId: 'existing-may',
        chunkId: 'chunk-1',
        sourceId: 'source-1',
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        periodStart: may.start,
        periodEnd: may.end
      }
    ],
    valueRows: [incomingMay]
  })

  t.deepEqual(result, {
    shouldSkip: true,
    replacedChunkIds: [],
    valueRowsToInsert: [],
    skippedValueRows: [incomingMay],
    skippedValueCount: 1
  })
})

test('REPLACE_EXISTING_EXCEPT_WILLIE remplace les conflits hors Willie et ignore les valeurs Willie', async t => {
  const may = monthPeriod(2025, 4)
  const june = monthPeriod(2025, 5)
  const chunk = {
    id: 'chunk-1',
    pointPrelevementId: 'point-1',
    metadata: {
      totalWaterVolumeWithdrawn: 300
    }
  }
  const source = {
    id: 'source-1',
    metadata: {
      totalWaterVolumeWithdrawn: 300
    }
  }
  const client = createFakeClient({
    chunk,
    source,
    values: [
      {
        id: 'willie-may-withdrawal',
        chunkId: chunk.id,
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        periodStart: may.start,
        periodEnd: may.end,
        value: 100
      },
      {
        id: 'aquasys-june-withdrawal',
        chunkId: chunk.id,
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        periodStart: june.start,
        periodEnd: june.end,
        value: 200
      }
    ]
  })
  const incomingMay = {
    id: 'incoming-may',
    chunkId: 'incoming-chunk',
    metricTypeCode: METRIC_TYPE_CODES.VOLUME,
    periodStart: may.start,
    periodEnd: may.end,
    value: 120
  }
  const incomingJune = {
    id: 'incoming-june',
    chunkId: 'incoming-chunk',
    metricTypeCode: METRIC_TYPE_CODES.VOLUME,
    periodStart: june.start,
    periodEnd: june.end,
    value: 220
  }

  const result = await applyConflictPolicyForIncomingChunkValues({
    pointPrelevementId: 'point-1',
    requestedPolicy: 'REPLACE_EXISTING_EXCEPT_WILLIE',
    replaceComment: 'AUTO_REPLACED_BY_AQUASYS',
    replacementSourceId: 'incoming-source',
    client,
    findConflictingChunkValues: async () => [
      {
        chunkValueId: 'willie-may-withdrawal',
        chunkId: chunk.id,
        sourceId: source.id,
        pointPrelevementId: 'point-1',
        sourceConnector: 'willie',
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        unit: 'm3',
        frequency: '1 month',
        periodStart: may.start,
        periodEnd: may.end,
        valueKind: 'DECLARED',
        value: 100
      },
      {
        chunkValueId: 'aquasys-june-withdrawal',
        chunkId: chunk.id,
        sourceId: source.id,
        pointPrelevementId: 'point-1',
        sourceConnector: 'aquasys',
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        unit: 'm3',
        frequency: '1 month',
        periodStart: june.start,
        periodEnd: june.end,
        valueKind: 'DECLARED',
        value: 200
      }
    ],
    valueRows: [incomingMay, incomingJune]
  })

  t.deepEqual(result, {
    shouldSkip: false,
    replacedChunkIds: [chunk.id],
    valueRowsToInsert: [incomingJune],
    skippedValueRows: [incomingMay],
    skippedValueCount: 1
  })
  t.deepEqual(client.state.values.map(value => value.id), ['willie-may-withdrawal'])
  t.is(client.state.replacementAudits.length, 1)
  t.is(client.state.replacementAudits[0].replacedChunkValueId, 'aquasys-june-withdrawal')
  t.is(client.state.replacementAudits[0].replacementChunkValueId, 'incoming-june')
  t.is(client.state.replacementAudits[0].conflictPolicy, 'REPLACE_EXISTING_EXCEPT_WILLIE')
})

test('REPLACE_EXISTING_EXCEPT_WILLIE saute le chunk si toutes les valeurs recoupent Willie', async t => {
  const may = monthPeriod(2025, 4)
  const client = createFakeClient({
    chunk: {id: 'chunk-1', pointPrelevementId: 'point-1', metadata: {}},
    source: {id: 'source-1', metadata: {}},
    values: []
  })
  const incomingMay = {
    metricTypeCode: METRIC_TYPE_CODES.VOLUME,
    periodStart: may.start,
    periodEnd: may.end,
    value: 120
  }

  const result = await applyConflictPolicyForIncomingChunkValues({
    pointPrelevementId: 'point-1',
    requestedPolicy: 'REPLACE_EXISTING_EXCEPT_WILLIE',
    replaceComment: 'ignored',
    client,
    findConflictingChunkValues: async () => [
      {
        chunkValueId: 'existing-may',
        chunkId: 'chunk-1',
        sourceId: 'source-1',
        sourceMetadata: {
          connector: 'willie'
        },
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        periodStart: may.start,
        periodEnd: may.end
      }
    ],
    valueRows: [incomingMay]
  })

  t.deepEqual(result, {
    shouldSkip: true,
    replacedChunkIds: [],
    valueRowsToInsert: [],
    skippedValueRows: [incomingMay],
    skippedValueCount: 1
  })
  t.deepEqual(client.state.values, [])
  t.deepEqual(client.state.chunkUpdates, [])
  t.deepEqual(client.state.sourceUpdates, [])
})

test('REPLACE_EXISTING peut différer les recalculs des sources remplacées', async t => {
  const may = monthPeriod(2025, 4)
  const chunk = {
    id: 'chunk-1',
    pointPrelevementId: 'point-1',
    metadata: {
      totalWaterVolumeWithdrawn: 120
    }
  }
  const source = {
    id: 'source-1',
    metadata: {
      totalWaterVolumeWithdrawn: 120
    }
  }
  const deferredReplacedSourceIds = new Set()
  const client = createFakeClient({
    chunk,
    source,
    values: [
      {
        id: 'old-may-withdrawal',
        chunkId: chunk.id,
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        periodStart: may.start,
        periodEnd: may.end,
        value: 120
      }
    ]
  })

  const result = await applyConflictPolicyForIncomingChunkValues({
    pointPrelevementId: 'point-1',
    requestedPolicy: 'REPLACE_EXISTING',
    replaceComment: 'AUTO_REPLACED_BY_TEST',
    replacementSourceId: 'incoming-source',
    deferredReplacedSourceIds,
    client,
    findConflictingChunkValues: async () => [
      {
        chunkValueId: 'old-may-withdrawal',
        chunkId: chunk.id,
        sourceId: source.id,
        pointPrelevementId: 'point-1',
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        unit: 'm3',
        frequency: '1 month',
        periodStart: may.start,
        periodEnd: may.end,
        valueKind: 'DECLARED',
        value: 120
      }
    ],
    valueRows: [
      {
        id: 'new-may-withdrawal',
        chunkId: 'incoming-chunk',
        metricTypeCode: METRIC_TYPE_CODES.VOLUME,
        periodStart: may.start,
        periodEnd: may.end
      }
    ]
  })

  t.deepEqual(result.replacedChunkIds, [chunk.id])
  t.deepEqual([...deferredReplacedSourceIds], [source.id])
  t.deepEqual(client.state.values, [])
  t.is(client.state.chunkUpdates.length, 1)
  t.deepEqual(client.state.sourceUpdates, [])
  t.is(source.metadata.totalWaterVolumeWithdrawn, 120)
})
