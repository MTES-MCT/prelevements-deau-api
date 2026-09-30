import test from 'ava'
import {buildAuthorizedCumulativeAggregationQuery, getAuthorizedCumulativeAggregation} from '../series-aggregation.js'

const collectorId = '11111111-1111-4111-8111-111111111111'
const pointId = '22222222-2222-4222-8222-222222222222'
const options = {pointIds: [pointId], collecteurId: collectorId, user: {role: 'ADMIN'},
  metricTypeCode: 'volume', aggregationFrequency: '1 week', startDate: '2026-01-01', endDate: '2026-01-31'}

test('les bornes constantes filtrent les valeurs sans remplacer les limites exactes Paris ou UTC', t => {
  const query = buildAuthorizedCumulativeAggregationQuery(options)
  const sql = query.sql
  const selectedStart = sql.indexOf('selected_values AS MATERIALIZED')
  const selectedSql = sql.slice(selectedStart, sql.indexOf('selected_chunks AS'))
  t.regex(selectedSql, /cv\."periodEnd" > LEAST/)
  t.regex(selectedSql, /cv\."periodStart" < GREATEST/)
  t.regex(selectedSql, /cv\."periodEnd" > \(CASE WHEN c\."calculationStrategy" = 'METER'/)
  t.regex(selectedSql, /cv\."periodStart" < \(CASE WHEN c\."calculationStrategy" = 'METER'/)
  t.regex(selectedSql, /cv\."metricTypeCode" IN/)
  t.regex(selectedSql, /c\."pointPrelevementId" IN/)
  t.regex(selectedSql, /aggregation_collector_chunks_0/)
  for (const value of [collectorId, pointId, options.startDate, options.endDate]) {
    t.false(sql.includes(value))
    t.true(query.values.includes(value))
  }
})

test('le périmètre vide retourne zéro sans requête et reste fermé dans la requête SQL', async t => {
  const actual = await getAuthorizedCumulativeAggregation({...options, pointIds: [], client: {
    async $queryRaw() {t.fail('Une requête ne doit pas être lancée sans périmètre')}
  }})
  t.deepEqual(actual, {seriesCount: 0, exactVolumesEstimated: false, values: []})
  t.regex(buildAuthorizedCumulativeAggregationQuery({...options, pointIds: []}).sql, /AND false/)
})

test('les séries administrateur sans filtre collecteur gardent un SQL valide sans CTE de délégation', t => {
  const sql = buildAuthorizedCumulativeAggregationQuery({...options, collecteurId: undefined}).sql
  t.notRegex(sql, /aggregation_collector_chunks_/)
  t.regex(sql, /selected_values AS MATERIALIZED/)
  t.regex(sql, /"valueKind" = 'COMPUTED'/)
  t.regex(sql, /"chunkId", "metricTypeCode", unit, frequency FROM selected_values GROUP BY 1, 2, 3, 4/)
})
