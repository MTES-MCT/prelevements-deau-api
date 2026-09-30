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

test('les preuves collecteur restent liées aux contributions de tout le chunk, sans restriction temporelle', t => {
  const scope = buildAggregationChunkScope({user: collector, pointIds: [pointId]})
  t.regex(scope.ctes.sql, /JOIN "ChunkValue" scoped_value ON scoped_value\.id = contribution\."chunkValueId"/)
  t.notRegex(scope.ctes.sql, /candidate_values|periodStart|periodEnd|metricTypeCode/)
  t.notRegex(scope.ctes.sql, /c\."exploitationId"/)
  t.regex(scope.where.sql, /aggregation_collector_chunks_0/)
})

test('le périmètre préleveur exige son identité sans préparer de délégation collecteur', t => {
  const scope = buildAggregationChunkScope({user: {id: collectorId, role: 'DECLARANT'}, pointIds: [pointId]})
  t.is(scope.ctes.sql, '')
  t.regex(scope.where.sql, /source\.status = 'COMPLETED'/)
  t.regex(scope.where.sql, /c\."preleveurUserId" =/)
  t.true(scope.where.values.includes(pointId))
  t.true(scope.where.values.includes(collectorId))
})

test('les filtres exploitation et préleveur restent intersectés avec les preuves de délégation', t => {
  const scope = buildAggregationChunkScope({user: collector, collecteurId: otherCollectorId, pointIds: [pointId],
    preleveurId: collectorId, exploitationId: pointId, pointFlowType: 'PRELEVEMENT',
    includeLegacyPreleveurFallback: true})
  t.is((scope.ctes.sql.match(/AS MATERIALIZED/g) ?? []).length, 2)
  t.regex(scope.where.sql, /c\."exploitationId" =/)
  t.regex(scope.where.sql, /c\."preleveurUserId" IS NULL/)
  t.regex(scope.where.sql, /aggregation_collector_chunks_0/)
  t.regex(scope.where.sql, /aggregation_collector_chunks_1/)
})

test('le filtre de flux conserve la priorité du chunk et le repli uniquement si son flux est nul', t => {
  const scope = buildAggregationChunkScope({pointIds: [pointId], pointFlowType: 'PRELEVEMENT'})
  t.regex(scope.where.sql, /c\."flowType" = \?::"PointFlowType"/)
  t.regex(scope.where.sql, /OR \(c\."flowType" IS NULL AND point\."flowType" = \?::"PointFlowType"\)/)
  t.notRegex(scope.where.sql, /COALESCE/)
  t.is(scope.where.values.filter(value => value === 'PRELEVEMENT').length, 2)
})
