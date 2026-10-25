import test from 'ava'
import {nativeConflicts, nativeDimension, nativePeriodsConflict, periodsOverlap} from '../native-conflicts.js'

const period = (start, end = start) => ({periodStart: start, periodEnd: end})

test('les dimensions vides et profondeurs numériques gardent une identité commune', t => {
  t.is(nativeDimension({detailPointSuivi: '', profondeur: ''}), nativeDimension({}))
  t.is(nativeDimension({detailPointSuivi: ' sortie ', profondeur: 2}), nativeDimension({detailPointSuivi: 'sortie', profondeur: '002.000'}))
  t.not(nativeDimension({profondeur: '2.000000000000001'}), nativeDimension({profondeur: '2.000000000000002'}))
  t.is(nativeDimension({profondeur: '-0.0'}), nativeDimension({profondeur: 0}))
})

test('les conflits respectent les bornes semi-ouvertes et les instants', t => {
  const examples = [
    [[period(0, 100)], [period(100, 200)], false],
    [[period(0, 100)], [period(100)], false],
    [[period(100)], [period(0, 100)], false],
    [[period(0, 100)], [period(0)], true],
    [[period(100)], [period(100)], true],
    [[period(0, 100), period(200, 300)], [period(100, 200)], false],
    [[period(0, 100), period(200, 300)], [period(100, 201)], true],
    [[period(10), period(20)], [period(0, 30)], true],
    [[period(10, 50), period(20, 30)], [period(31)], true],
    [[period(10, 50)], [], false]
  ]
  for (const [left, right, expected] of examples) {
    t.is(nativePeriodsConflict(left, right), expected)
    t.is(nativePeriodsConflict(right, left), expected)
  }
})

test('le balayage trié équivaut à la comparaison exhaustive sur des intervalles mélangés', t => {
  let seed = 123456
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % 50 }
  for (let sample = 0; sample < 500; sample++) {
    const build = () => Array.from({length: random() % 8}, () => {const start = random(); return period(start, start + random() % 6)})
    const left = build(), right = build()
    const exhaustive = left.some(a => right.some(b => periodsOverlap(a, b)))
    t.is(nativePeriodsConflict(left, right), exhaustive)
  }
})

test('100 000 observations intercalées sont vérifiées sans comparaison quadratique', t => {
  const left = Array.from({length: 100000}, (_, index) => period(index * 2))
  const right = Array.from({length: 100000}, (_, index) => period(index * 2 + 1))
  t.false(nativePeriodsConflict(left, right))
  right.push(period(199998))
  t.true(nativePeriodsConflict(left, right))
})

test('la recherche compare aussi les acceptées du dossier en traitement et les alias legacy', async t => {
  let query
  const client = {chunkValue: {async findMany(options) {query = options; return [
    {...period(0, 10), chunk: {metadata: {profondeur: '3'}}},
    {...period(20, 30), chunk: {metadata: {profondeur: '2'}}}
  ]}}}
  const common = {pointPrelevementId: 'point', preleveurUserId: 'owner', sourceId: 'processing-source', excludeChunkId: 'self',
    metadata: {profondeur: 2}, values: [{...period(25), metricTypeCode: 'index'}]}
  t.true(await nativeConflicts(client, common))
  t.deepEqual(query.where.chunk.source.OR, [{status: 'COMPLETED'}, {id: 'processing-source'}])
  t.true(query.where.metricTypeCode.in.includes('relevé d\'index'))
  t.deepEqual(query.select, {periodStart: true, periodEnd: true, chunk: {select: {metadata: true}}})
  t.false(await nativeConflicts(client, {...common, values: [{...period(5), metricTypeCode: 'index'}]}))
})

test('minimum, maximum et moyenne coexistent ; nature absente ou inconnue reste un conflit conservateur', async t => {
  let candidateMetadata = {valueType: 'minimum'}
  const client = {chunkValue: {async findMany() { return [{...period(0, 10), chunk: {metadata: candidateMetadata}}] }}}
  const options = {pointPrelevementId: 'point', preleveurUserId: 'owner', metadata: {valueType: 'maximum'}, values: [{...period(5), metricTypeCode: 'température'}]}
  t.false(await nativeConflicts(client, options))
  t.false(await nativeConflicts(client, {...options, metadata: {valueType: 'average'}}))
  t.false(await nativeConflicts(client, {...options, metadata: {valueType: 'median'}}))
  t.true(await nativeConflicts(client, {...options, metadata: {valueType: 'minimum'}}))
  candidateMetadata = {}
  t.true(await nativeConflicts(client, options))
  candidateMetadata = {valueType: 'unknown'}
  t.true(await nativeConflicts(client, options))
})
