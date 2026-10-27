import test from 'ava'
import {getNativeAggregationPolicy, resolveNativeAggregationFrequency} from '../series-aggregation.js'

const pointId = '11111111-1111-4111-8111-111111111111'
const options = {pointIds: [pointId], user: {role: 'ADMIN'}, metricTypeCode: 'volume', aggregationFrequency: '1 day'}
const group = (frequency, containedFrequencies) => ({frequency, containedFrequencies, unit: 'm³', valueType: 'cumulative', partial: false})

test('un cumul irrégulier exige une maille contenant chaque période entière', t => {
  const irregular = group('irregular', ['1 month', '1 quarter', '1 year'])
  t.is(resolveNativeAggregationFrequency('1 day', [irregular], true), '1 month')
  t.is(resolveNativeAggregationFrequency('1 week', [irregular], true), '1 month')
  t.is(resolveNativeAggregationFrequency('1 year', [irregular], true), '1 year')
  t.is(resolveNativeAggregationFrequency('1 day', [irregular,
    group('irregular', ['1 quarter', '1 year'])], true), '1 quarter')
})

test('la résolution respecte aussi les limites calendaires des fréquences régulières', t => {
  const weekAcrossMonths = group('1 week', ['1 week', '1 quarter', '1 year'])
  t.is(resolveNativeAggregationFrequency('1 day', [weekAcrossMonths], true), '1 week')
  t.is(resolveNativeAggregationFrequency('1 month', [weekAcrossMonths], true), '1 quarter')
  t.is(resolveNativeAggregationFrequency('1 day', [group('1 month', ['1 month', '1 quarter', '1 year'])], true), '1 month')
})

test('un cumul de 01 h à 08 h ne devient pas une mesure de quinze minutes ou une heure', t => {
  const sevenHours = group('irregular', ['1 day', '1 week', '1 month', '1 quarter', '1 year'])
  for (const requested of ['15 minutes', '1 hour', '6 hours']) {
    t.is(resolveNativeAggregationFrequency(requested, [sevenHours], true), '1 day')
    t.is(resolveNativeAggregationFrequency(requested, [sevenHours], false), requested)
  }
})

test('un cumul sans maille commune est refusé sans inventer de répartition', t => {
  for (const groups of [[group('irregular', [])], [group('irregular', undefined)],
    [group('irregular', ['1 week']), group('irregular', ['1 month', '1 quarter', '1 year'])]]) {
    const error = t.throws(() => resolveNativeAggregationFrequency('1 day', groups, true))
    t.is(error.status, 400)
    t.regex(error.message, /valeurs originales.*exportez-les/)
  }
  t.is(resolveNativeAggregationFrequency('1 day', [group('instant', [])], false), '1 day')
})

test('la politique utilise les périodes complètes en heure Réunion et leurs fins exclusives', async t => {
  const queries = []
  const client = {async $queryRaw(query) {
    queries.push(query)
    return queries.length === 1 ? [group('irregular', ['1 month', '1 quarter', '1 year'])] : [{unit: 'm³', native: true}]
  }}
  const policy = await getNativeAggregationPolicy({...options, client})
  t.like(policy, {frequency: '1 month', unit: 'm³', nativeOnly: true, timezone: 'Indian/Reunion'})
  t.regex(queries[0].sql, /bool_and\(date_trunc/)
  t.regex(queries[0].sql, /GREATEST\("periodStart", "periodEnd" - interval '1 millisecond'\)/)
  t.regex(queries[0].sql, /AT TIME ZONE 'Indian\/Reunion'/)
  t.true(queries[0].values.includes(pointId))
  t.false(queries[0].sql.includes(pointId))
})

test('un filtre qui coupe le cumul reste refusé avant toute agrégation', async t => {
  let calls = 0
  const client = {async $queryRaw() {
    calls++
    return [{...group('irregular', ['1 month']), partial: true}]
  }}
  const error = await t.throwsAsync(getNativeAggregationPolicy({...options, client, startDate: '2026-01-02'}))
  t.is(error.status, 400)
  t.regex(error.message, /coupe une mesure/)
  t.is(calls, 1)
})
