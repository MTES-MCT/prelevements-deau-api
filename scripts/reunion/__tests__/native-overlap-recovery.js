import test from 'ava'
import {partitionNativeOverlapValues} from '../recover-native-overlaps.js'
import {nativeRecoveryId, retainNativeRecovery} from '../../../lib/declaration-importer/native-overlap-recovery.js'

const chunk = {id: 'parent', pointPrelevementId: 'point', preleveurUserId: 'owner', metadata: {valueType: 'cumulative'}}
const value = (id, start, end, amount = '10') => ({id, metricTypeCode: 'volume', unit: 'm³',
  periodStart: `2026-01-${String(start).padStart(2, '0')}T00:00:00.000Z`,
  periodEnd: `2026-01-${String(end).padStart(2, '0')}T00:00:00.000Z`, value: amount})
const candidate = (entry, parent = chunk) => ({...entry, chunk: parent})

test('reprise : conserve les intervalles disjoints, écarte les chevauchements sans les découper', t => {
  const result = partitionNativeOverlapValues(chunk, [value('a', 1, 2), value('b', 2, 3), value('c', 3, 7)], [candidate(value('published', 4, 5))])
  t.deepEqual(result.accepted.map(row => row.id), ['a', 'b'])
  t.like(result.excluded[0], {valueId: 'c', reason: 'OVERLAPPING_VALUE_OR_PERIOD'})
  t.is(result.excluded.length, 1)
})

test('reprise : mêmes bornes, unité et décimales exactes obligatoires pour un doublon', t => {
  const values = [value('exact', 1, 2, '12345678901234567890.123'), value('different', 2, 3, '12345678901234567890.123'), value('unit', 3, 4)]
  const result = partitionNativeOverlapValues(chunk, values, [
    candidate(value('p1', 1, 2, '12345678901234567890.1230')),
    candidate(value('p2', 2, 3, '12345678901234567890.124')),
    candidate({...value('p3', 3, 4), unit: 'L'})
  ])
  t.deepEqual(result.accepted, [])
  t.deepEqual(result.excluded.map(row => row.reason), ['IDENTICAL_ALREADY_PUBLISHED', 'OVERLAPPING_VALUE_OR_PERIOD', 'OVERLAPPING_VALUE_OR_PERIOD'])
})

test('reprise : instants inclus au début mais exclus à la fin d’une période', t => {
  const result = partitionNativeOverlapValues(chunk, [value('beginning', 1, 1), value('end', 2, 2)], [candidate(value('period', 1, 2))])
  t.deepEqual(result.accepted.map(row => row.id), ['end'])
  t.is(result.excluded[0].valueId, 'beginning')
})

test('reprise : respecte le PP, le préleveur, la dimension et la nature de la mesure', t => {
  const original = value('original', 1, 2)
  for (const parent of [{...chunk, pointPrelevementId: 'other'}, {...chunk, preleveurUserId: 'other'},
    {...chunk, metadata: {...chunk.metadata, profondeur: '10'}}, {...chunk, metadata: {valueType: 'minimum'}}]) {
    t.deepEqual(partitionNativeOverlapValues(chunk, [original], [candidate(value('other', 1, 2), parent)]).accepted, [original])
  }
  t.is(partitionNativeOverlapValues(chunk, [original], [candidate(value('unknown', 1, 2), {...chunk, metadata: {}})]).excluded.length, 1)
})

test('reprise : deux valeurs contradictoires dans la cohorte sont toutes deux écartées', t => {
  const a = value('a', 1, 2, '0'), b = value('b', 1, 2, '550')
  const candidates = [candidate(a), candidate(b)]
  for (const original of [a, b]) {
    const result = partitionNativeOverlapValues(chunk, [original], candidates, {allowIdentical: true})
    t.deepEqual(result.accepted, [])
    t.is(result.excluded[0].reason, 'OVERLAPPING_VALUE_OR_PERIOD')
  }
  t.deepEqual(partitionNativeOverlapValues(chunk, [a], [candidate(a), candidate({...b, value: '0.00'})], {allowIdentical: true}).accepted, [a])
})

test('reprise : enfant conservé uniquement tant que sa révision parente reste présente et identique', t => {
  const parent = {id: 'parent', seriesKey: 'series', contentHash: 'original'}
  const recovery = {metadata: {nativeOverlapRecovery: {version: 1, parentChunkId: parent.id, parentSeriesKey: parent.seriesKey, parentContentHash: parent.contentHash}}}
  const options = {chunks: [parent], prepared: [], keys: new Set(['series'])}
  t.true(retainNativeRecovery(recovery, options))
  t.false(retainNativeRecovery(recovery, {...options, keys: new Set()}))
  t.false(retainNativeRecovery(recovery, {...options, chunks: []}))
  t.false(retainNativeRecovery(recovery, {...options, prepared: [{series: {seriesKey: 'series'}, contentHash: 'new'}]}))
  t.false(retainNativeRecovery({...recovery, metadata: {...recovery.metadata, superseded: true}}, options))
  t.is(nativeRecoveryId('recovery', 'source'), nativeRecoveryId('recovery', 'source'))
  t.not(nativeRecoveryId('recovery', 'source'), nativeRecoveryId('recovery', 'other'))
})
