import test from 'ava'
import {buildAggregationChunkScope} from '../aggregation-scope.js'

const collectorId = '11111111-1111-4111-8111-111111111111'
const otherCollectorId = '22222222-2222-4222-8222-222222222222'
const pointId = '33333333-3333-4333-8333-333333333333'
const collector = {id: collectorId, role: 'DECLARANT', declarant: {declarantRole: 'COLLECTEUR'}}

test('le périmètre SQL prépare une seule fois les contributions du même collecteur', t => {
  const scope = buildAggregationChunkScope({user: collector, collecteurId: collectorId, pointIds: [pointId]})
  t.is((scope.ctes.sql.match(/AS MATERIALIZED/g) ?? []).length, 1)
  t.deepEqual(scope.ctes.values, [collectorId])
  t.regex(scope.ctes.sql, /JOIN "MeterVolumeContribution"/)
  t.regex(scope.ctes.sql, /SELECT DISTINCT scoped_value\."chunkId"/)
  t.notRegex(scope.where.sql, /"collecteurUserId"/)
  t.is((scope.where.sql.match(/SELECT "chunkId" FROM aggregation_collector_chunks_0/g) ?? []).length, 2)
})

test('le collecteur connecté et le filtre demandé conservent deux périmètres indépendants', t => {
  const scope = buildAggregationChunkScope({user: collector, collecteurId: otherCollectorId, pointIds: [pointId]})
  t.is((scope.ctes.sql.match(/AS MATERIALIZED/g) ?? []).length, 2)
  t.deepEqual(scope.ctes.values, [otherCollectorId, collectorId])
  t.regex(scope.where.sql, /SELECT "chunkId" FROM aggregation_collector_chunks_0/)
  t.regex(scope.where.sql, /SELECT "chunkId" FROM aggregation_collector_chunks_1/)
  t.false(scope.ctes.sql.includes(collectorId))
  t.false(scope.ctes.sql.includes(otherCollectorId))
})

test('le repli préleveur historique ne modifie pas le contrat des options', t => {
  const optionsScope = buildAggregationChunkScope({user: {role: 'ADMIN'}, preleveurId: collectorId, pointIds: [pointId]})
  const seriesScope = buildAggregationChunkScope({user: {role: 'ADMIN'}, preleveurId: collectorId,
    pointIds: [pointId], includeLegacyPreleveurFallback: true})
  t.is(optionsScope.ctes.sql, '')
  t.notRegex(optionsScope.where.sql, /FROM "DeclarantPointPrelevement"/)
  t.regex(seriesScope.where.sql, /FROM "DeclarantPointPrelevement"/)
  t.regex(seriesScope.where.sql, /c\."preleveurUserId" IS NULL/)
  t.regex(seriesScope.where.sql, /c\."calculationStrategy" <> 'METER'/)
})
